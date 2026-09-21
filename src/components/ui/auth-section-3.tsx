"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { familyNameSchema, givenNameSchema, signUpSchema } from "@/validation/schemas/auth";
import { AuthSplit } from "@/components/auth/auth-split";
import { FormField } from "@/components/auth/form-field";
import { PasswordField } from "@/components/auth/password-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";

/**
 * The sign-up screen.
 *
 * ADAPTED from a 21st.dev reference. The layout, the two-up name row and the
 * terms checkbox are kept. Removed, and why:
 *
 *   - **Every hardcoded value.** The reference shipped a filled-in form — a
 *     name, an address, a masked password — that cleared itself on first
 *     focus. Real inputs start empty.
 *   - **The whole right-hand column**: a testimonial from an invented
 *     designer, a WebGL fluted-glass shader, and a screenshot of a different
 *     product's dashboard, all served from someone else's CDN. Replaced by
 *     Countorra's own brand panel (see AuthSplit).
 *   - **Google and Apple buttons.** The linked Supabase project reports
 *     `external: { email: true }`; neither provider exists to sign anyone in,
 *     and an auth path that cannot work is worse than an absent one. See the
 *     note in src/server/auth/actions.ts.
 *   - **The marketing opt-out checkbox**, which had nowhere to be stored.
 *   - **The shader and the gradient panel**, per DESIGN.md §26 — no gradient
 *     backgrounds, no glassmorphism outside the marketing header.
 *
 * Account creation, email confirmation and onboarding are untouched: the form
 * posts to the existing `signUp` Server Action through `formAction`.
 */

type FieldName = "firstName" | "lastName" | "email" | "password";
type FieldErrors = Partial<Record<FieldName | "terms", string>>;

const ACCEPT_TERMS_MESSAGE = "Please accept the Terms of Service and Privacy Policy to continue.";

