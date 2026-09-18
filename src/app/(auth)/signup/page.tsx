"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { signUp } from "@/server/auth/actions";
import { signUpSchema } from "@/validation/schemas/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/auth/form-field";

type FieldName = "fullName" | "email" | "password";
type FieldErrors = Partial<Record<FieldName, string>>;

function validateField(name: FieldName, value: string): string | undefined {
  const result = signUpSchema.shape[name].safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

function SignUpForm() {
  const [state, formAction, pending] = useActionState(signUp, {});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});

  const handleBlur = (name: FieldName) => (e: React.FocusEvent<HTMLInputElement>) => {
    setTouched((t) => ({ ...t, [name]: true }));
    setErrors((prev) => ({ ...prev, [name]: validateField(name, e.target.value) }));
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    const form = new FormData(e.currentTarget);
    const nextErrors: FieldErrors = {
      fullName: validateField("fullName", String(form.get("fullName") ?? "")),
      email: validateField("email", String(form.get("email") ?? "")),
      password: validateField("password", String(form.get("password") ?? "")),
    };
    setErrors(nextErrors);
    setTouched({ fullName: true, email: true, password: true });
    if (Object.values(nextErrors).some(Boolean)) e.preventDefault();
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5 text-center">
        <h1 className="text-[26px] leading-9 font-semibold tracking-[-0.01em] text-ink">Create your account</h1>
        <p className="text-[15px] text-text-secondary">Financial clarity for your money, your work, or your business.</p>
      </div>

      <div className="flex flex-col gap-5">
        {state.error && <ErrorState title="Couldn't create your account" description={state.error} />}

        <form action={formAction} onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <FormField id="fullName" label="Full name" error={touched.fullName ? errors.fullName : undefined}>
            <Input
              id="fullName"
              name="fullName"
              type="text"
              autoComplete="name"
              invalid={touched.fullName && Boolean(errors.fullName)}
              aria-describedby={touched.fullName && errors.fullName ? "fullName-error" : undefined}
              onBlur={handleBlur("fullName")}
              required
            />
          </FormField>

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
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              invalid={touched.password && Boolean(errors.password)}
              aria-describedby={touched.password && errors.password ? "password-error" : undefined}
              onBlur={handleBlur("password")}
              required
            />
          </FormField>

          <Button type="submit" size="lg" disabled={pending} className="mt-1 w-full justify-center">
            {pending ? "Creating account…" : "Create account"}
          </Button>
        </form>
      </div>

      <p className="text-center text-[13px] text-text-secondary">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}

export default function SignUpPage() {
  return <SignUpForm />;
}
