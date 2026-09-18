import { createHash, createPublicKey, timingSafeEqual, verify as verifySignature, type KeyObject } from "node:crypto";
import { z } from "zod";

/**
 * PLAID WEBHOOK VERIFICATION.
 *
 * A webhook endpoint is an unauthenticated URL on the public internet. What
 * makes a delivery trustworthy is the `plaid-verification` header: a JWT,
 * signed by Plaid with ES256, whose payload contains a SHA-256 of the request
 * body. Verifying it proves both that Plaid sent the request and that this is
 * the exact body Plaid signed.
 *
 * Every step below exists because skipping it is a known attack:
 *
 *   ALGORITHM. The header's `alg` must be exactly ES256. Accepting whatever
 *   the token asks for is algorithm confusion — `alg: none` forges anything,
 *   and `alg: HS256` lets a public key be used as an HMAC secret.
 *
 *   KEY. The `kid` names the signing key, fetched from Plaid (server-to-server,
 *   authenticated with this deployment's own credentials) and cached. An
 *   expired key is refused. The key is never taken from the token itself.
 *
 *   BODY. `request_body_sha256` is compared against the SHA-256 of the RAW
 *   body, byte for byte, with a constant-time comparison. Parsing the body
 *   before this point would mean acting on unverified input, so the caller
 *   hands over the raw string and receives the parsed body only on success.
 *
 *   FRESHNESS. `iat` must be recent (five minutes, Plaid's own guidance), which
 *   is what stops an old captured delivery being replayed later. Idempotency
 *   (Task 11's `bank_webhook_events`) handles honest redelivery separately.
 *
 * Failures return a short reason for the log. They never include the body, the
 * header or any claim.
 */

export const WEBHOOK_MAX_AGE_SECONDS = 300;
/** Small allowance for clock skew between Plaid and this server. */
const FUTURE_SKEW_SECONDS = 60;
const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_CACHE_LIMIT = 8;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;

const jwtHeaderSchema = z.object({ alg: z.string(), kid: z.string(), typ: z.string().optional() }).loose();
const jwtPayloadSchema = z.object({ iat: z.number().int(), request_body_sha256: z.string().regex(/^[0-9a-f]{64}$/) }).loose();

/** Plaid's JWK, as returned by /webhook_verification_key/get. */
export const plaidWebhookKeySchema = z
  .object({
    key: z
      .object({
        kid: z.string(),
        kty: z.literal("EC"),
        crv: z.literal("P-256"),
        x: z.string().min(1),
        y: z.string().min(1),
        alg: z.literal("ES256"),
        use: z.string().nullish(),
        expired_at: z.number().nullish(),
      })
      .loose(),
  })
  .loose();

export type VerificationResult = { ok: true; body: unknown; issuedAt: Date } | { ok: false; reason: string };

export interface PlaidWebhookVerifier {
  verify(input: { rawBody: string; headers: Readonly<Record<string, string>>; receivedAt: Date }): Promise<VerificationResult>;
}

function decodeSegment(segment: string): unknown {
  const json = Buffer.from(segment, "base64url").toString("utf8");
  return JSON.parse(json) as unknown;
}

export function createPlaidWebhookVerifier(deps: { fetchKey: (keyId: string) => Promise<unknown>; maxAgeSeconds?: number }): PlaidWebhookVerifier {
  const maxAge = deps.maxAgeSeconds ?? WEBHOOK_MAX_AGE_SECONDS;
  const cache = new Map<string, { key: KeyObject; fetchedAt: number }>();

  async function keyFor(keyId: string): Promise<KeyObject | null> {
    const cached = cache.get(keyId);
    if (cached && Date.now() - cached.fetchedAt < KEY_CACHE_TTL_MS) return cached.key;

    const parsed = plaidWebhookKeySchema.safeParse(await deps.fetchKey(keyId));
    if (!parsed.success) return null;
    const jwk = parsed.data.key;
    // A retired signing key must not verify anything new.
    if (jwk.expired_at !== null && jwk.expired_at !== undefined) return null;
    if (jwk.kid !== keyId) return null;

    let key: KeyObject;
    try {
      key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
    } catch {
      return null;
    }
    if (cache.size >= KEY_CACHE_LIMIT) cache.clear();
    cache.set(keyId, { key, fetchedAt: Date.now() });
    return key;
  }

  return {
    async verify({ rawBody, headers, receivedAt }) {
      const token = headers["plaid-verification"];
      if (!token) return { ok: false, reason: "missing_verification_header" };

      const parts = token.split(".");
      if (parts.length !== 3) return { ok: false, reason: "malformed_token" };

      let header: z.infer<typeof jwtHeaderSchema>;
      let payload: z.infer<typeof jwtPayloadSchema>;
      try {
        const headerParsed = jwtHeaderSchema.safeParse(decodeSegment(parts[0]));
        const payloadParsed = jwtPayloadSchema.safeParse(decodeSegment(parts[1]));
        if (!headerParsed.success || !payloadParsed.success) return { ok: false, reason: "malformed_claims" };
        header = headerParsed.data;
        payload = payloadParsed.data;
      } catch {
        return { ok: false, reason: "malformed_claims" };
      }

      if (header.alg !== "ES256") return { ok: false, reason: "unexpected_algorithm" };
      if (!KEY_ID.test(header.kid)) return { ok: false, reason: "malformed_key_id" };

      const key = await keyFor(header.kid);
      if (!key) return { ok: false, reason: "unknown_or_expired_key" };

      let signatureValid = false;
      try {
        signatureValid = verifySignature(
          "sha256",
          Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
          { key, dsaEncoding: "ieee-p1363" },
          Buffer.from(parts[2], "base64url"),
        );
      } catch {
        signatureValid = false;
      }
      if (!signatureValid) return { ok: false, reason: "bad_signature" };

      const ageSeconds = receivedAt.getTime() / 1000 - payload.iat;
      if (ageSeconds > maxAge) return { ok: false, reason: "stale_token" };
      if (ageSeconds < -FUTURE_SKEW_SECONDS) return { ok: false, reason: "token_from_the_future" };

      const actual = createHash("sha256").update(rawBody, "utf8").digest();
      const claimed = Buffer.from(payload.request_body_sha256, "hex");
      if (actual.length !== claimed.length || !timingSafeEqual(actual, claimed)) return { ok: false, reason: "body_hash_mismatch" };

      // Only now is the body parsed at all.
      try {
        return { ok: true, body: JSON.parse(rawBody) as unknown, issuedAt: new Date(payload.iat * 1000) };
      } catch {
        return { ok: false, reason: "body_not_json" };
      }
    },
  };
}