function validateField(name: FieldName, value: string): string | undefined {
  const schema =
    name === "firstName" ? givenNameSchema : name === "lastName" ? familyNameSchema : signUpSchema.shape[name];
  const result = schema.safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

export interface SignUpPageProps {
  /** `formAction` from the route's `useActionState(signUp, …)`. */
  formAction: (formData: FormData) => void;
  /** React's own pending flag for that action. */
  pending?: boolean;
  /** Message returned by the action. */
  error?: string;
  notices?: ReactNode;
  signInHref?: string;
}

export default function AuthSectionThree({
  formAction,
  pending = false,
  error,
  notices,
  signInHref = "/login",
}: SignUpPageProps) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [touched, setTouched] = useState<Partial<Record<FieldName | "terms", boolean>>>({});
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  const handleBlur = (name: FieldName) => (event: React.FocusEvent<HTMLInputElement>) => {
    setTouched((previous) => ({ ...previous, [name]: true }));
    setErrors((previous) => ({ ...previous, [name]: validateField(name, event.target.value) }));
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    const form = new FormData(event.currentTarget);
    const nextErrors: FieldErrors = {
      firstName: validateField("firstName", String(form.get("firstName") ?? "")),
      lastName: validateField("lastName", String(form.get("lastName") ?? "")),
      email: validateField("email", String(form.get("email") ?? "")),
      password: validateField("password", String(form.get("password") ?? "")),
      terms: acceptedTerms ? undefined : ACCEPT_TERMS_MESSAGE,
    };
    setErrors(nextErrors);
    setTouched({ firstName: true, lastName: true, email: true, password: true, terms: true });
    if (Object.values(nextErrors).some(Boolean)) event.preventDefault();
  };

  return (
    <AuthSplit footer={null}>
      <div className="flex flex-col gap-8">
        <div className="section-enter flex flex-col gap-2" style={{ "--enter-index": 0 } as React.CSSProperties}>
          <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.015em] text-ink sm:text-[32px] sm:leading-10">
            Create your account
          </h1>
          <p className="text-[15px] text-text-secondary">Financial clarity for your money and your taxes.</p>
        </div>

        <div className="section-enter flex flex-col gap-5" style={{ "--enter-index": 1 } as React.CSSProperties}>
          {notices}
          {error && <ErrorState title="Couldn't create your account" description={error} />}

          <form action={formAction} onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField id="firstName" label="First name" error={touched.firstName ? errors.firstName : undefined}>
                <Input
                  id="firstName"
                  name="firstName"
                  type="text"
                  autoComplete="given-name"
                  invalid={touched.firstName && Boolean(errors.firstName)}
                  aria-describedby={touched.firstName && errors.firstName ? "firstName-error" : undefined}
                  onBlur={handleBlur("firstName")}
                  required
                />
              </FormField>

              <FormField id="lastName" label="Last name" error={touched.lastName ? errors.lastName : undefined}>
                <Input
                  id="lastName"
                  name="lastName"
                  type="text"
                  autoComplete="family-name"
                  invalid={touched.lastName && Boolean(errors.lastName)}
                  aria-describedby={touched.lastName && errors.lastName ? "lastName-error" : undefined}
                  onBlur={handleBlur("lastName")}
                  required
                />
              </FormField>
            </div>

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

            <FormField id="password" label="Password" error={touched.password ? errors.password : undefined}>
              <PasswordField
                id="password"
                name="password"
                autoComplete="new-password"
                minLength={8}
                invalid={touched.password && Boolean(errors.password)}
                describedBy={touched.password && errors.password ? "password-error" : "password-hint"}
                onBlur={handleBlur("password")}
              />
              {!(touched.password && errors.password) && (
                <p id="password-hint" className="text-[13px] text-text-tertiary">
                  At least 8 characters.
                </p>
              )}
            </FormField>

            {/* Acceptance is explicit here rather than implied by the footer
                line the other auth pages carry, because this is the screen
                where the agreement is actually entered into. */}
            <div className="mt-1 flex flex-col gap-2">
              <div className="flex items-start gap-3">
                <Checkbox
                  id="acceptTerms"
                  name="acceptTerms"
                  checked={acceptedTerms}
                  // Chrome computes this control's name from the label's
                  // contents but skips the two links inside it, which leaves a
                  // screen reader announcing "I agree to Countorra's and .".
                  // Stating the whole sentence here is the same text a sighted
                  // user reads, so WCAG 2.5.3 still holds.
                  aria-label="I agree to Countorra's Terms of Service and Privacy Policy."
                  onCheckedChange={(checked) => {
                    const accepted = checked === true;
                    setAcceptedTerms(accepted);
                    setErrors((previous) => ({ ...previous, terms: accepted ? undefined : ACCEPT_TERMS_MESSAGE }));
                  }}
                  aria-describedby={touched.terms && errors.terms ? "acceptTerms-error" : undefined}
                  className="mt-0.5 shrink-0"
                />
                <label htmlFor="acceptTerms" className="cursor-pointer text-[13px] leading-5 text-text-secondary">
                  I agree to Countorra&rsquo;s{" "}
                  <Link href="/terms" className="font-medium text-text-primary underline underline-offset-2">
                    Terms of Service
                  </Link>{" "}
                  and{" "}
                  <Link href="/privacy" className="font-medium text-text-primary underline underline-offset-2">
                    Privacy Policy
                  </Link>
                  .
                </label>
              </div>
              {touched.terms && errors.terms && (
                <p id="acceptTerms-error" role="alert" className="text-[13px] text-negative">
                  {errors.terms}
                </p>
              )}
            </div>

            <Button type="submit" size="lg" disabled={pending || !acceptedTerms} className="mt-2 w-full justify-center">
              {pending ? "Creating account…" : "Create account"}
            </Button>
          </form>
        </div>

        <p className="section-enter text-[13px] text-text-secondary" style={{ "--enter-index": 2 } as React.CSSProperties}>
          Already have an account?{" "}
          <Link href={signInHref} className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </AuthSplit>
  );
}
