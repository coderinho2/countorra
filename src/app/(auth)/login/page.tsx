"use client";

import { Suspense, useActionState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "@/server/auth/actions";
import { ErrorState } from "@/components/ui/error-state";
import { SignInPage } from "@/components/ui/sign-in";

/**
 * The route owns the authentication; SignInPage owns the pixels.
 *
 * `useActionState(signIn, …)` still drives the existing Server Action — the
 * same credential check, the same rate limiter, the same session cookies and
 * the same redirect to /app. The redesign changed what this screen looks
 * like, not what signing in does.
 */
function LoginNotices() {
  const params = useSearchParams();
  const linkExpired = params.get("linkExpired");
  // Set by /auth/callback when a confirmation link was opened in a different
  // browser from the one used to sign up. PKCE correctly refuses to create a
  // session there, but the address itself was confirmed. Worded
  // conditionally because the callback cannot — and must not — say whether a
  // particular link was genuine. See src/lib/auth-callback.ts.
  const emailConfirmed = params.get("emailConfirmed");
  // Set by resetPassword after a new password is saved. Every session for the
  // account was revoked, so the next step is signing in with the new password.
  const passwordUpdated = params.get("passwordUpdated");

  return (
    <>
      {emailConfirmed && !linkExpired && (
        <p
          role="status"
          className="border-border-subtle border-l-accent bg-surface text-text-secondary rounded-md border border-l-2 px-4 py-3 text-[13px]"
        >
          <span className="text-ink block font-semibold">Sign in to finish</span>
          This link was opened in a different browser from the one used to create the account, so you weren&apos;t signed
          in automatically. If you just confirmed your email address, it&apos;s confirmed — sign in with your password to
          continue.
        </p>
      )}
      {passwordUpdated && !linkExpired && (
        <p
          role="status"
          className="border-border-subtle border-l-positive bg-surface text-text-secondary rounded-md border border-l-2 px-4 py-3 text-[13px]"
        >
          <span className="text-ink block font-semibold">Password updated</span>
          Sign in with your new password. For your security, every device that was signed in to this account has been
          signed out.
        </p>
      )}
      {linkExpired && (
        <ErrorState
          title="That link has expired"
          description="Confirmation and password-reset links can only be used once, and time out. Sign in below, or request a new link."
        />
      )}
    </>
  );
}

function LoginForm() {
  const [state, formAction, pending] = useActionState(signIn, {});

  return (
    <SignInPage
      formAction={formAction}
      pending={pending}
      error={state.error}
      notices={<LoginNotices />}
      resetPasswordHref="/forgot-password"
      createAccountHref="/signup"
    />
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
