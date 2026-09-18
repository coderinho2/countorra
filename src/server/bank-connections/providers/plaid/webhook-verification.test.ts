import { createHash, createHmac, generateKeyPairSync, sign as signData, type KeyObject } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createPlaidWebhookVerifier } from "./webhook-verification";

/**
 * Webhook verification, against real ES256 keys.
 *
 * This is the whole security of a public, unauthenticated endpoint, so each
 * case here is an attack: a forged signature, a swapped algorithm, a replayed
 * delivery, a body changed after signing, a key that is not Plaid's.
 */

const BODY = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1" });
const NOW = new Date("2026-09-16T12:00:00Z");

const plaid = generateKeyPairSync("ec", { namedCurve: "P-256" });
const attacker = generateKeyPairSync("ec", { namedCurve: "P-256" });

function jwkFor(key: KeyObject, kid: string, expiredAt: number | null = null) {
  const jwk = key.export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string };
  return { key: { kid, kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, alg: "ES256", use: "sig", created_at: 1_700_000_000, expired_at: expiredAt } };
}

const b64 = (value: object | string) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function token(options: { body?: string; iat?: number; kid?: string; alg?: string; key?: KeyObject; signature?: string; parts?: number } = {}): string {
  const header = { alg: options.alg ?? "ES256", kid: options.kid ?? "key-1", typ: "JWT" };
  const payload = {
    iat: options.iat ?? Math.floor(NOW.getTime() / 1000),
    request_body_sha256: createHash("sha256")
      .update(options.body ?? BODY, "utf8")
      .digest("hex"),
  };
  const signingInput = `${b64(header)}.${b64(payload)}`;
  if (options.parts === 2) return signingInput;
  const signature =
    options.signature ??
    (options.alg === "none"
      ? ""
      : options.alg === "HS256"
        ? createHmac("sha256", "secret").update(signingInput).digest("base64url")
        : signData("sha256", Buffer.from(signingInput), { key: options.key ?? plaid.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"));
  return `${signingInput}.${signature}`;
}

let fetched: string[] = [];
let keyResponse: (keyId: string) => unknown;

const verifier = () =>
  createPlaidWebhookVerifier({
    fetchKey: async (keyId) => {
      fetched.push(keyId);
      return keyResponse(keyId);
    },
  });

const headersFor = (value: string) => ({ "plaid-verification": value, "content-type": "application/json" });

beforeEach(() => {
  fetched = [];
  keyResponse = (keyId) => jwkFor(plaid.publicKey, keyId);
});

describe("a genuine delivery", () => {
  it("is accepted, and only then is the body parsed", async () => {
    const result = await verifier().verify({ rawBody: BODY, headers: headersFor(token()), receivedAt: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toEqual({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1" });
      expect(result.issuedAt.toISOString()).toBe(NOW.toISOString());
    }
  });

  it("fetches the signing key once and reuses it", async () => {
    const instance = verifier();
    for (let i = 0; i < 3; i++) expect((await instance.verify({ rawBody: BODY, headers: headersFor(token()), receivedAt: NOW })).ok).toBe(true);
    expect(fetched).toEqual(["key-1"]);
  });

  it("refuses a body that is not JSON even when the signature is right", async () => {
    const result = await verifier().verify({ rawBody: "not json", headers: headersFor(token({ body: "not json" })), receivedAt: NOW });
    expect(result).toEqual({ ok: false, reason: "body_not_json" });
  });
});

describe("forgery", () => {
  it("refuses a signature from any other key", async () => {
    const result = await verifier().verify({ rawBody: BODY, headers: headersFor(token({ key: attacker.privateKey })), receivedAt: NOW });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses algorithm confusion — no unsigned tokens, no HMAC with the public key", async () => {
    expect(await verifier().verify({ rawBody: BODY, headers: headersFor(token({ alg: "none" })), receivedAt: NOW })).toEqual({ ok: false, reason: "unexpected_algorithm" });
    expect(await verifier().verify({ rawBody: BODY, headers: headersFor(token({ alg: "HS256" })), receivedAt: NOW })).toEqual({ ok: false, reason: "unexpected_algorithm" });
    expect(await verifier().verify({ rawBody: BODY, headers: headersFor(token({ alg: "ES512" })), receivedAt: NOW })).toEqual({ ok: false, reason: "unexpected_algorithm" });
    // Not even fetched: the algorithm is rejected before anything else.
    expect(fetched).toEqual([]);
  });

  it("refuses a body swapped after signing", async () => {
    const tampered = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-belonging-to-someone-else" });
    expect(await verifier().verify({ rawBody: tampered, headers: headersFor(token()), receivedAt: NOW })).toEqual({ ok: false, reason: "body_hash_mismatch" });
  });

  it("refuses a missing, truncated or garbled token", async () => {
    expect(await verifier().verify({ rawBody: BODY, headers: {}, receivedAt: NOW })).toEqual({ ok: false, reason: "missing_verification_header" });
    expect(await verifier().verify({ rawBody: BODY, headers: headersFor(token({ parts: 2 })), receivedAt: NOW })).toEqual({ ok: false, reason: "malformed_token" });
    expect(await verifier().verify({ rawBody: BODY, headers: headersFor("a.b.c"), receivedAt: NOW })).toEqual({ ok: false, reason: "malformed_claims" });
    expect(await verifier().verify({ rawBody: BODY, headers: headersFor(token({ signature: "not-base64url!!" })), receivedAt: NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a key id that is not a key id, without asking Plaid about it", async () => {
    for (const kid of ["../../secrets", "key 1", "k".repeat(65), ""]) {
      const result = await verifier().verify({ rawBody: BODY, headers: headersFor(token({ kid })), receivedAt: NOW });
      expect(result, kid).toEqual({ ok: false, reason: "malformed_key_id" });
    }
    expect(fetched).toEqual([]);
  });

  it("refuses a key Plaid does not vouch for, or has retired", async () => {
    keyResponse = () => ({ error_code: "INVALID_FIELD" });
    expect(await verifier().verify({ rawBody: BODY, headers: headersFor(token()), receivedAt: NOW })).toEqual({ ok: false, reason: "unknown_or_expired_key" });

    keyResponse = (keyId) => jwkFor(plaid.publicKey, keyId, 1_800_000_000);
    expect(await verifier().verify({ rawBody: BODY, headers: headersFor(token()), receivedAt: NOW })).toEqual({ ok: false, reason: "unknown_or_expired_key" });

    // A key that answers for a different id than the one asked for.
    keyResponse = () => jwkFor(plaid.publicKey, "another-key");
    expect(await verifier().verify({ rawBody: BODY, headers: headersFor(token()), receivedAt: NOW })).toEqual({ ok: false, reason: "unknown_or_expired_key" });

    keyResponse = () => ({ key: { kid: "key-1", kty: "RSA", n: "x", e: "AQAB", alg: "RS256", expired_at: null } });
    expect(await verifier().verify({ rawBody: BODY, headers: headersFor(token()), receivedAt: NOW })).toEqual({ ok: false, reason: "unknown_or_expired_key" });
  });
});

describe("replay", () => {
  it("refuses a delivery older than five minutes", async () => {
    const old = Math.floor(NOW.getTime() / 1000) - 301;
    expect(await verifier().verify({ rawBody: BODY, headers: headersFor(token({ iat: old })), receivedAt: NOW })).toEqual({ ok: false, reason: "stale_token" });
    // Just inside the window still passes.
    const fresh = Math.floor(NOW.getTime() / 1000) - 299;
    expect((await verifier().verify({ rawBody: BODY, headers: headersFor(token({ iat: fresh })), receivedAt: NOW })).ok).toBe(true);
  });

  it("refuses a delivery dated in the future beyond clock skew", async () => {
    const ahead = Math.floor(NOW.getTime() / 1000) + 120;
    expect(await verifier().verify({ rawBody: BODY, headers: headersFor(token({ iat: ahead })), receivedAt: NOW })).toEqual({ ok: false, reason: "token_from_the_future" });
  });

  it("never reveals the body, the token or a claim in a failure reason", async () => {
    const result = await verifier().verify({ rawBody: BODY, headers: headersFor(token({ key: attacker.privateKey })), receivedAt: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/^[a-z_]+$/);
      expect(result.reason).not.toContain("item-1");
    }
  });
});
