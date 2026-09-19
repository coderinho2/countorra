import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import { BANK_LINK_STATE_TTL_SECONDS } from "@/domain/bank-connections/oauth";
import type { CredentialKeyset } from "./credential-crypto";

/**
 * THE SEALED LINK SESSION — what lets a bank's OAuth redirect come back to the
 * right organization without the URL, or the browser, saying which.
 *
 * When a Link session starts, the server has just verified who is asking and
 * for which organization. It seals exactly that — user, organization,
 * connection (for a repair), mode, the Link token, an expiry — and hands the
 * browser an opaque, HttpOnly cookie. When the customer returns from their
 * bank to the one fixed return path, the server opens the seal and knows
 * everything it needs; the browser never names an organization at all.
 *
 * WHY SEALED, NOT SIGNED
 *
 * AES-256-GCM gives both properties at once: a browser cannot read the
 * contents (the Link token stays out of script-reachable storage — the old
 * sessionStorage copy is gone), and cannot alter them (the tag fails, so an
 * edited organization id opens as nothing).
 *
 * THE KEY
 *
 * Derived with HKDF from the bank credential keyset, under its own label, so it
 * is never the key that encrypts access tokens and a seal can never be
 * confused with a credential. Every key in the keyset is tried by the id the
 * seal names, so rotating the keyset does not strand a customer mid-redirect
 * — and a retired key simply means "start again".
 *
 * WHAT IS NOT TRUSTED EVEN WHEN THE SEAL OPENS
 *
 * The seal proves what the server decided at the start. The callers still
 * require the current session to be the sealed user, re-check membership and
 * permission in the sealed organization, and re-apply entitlement and rate
 * limits — someone may have been removed from the workspace in between.
 */

const VERSION = "v1";
const INFO = "countorra:bank-link-state:v1";
const AAD = Buffer.from(INFO, "utf8");
const IV_BYTES = 12;
/** A clock may be a little ahead of the one that sealed. */
const ISSUED_SKEW_SECONDS = 60;

export const BANK_LINK_STATE_COOKIE = "countorra_bank_link";

export type BankLinkMode = "connect" | "reauthenticate";

export interface BankLinkState {
  userId: string;
  organizationId: string;
  /** Present exactly when repairing an existing connection. */
  connectionId: string | null;
  mode: BankLinkMode;
  /** The provider's short-lived Link token. Not a credential, but still never
   *  placed in the URL or in script-readable storage. */
  linkToken: string;
  issuedAt: number;
  expiresAt: number;
}

const payloadSchema = z
  .object({
    u: z.uuid(),
    o: z.uuid(),
    c: z.uuid().nullable(),
    m: z.enum(["connect", "reauthenticate"]),
    t: z.string().min(1).max(2048),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict()
  .refine((payload) => (payload.m === "reauthenticate") === (payload.c !== null), "a repair names its connection; a new link does not");

const b64url = (buffer: Buffer) => buffer.toString("base64url");
const unb64url = (value: string) => Buffer.from(value, "base64url");

function sealingKey(credentialKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", credentialKey, Buffer.alloc(0), INFO, 32));
}

export function sealBankLinkState(
  state: Omit<BankLinkState, "issuedAt" | "expiresAt">,
  keyset: CredentialKeyset,
  now: Date,
  ttlSeconds: number = BANK_LINK_STATE_TTL_SECONDS,
): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload = { u: state.userId, o: state.organizationId, c: state.connectionId, m: state.mode, t: state.linkToken, iat: issuedAt, exp: issuedAt + ttlSeconds };
  // Validate on the way in too: a malformed seal would only be discovered by
  // a customer standing at their bank's redirect.
  payloadSchema.parse(payload);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(keyset.active.key), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return [VERSION, keyset.active.id, b64url(iv), b64url(cipher.getAuthTag()), b64url(ciphertext)].join(".");
}

/**
 * Opens a seal, or returns null — for a wrong shape, an unknown key, a failed
 * tag, an invalid payload, an expiry in the past or an issue time in the
 * future. Never throws, and never says which: every failure means the same
 * thing to a caller ("start again").
 */
export function openBankLinkState(sealed: string | null | undefined, keyset: CredentialKeyset, now: Date): BankLinkState | null {
  if (!sealed || sealed.length > 4096) return null;
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) return null;
  const [, keyId, iv, tag, ciphertext] = parts;
  const key = keyset.byId.get(keyId);
  if (!key) return null;

  let payload: unknown;
  try {
    const decipher = createDecipheriv("aes-256-gcm", sealingKey(key.key), unb64url(iv));
    decipher.setAAD(AAD);
    decipher.setAuthTag(unb64url(tag));
    payload = JSON.parse(Buffer.concat([decipher.update(unb64url(ciphertext)), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }

  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (parsed.data.exp <= nowSeconds || parsed.data.iat > nowSeconds + ISSUED_SKEW_SECONDS) return null;

  return {
    userId: parsed.data.u,
    organizationId: parsed.data.o,
    connectionId: parsed.data.c,
    mode: parsed.data.m,
    linkToken: parsed.data.t,
    issuedAt: parsed.data.iat,
    expiresAt: parsed.data.exp,
  };
}

// ── The cookie ──────────────────────────────────────────────────────────
//
// HttpOnly: no script can read it. SameSite=Strict: it is only ever sent on a
// request this site starts — the bank's redirect lands on the page without
// it, and the page's own Server Action call carries it. Path=/app: only the
// signed-in application ever receives it. Secure in production.

const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/app",
  maxAge,
});

export async function writeBankLinkStateCookie(sealed: string): Promise<void> {
  (await cookies()).set(BANK_LINK_STATE_COOKIE, sealed, cookieOptions(BANK_LINK_STATE_TTL_SECONDS));
}

export async function readBankLinkStateCookie(): Promise<string | null> {
  return (await cookies()).get(BANK_LINK_STATE_COOKIE)?.value ?? null;
}

/** One use: cleared after a finished link, a finished repair, or any refusal
 *  that means the sealed session can no longer be completed. */
export async function clearBankLinkStateCookie(): Promise<void> {
  (await cookies()).set(BANK_LINK_STATE_COOKIE, "", cookieOptions(0));
}
