import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/server/supabase/admin";
import { publicEnv, serverEnv } from "@/lib/env";
import { normalizeEmailAddress } from "@/domain/email/message";

/**
 * Unsubscribe links that carry their own proof.
 *
 * The token is an HMAC of the normalized address, so nothing has to be
 * stored to issue one and nothing expires. That matters for email
 * specifically: a link sits in an inbox for months, and an unsubscribe that
 * has quietly stopped working is a compliance problem rather than a broken
 * feature.
 *
 * The alternative — a random token row per message — would mean the
 * unsubscribe link in a six-month-old digest points at a deleted row.
 *
 * WHY THE ADDRESS IS IN THE URL AND THE TOKEN IS NOT OPTIONAL
 *
 * Without the HMAC, `?address=` alone would let anyone unsubscribe anyone
 * else by guessing addresses — trivially, and in bulk. The token is what
 * makes the link unforgeable, and it is compared in constant time so the
 * endpoint is not a byte-at-a-time oracle.
 */

/** Same derivation as the rate limiter: a dedicated secret when configured,
 *  otherwise derived from one that always exists. */
function pepper(): string {
  const env = serverEnv();
  return env.RATE_LIMIT_HASH_SECRET ?? `derived:${env.SUPABASE_SERVICE_ROLE_KEY}`;
}

export function unsubscribeToken(address: string): string {
  return createHmac("sha256", pepper()).update(`unsubscribe ${normalizeEmailAddress(address)}`).digest("hex");
}

export function verifyUnsubscribeToken(address: string, token: string): boolean {
  const expected = unsubscribeToken(address);
  if (typeof token !== "string" || token.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(token, "utf8"));
  } catch {
    return false;
  }
}

/** The link placed in every `notification` email. Built from the canonical
 *  app URL, never from a request header. */
export function unsubscribeUrl(address: string): string {
  const normalized = normalizeEmailAddress(address);
  const params = new URLSearchParams({ address: normalized, token: unsubscribeToken(normalized) });
  return `${publicEnv.NEXT_PUBLIC_APP_URL}/unsubscribe?${params.toString()}`;
}

/**
 * Adds an address to the global suppression list.
 *
 * Idempotent: unsubscribing twice is the same as once, which matters because
 * RFC 8058 clients may POST the link more than once.
 */
export async function suppressAddress(address: string, reason: string): Promise<void> {
  const admin = createAdminClient();
  await admin.from("email_suppressions").upsert({ address: normalizeEmailAddress(address), reason }, { onConflict: "address" });
}

export async function isSuppressed(address: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin.from("email_suppressions").select("address").eq("address", normalizeEmailAddress(address)).maybeSingle();
  return Boolean(data);
}
