"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { signInSchema } from "@/validation/schemas/auth";
import { AuthSplit } from "@/components/auth/auth-split";
import { FormField } from "@/components/auth/form-field";
import { PasswordField } from "@/components/auth/password-field";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";

/**
 * The sign-in screen.
 *
 * ADAPTED from a 21st.dev reference. What survived: the split layout, the
 * field order, the reveal toggle, the staged entrance. What did not, and why:
 *
 *   - **The right-hand photograph and its testimonials are gone.** They were
 *     three invented people praising a product. See AuthSplit's brand panel.
 *   - **`rounded-2xl`, `backdrop-blur` glass fields and the violet accent are
 *     gone.** DESIGN.md §26 caps radius at 14px, allows glassmorphism only in
 *     the marketing header, and §3 specifies Statement Navy. Fields are the
 *     product's own `Input`, so this form cannot drift away from every other
 *     form in the application.
 *   - **Entrances were retimed from 100–1400ms to a capped ~200ms cascade**
 *     (DESIGN.md §22), and they collapse to instant under
 *     `prefers-reduced-motion` through the global rule in globals.css.
 *   - **No Google button.** The linked Supabase project reports
 *     `external: { email: true }`; a provider button here could only ever
 *     fail. See the note in src/server/auth/actions.ts.
 *   - **No "keep me signed in".** Session lifetime is decided by the Supabase
 *     project's refresh-token settings, not per sign-in, so the control would
 *     have been a checkbox that changed nothing.
 *
 * This component owns presentation and field-level validation, and nothing
 * else. The credential check, the session and the redirect all stay in the
 * existing `signIn` Server Action, reached through the `formAction` prop.
 */

type FieldName = "email" | "password";
type FieldErrors = Partial<Record<FieldName, string>>;

function validateField(name: FieldName, value: string): string | undefined {
  const result = signInSchema.shape[name].safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

export interface SignInPageProps {
  /** `formAction` from the route's `useActionState(signIn, …)`. */
  formAction: (formData: FormData) => void;
  /** React's own pending flag for that action. */
  pending?: boolean;
  /** Message returned by the action, e.g. a failed credential check. */
  error?: string;
  /** Status banners the route decides on (confirmed email, expired link, …). */
  notices?: ReactNode;
  resetPasswordHref?: string;
  createAccountHref?: string;
}

export function SignInPage({
  formAction,
  pending = false,
  error,
  notices,
  resetPasswordHref = "/forgot-password",
  createAccountHref = "/signup",
}: SignInPageProps) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});

  const handleBlur = (name: FieldName) => (event: React.FocusEvent<HTMLInputElement>) => {
    setTouched((previous) => ({ ...previous, [name]: true }));
    setErrors((previous) => ({ ...previous, [name]: validateField(name, event.target.value) }));
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    const form = new FormData(event.currentTarget);
    const nextErrors: FieldErrors = {
      email: validateField("email", String(form.get("email") ?? "")),
      password: validateField("password", String(form.get("password") ?? "")),
    };
    setErrors(nextErrors);
    setTouched({ email: true, password: true });
    if (Object.values(nextErrors).some(Boolean)) event.preventDefault();
  };

  return (
    <AuthSplit>
      <div className="flex flex-col gap-8">
        <div className="section-enter flex flex-col gap-2" style={{ "--enter-index": 0 } as React.CSSProperties}>
          <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.015em] text-ink sm:text-[32px] sm:leading-10">
            Welcome back
          </h1>
          <p className="text-[15px] text-text-secondary">Sign in to pick up where your records left off.</p>
        </div>

        <div className="section-enter flex flex-col gap-5" style={{ "--enter-index": 1 } as React.CSSProperties}>
          {notices}
          {error && <ErrorState title="Couldn't sign you in" description={error} />}

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
                <Link href={resetPasswordHref} className="text-[13px] text-accent hover:underline">
                  Forgot password?
                </Link>
              }
              error={touched.password ? errors.password : undefined}
            >
              <PasswordField
                id="password"
                name="password"
                autoComplete="current-password"
                invalid={touched.password && Boolean(errors.password)}
                describedBy={touched.password && errors.password ? "password-error" : undefined}
                onBlur={handleBlur("password")}
              />
            </FormField>

            <Button type="submit" size="lg" disabled={pending} className="mt-2 w-full justify-center">
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </div>

        <p className="section-enter text-[13px] text-text-secondary" style={{ "--enter-index": 2 } as React.CSSProperties}>
          New to Countorra?{" "}
          <Link href={createAccountHref} className="font-medium text-accent hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </AuthSplit>
  );
}
