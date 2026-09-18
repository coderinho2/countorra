"use client";

import { Suspense, useActionState, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "@/server/auth/actions";
import { signInSchema } from "@/validation/schemas/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/auth/form-field";

type FieldName = "email" | "password";
type FieldErrors = Partial<Record<FieldName, string>>;

function validateField(name: FieldName, value: string): string | undefined {
  const result = signInSchema.shape[name].safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

function LoginForm() {
  const [state, formAction, pending] = useActionState(signIn, {});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
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

  const handleBlur = (name: FieldName) => (e: React.FocusEvent<HTMLInputElement>) => {
    setTouched((t) => ({ ...t, [name]: true }));
    setErrors((prev) => ({ ...prev, [name]: validateField(name, e.target.value) }));
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    const form = new FormData(e.currentTarget);
    const nextErrors: FieldErrors = {
      email: validateField("email", String(form.get("email") ?? "")),
      password: validateField("password", String(form.get("password") ?? "")),
    };
    setErrors(nextErrors);
    setTouched({ email: true, password: true });
    if (Object.values(nextErrors).some(Boolean)) e.preventDefault();
  };

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-center text-[26px] leading-9 font-semibold tracking-[-0.01em] text-ink">Welcome back</h1>

      <div className="flex flex-col gap-5">
        {emailConfirmed && !linkExpired && (
          <p
            role="status"
            className="rounded-md border border-border-subtle border-l-2 border-l-accent bg-surface px-4 py-3 text-[13px] text-text-secondary"
          >
            <span className="block font-semibold text-ink">Sign in to finish</span>
            This link was opened in a different browser from the one used to create the account, so you weren&apos;t signed in automatically. If
            you just confirmed your email address, it&apos;s confirmed — sign in with your password to continue.
          </p>
        )}
        {passwordUpdated && !linkExpired && (
          <p
            role="status"
            className="rounded-md border border-border-subtle border-l-2 border-l-positive bg-surface px-4 py-3 text-[13px] text-text-secondary"
          >
            <span className="block font-semibold text-ink">Password updated</span>
            Sign in with your new password. For your security, every device that was signed in to this account has been signed out.
          </p>
        )}
        {linkExpired && (
          <ErrorState
            title="That link has expired"
            description="Confirmation and password-reset links can only be used once, and time out. Sign in below, or request a new link."
          />
        )}
        {state.error && <ErrorState title="Couldn't sign you in" description={state.error} />}

        <form action={formAction} onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <FormField id="email" label="Email" error={touched.email ? errors.email : undefined}>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              invalid={touched.email && Boolean(errors.email)}
              aria-describedby={touched.email && errors.email ? "email-error" : undefined}
              onBlur={handleBlur("email")}
              required
            />
          </FormField>

          <FormField
            id="password"
            label="Password"
            labelAction={
              <Link href="/forgot-password" className="text-[13px] text-accent hover:underline">
                Forgot password?
              </Link>
            }
            error={touched.password ? errors.password : undefined}
          >
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              invalid={touched.password && Boolean(errors.password)}
              aria-describedby={touched.password && errors.password ? "password-error" : undefined}
              onBlur={handleBlur("password")}
              required
            />
          </FormField>

          <Button type="submit" size="lg" disabled={pending} className="mt-1 w-full justify-center">
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>

      <p className="text-center text-[13px] text-text-secondary">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-medium text-accent hover:underline">
          Create one
        </Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
