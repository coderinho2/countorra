"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { publicEnv } from "@/lib/env";
import {
  requestPasswordResetSchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
} from "@/validation/schemas/auth";
import { clientAddress, enforceRateLimit, normalizeIdentifier } from "@/server/security/rate-limit";
import { getRecoverySession } from "@/server/auth/recovery";
import { reportEvent } from "@/lib/observability";

export interface AuthActionResult {
  error?: string;
  success?: boolean;
}

/**
 * Abuse controls for the three unauthenticated entry points.
 *
 * Each consumes two independent buckets — one keyed on the connecting
 * address, one on a hash of the submitted identifier — so neither IP rotation
 * nor identifier rotation alone gets an attacker past both. See
 * src/domain/security/rate-limit-policy.ts for the numbers and why.
 *
 * The counter is consumed BEFORE the credential is checked, and it is
 * consumed identically whether or not the account exists. That ordering is
 * what keeps the limiter from becoming the account-existence oracle that
 * `requestPasswordReset`'s uniform response and `signIn`'s generic error
 * already work to avoid: an attacker who cannot tell a real address from a
 * fake one by the response cannot tell them apart by how quickly they get
 * throttled either.
 */
async function limitAuthAttempt(
  group: "login" | "signup" | "passwordReset",
  email: string,
): Promise<string | null> {
  const address = await clientAddress();
  const identifier = normalizeIdentifier(email);
  const byGroup = {
    login: { loginPerIp: address, loginPerIdentifier: identifier },
    signup: { signupPerIp: address, signupPerIdentifier: identifier },
    passwordReset: { passwordResetPerIp: address, passwordResetPerIdentifier: identifier },
  } as const;

  const decision = await enforceRateLimit(group, byGroup[group]);
  return decision.allowed ? null : decision.message;
}

export async function signUp(_prev: AuthActionResult, formData: FormData): Promise<AuthActionResult> {
  const parsed = signUpSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    fullName: formData.get("fullName"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const limited = await limitAuthAttempt("signup", parsed.data.email);
  if (limited) return { error: limited };

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: `${publicEnv.NEXT_PUBLIC_APP_URL}/auth/callback`,
    },
  });
  if (error) {
    // Never the provider's own message. With email confirmation disabled
    // Supabase answers "User already registered", which turns this form into
    // an account-existence oracle — the exact leak `requestPasswordReset`'s
    // uniform response and `signIn`'s generic error already work to avoid.
    // Rate limiting alone does not close it; one request is enough to learn
    // whether an address has an account.
    console.error("[auth] signUp failed:", error.message);
    return { error: "We couldn't create an account with those details. Please check them and try again." };
  }

  redirect("/verify-email");
}

export async function signIn(_prev: AuthActionResult, formData: FormData): Promise<AuthActionResult> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const limited = await limitAuthAttempt("login", parsed.data.email);
  if (limited) return { error: limited };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: "Incorrect email or password." };

  redirect("/app");
}

/**
 * NO OAUTH PROVIDER IS CONFIGURED.
 *
 * A "Continue with Google" button used to sit at the top of both auth pages,
 * calling Supabase's OAuth sign-in for the Google provider. The linked
 * project reports `external: { email: true }` and nothing else, so every
 * click produced a provider error and bounced back to `/login?oauthError=1`.
 * The most prominent control on the sign-in page could not sign anyone in.
 *
 * The entry point is removed rather than left in place, because an advertised
 * auth path that cannot work is worse than an absent one: users who believe
 * they have a Google account here have no password to fall back on. The
 * privacy policy's Google data-sharing claim went with it — a policy that
 * describes sharing that does not happen is a false statement about data
 * handling, not a harmless leftover.
 *
 * To re-introduce it: enable the provider on the Supabase project first,
 * then restore the action and the button. `/auth/callback` already exchanges
 * any `code` generically, so no new callback logic is needed.
 */

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function requestPasswordReset(_prev: AuthActionResult, formData: FormData): Promise<AuthActionResult> {
  const parsed = requestPasswordResetSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const limited = await limitAuthAttempt("passwordReset", parsed.data.email);
  if (limited) return { error: limited };

  const supabase = await createClient();
  // The link comes back through /auth/callback, which exchanges its PKCE code
  // on the server using the verifier cookie this call sets in THIS browser.
  // The verifier is stored as "<verifier>/recovery", and the exchange reports
  // that as `redirectType: "recovery"` — that, not the query string, is what
  // routes a successful exchange to /reset-password. `flow=recovery` is only a
  // hint for which help page a failed link lands on. See src/lib/auth-callback.ts.
  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${publicEnv.NEXT_PUBLIC_APP_URL}/auth/callback?flow=recovery`,
  });
  // Deliberately return the same success response regardless of whether the
  // email matched an account — surfacing "no account with that email" lets
  // an attacker enumerate registered users.
  return { success: true };
}

const RECOVERY_REQUIRED_MESSAGE = "Your reset link has expired. Request a new one to set your password.";

/**
 * Sets a new password — only for a recent recovery session.
 *
 * Proof of authorization is the verified session alone (getRecoverySession):
 * no user id, email or token is read from the form, so there is nothing a
 * caller can supply to choose whose password changes. An anonymous POST, an
 * ordinary password session and a recovery session older than the window are
 * all refused before Supabase is asked to change anything — an ordinary
 * signed-in user changes their password through the emailed link, which is
 * what "Change password" in Settings starts.
 *
 * On success every session for the account is revoked, including this one, and
 * the person signs in with the new password. A reset is what someone does when
 * they fear the account is compromised; leaving an attacker's stolen session
 * alive would defeat it. It also proves the new password works immediately.
 */
export async function resetPassword(_prev: AuthActionResult, formData: FormData): Promise<AuthActionResult> {
  const recovery = await getRecoverySession();
  if (!recovery) return { error: RECOVERY_REQUIRED_MESSAGE };

  const parsed = resetPasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  // Setting a new password is a credential change reachable from an emailed
  // link, so it gets its own budget on the same two dimensions login uses.
  // Without it, a recovery link that leaked is an unlimited attempt surface
  // for anything the endpoint reveals.
  const limited = await enforceRateLimit("passwordReset", {
    passwordResetPerIp: await clientAddress(),
    passwordResetPerIdentifier: normalizeIdentifier(recovery.email ?? recovery.userId),
  });
  if (limited && !limited.allowed) return { error: limited.message };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    // Never the provider's message. Supabase answers things like "New password
    // should be different from the old password", which confirms to whoever
    // holds the link what the current password is not — and other variants
    // disclose policy details that belong in the form's own validation.
    reportEvent("password_update_failed", { scope: "auth", userId: recovery.userId }, "warning");
    return { error: "That password couldn't be set. Choose a different one and try again." };
  }

  const { error: signOutError } = await supabase.auth.signOut({ scope: "global" });
  if (signOutError) {
    // The password has changed either way. Still end THIS session, so the
    // recovery session cannot be reused; other devices keep a session that
    // will not survive their next sign-in.
    reportEvent("password_reset_global_sign_out_failed", { scope: "auth", userId: recovery.userId }, "warning");
    await supabase.auth.signOut({ scope: "local" });
  }

  reportEvent("password_reset_completed", { scope: "auth", userId: recovery.userId });
  redirect("/login?passwordUpdated=1");
}
