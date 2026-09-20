"use client";

import { useActionState } from "react";
import { signUp } from "@/server/auth/actions";
import AuthSectionThree from "@/components/ui/auth-section-3";

/**
 * The route owns the registration; AuthSectionThree owns the pixels.
 *
 * `useActionState(signUp, …)` still drives the existing Server Action — the
 * same validation, the same rate limiter, the same Supabase `signUp` with
 * email confirmation, and the same hand-off to /verify-email and from there
 * into onboarding. The redesign changed what this screen looks like, not what
 * creating an account does.
 */
export default function SignUpPage() {
  const [state, formAction, pending] = useActionState(signUp, {});

  return <AuthSectionThree formAction={formAction} pending={pending} error={state.error} signInHref="/login" />;
}
