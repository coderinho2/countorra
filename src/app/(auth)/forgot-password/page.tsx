"use client";

import { Suspense, useActionState, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle } from "@phosphor-icons/react/dist/ssr/CheckCircle";
import { requestPasswordReset } from "@/server/auth/actions";
import { requestPasswordResetSchema } from "@/validation/schemas/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/auth/form-field";

function validateEmail(value: string): string | undefined {
  const result = requestPasswordResetSchema.shape.email.safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, {});
  const [error, setError] = useState<string>();
  const [touched, setTouched] = useState(false);
  const params = useSearchParams();
  // Both set by /auth/callback for a link marked as a reset (src/lib/auth-callback.ts).
  // Worded conditionally: the callback cannot say whether a given link was genuine.
  const linkExpired = params.get("linkExpired");
  const openedElsewhere = params.get("openedElsewhere");

  if (state.success) {
    return (
      <div className="flex flex-col items-center gap-5 text-center">
        <span className="flex size-12 items-center justify-center rounded-md border border-border-subtle bg-surface text-positive">
          <CheckCircle size={24} />
        </span>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[20px] leading-7 font-semibold tracking-[-0.005em] text-ink">Check your email</h1>
          <p className="max-w-[320px] text-[15px] text-text-secondary">
            If an account exists for that email, we&apos;ve sent a link to reset your password. Open it in this browser.
          </p>
        </div>
        <Button asChild variant="secondary" size="md" className="mt-1">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5 text-center">
        <h1 className="text-[26px] leading-9 font-semibold tracking-[-0.01em] text-ink">Reset your password</h1>
        <p className="text-[15px] text-text-secondary">Enter your email and we&apos;ll send you a link to reset it.</p>
      </div>

      <div className="flex flex-col gap-5">
        {openedElsewhere && !linkExpired && (
          <p
            role="status"
            className="rounded-md border border-border-subtle border-l-2 border-l-accent bg-surface px-4 py-3 text-[13px] text-text-secondary"
          >
            <span className="block font-semibold text-ink">Open the link in this browser</span>
            Reset links only work in the browser where the reset was requested. Request a new link below, then open it here.
          </p>
        )}
        {linkExpired && (
          <ErrorState title="That reset link has expired" description="Reset links can only be used once, and time out. Request a new one below." />
        )}
        {state.error && <ErrorState title="Couldn't send a reset link" description={state.error} />}

        <form
          action={formAction}
          noValidate
          onSubmit={(e) => {
            const value = String(new FormData(e.currentTarget).get("email") ?? "");
            const nextError = validateEmail(value);
            setError(nextError);
            setTouched(true);
            if (nextError) e.preventDefault();
          }}
          className="flex flex-col gap-4"
        >
          <FormField id="email" label="Email" error={touched ? error : undefined}>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              invalid={touched && Boolean(error)}
              aria-describedby={touched && error ? "email-error" : undefined}
              onBlur={(e) => {
                setTouched(true);
                setError(validateEmail(e.target.value));
              }}
              required
            />
          </FormField>

          <Button type="submit" size="lg" disabled={pending} className="mt-1 w-full justify-center">
            {pending ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      </div>

      <p className="text-center text-[13px] text-text-secondary">
        <Link href="/login" className="font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ForgotPasswordForm />
    </Suspense>
  );
}
