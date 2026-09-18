import "server-only";
import { createClient } from "@/server/supabase/server";
import { requireUser } from "@/server/auth/session";
import { clientAddress, enforceRateLimit, normalizeIdentifier } from "@/server/security/rate-limit";
import { reportEvent } from "@/lib/observability";

/**
 * Proof that the person at the keyboard is still the account holder.
 *
 * A session cookie proves someone logged in at some point. For an action that
 * cannot be undone — deleting an account, changing the password — that is not
 * the same question as "is this the account holder right now". An unlocked
 * laptop, a borrowed phone or a stolen session all satisfy the first and none
 * satisfy the second.
 *
 * HOW IT WORKS, AND WHY NOT `updateUser`
 *
 * The password is verified with `signInWithPassword` against the CURRENT
 * session's own email, read server-side from the session rather than accepted
 * from the request. That matters: taking an email from the form would let a
 * caller prove they know somebody else's password and have that count as
 * re-authentication for their own destructive action.
 *
 * WHAT IT IS NOT
 *
 * Not an authorization check. Callers still run `requireUser` /
 * `requireOrgMembership` and their own role checks; this only answers "is the
 * account holder present". Both are required — proving who you are does not
 * decide what you may do.
 *
 * OAuth users have no password. `signInWithPassword` fails for them, so they
 * cannot currently re-authenticate; that is a real gap, reported rather than
 * papered over with a bypass that would defeat the control entirely.
 */

export interface ReauthResult {
  ok: boolean;
  /** Safe to display. Never distinguishes "wrong password" from "no password
   *  set" in a way that reveals how the account signs in. */
  error?: string;
}

const GENERIC_FAILURE = "That password isn't correct. Please try again.";

export async function reauthenticate(password: string): Promise<ReauthResult> {
  const user = await requireUser();

  if (typeof password !== "string" || password.length === 0) {
    return { ok: false, error: GENERIC_FAILURE };
  }

  // An email-less account (phone-only, or an unusual provider) cannot be
  // re-authenticated this way. Refuse rather than skip the check.
  if (!user.email) {
    reportEvent("reauthentication_unavailable", { scope: "auth", userId: user.id, detail: { reason: "no_email_identity" } }, "warning");
    return { ok: false, error: "This account can't be verified with a password. Contact support to continue." };
  }

  // Bounded on the same two dimensions as login, and for the same reason:
  // this endpoint checks a password, so it is a password oracle unless it is
  // rate limited. Consumed BEFORE the check and identically whether or not the
  // password is right, so timing and throttling reveal nothing.
  const limited = await enforceRateLimit("login", {
    loginPerIp: await clientAddress(),
    loginPerIdentifier: normalizeIdentifier(user.email),
  });
  if (!limited.allowed) return { ok: false, error: limited.message };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: user.email, password });

  if (error) {
    reportEvent("reauthentication_failed", { scope: "auth", userId: user.id }, "warning");
    return { ok: false, error: GENERIC_FAILURE };
  }

  reportEvent("reauthentication_succeeded", { scope: "auth", userId: user.id });
  return { ok: true };
}
