import type { JwtPayload } from "@supabase/supabase-js";

/**
 * Whether a VERIFIED session was created by a password-recovery link, recently.
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * `/reset-password` used to render its form for anyone, and `resetPassword`
 * called `updateUser` with whatever session the request carried. The recovery
 * link's code was never exchanged at all, so the person who clicked it had no
 * session and every attempt failed — while an ordinary signed-in session (an
 * unlocked laptop, a borrowed phone) could open `/reset-password` directly and
 * replace the password without knowing the current one.
 *
 * THE RULE
 *
 * Setting a password without the current one is allowed only for a session
 * that Supabase itself records as authenticated BY RECOVERY: the `amr` claim of
 * the access token carries `{ method: "recovery", timestamp }` when the session
 * came from exchanging a recovery code. The claim is read from a token whose
 * signature has been verified (`getClaims`, see src/server/auth/recovery.ts),
 * so it cannot be supplied by the client. A password sign-in carries
 * `password`, a confirmation link `email/signup` — neither qualifies.
 *
 * The recovery must also be recent. `amr` survives token refreshes, so without
 * a window a recovery session would keep this power for its whole lifetime.
 * Fifteen minutes is ample to type a new password; after that the person asks
 * for a new link, which costs them one email.
 *
 * The RFC-8176 string form of `amr` carries no timestamp, so it never
 * qualifies: without a time there is no way to apply the window, and this
 * fails closed.
 */

export const RECOVERY_WINDOW_SECONDS = 15 * 60;

/** Tolerated difference between this server's clock and the Auth server's. */
const CLOCK_SKEW_SECONDS = 60;

/** The time (unix seconds) of the most recent recovery authentication in
 *  `amr`, or null when the session was not authenticated by recovery. */
export function recoveryAuthenticatedAt(amr: JwtPayload["amr"]): number | null {
  if (!Array.isArray(amr)) return null;

  let latest: number | null = null;
  for (const entry of amr) {
    if (typeof entry !== "object" || entry === null) continue;
    if (entry.method !== "recovery" || typeof entry.timestamp !== "number") continue;
    if (latest === null || entry.timestamp > latest) latest = entry.timestamp;
  }
  return latest;
}

export function isRecentRecovery(amr: JwtPayload["amr"], nowSeconds: number): boolean {
  const authenticatedAt = recoveryAuthenticatedAt(amr);
  if (authenticatedAt === null) return false;
  // A timestamp from the future is not a clock we can reason about.
  if (authenticatedAt > nowSeconds + CLOCK_SKEW_SECONDS) return false;
  return nowSeconds - authenticatedAt <= RECOVERY_WINDOW_SECONDS;
}
