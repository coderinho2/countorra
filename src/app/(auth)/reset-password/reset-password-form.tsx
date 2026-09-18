"use client";

import { useActionState, useState } from "react";
import { resetPassword } from "@/server/auth/actions";
import { PASSWORD_MISMATCH_MESSAGE, resetPasswordSchema } from "@/validation/schemas/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/auth/form-field";

type FieldName = "password" | "confirmPassword";
type FieldErrors = Partial<Record<FieldName, string>>;

/** Client-side hints only. The action re-validates everything, and refuses
 *  outright without a recovery session. */
function validate(password: string, confirmPassword: string): FieldErrors {
  const result = resetPasswordSchema.shape.password.safeParse(password);
  return {
    password: result.success ? undefined : result.error.issues[0]?.message,
    confirmPassword: confirmPassword === password ? undefined : PASSWORD_MISMATCH_MESSAGE,
  };
}

function valuesOf(form: HTMLFormElement | null) {
  const data = form ? new FormData(form) : new FormData();
  return [String(data.get("password") ?? ""), String(data.get("confirmPassword") ?? "")] as const;
}

export function ResetPasswordForm() {
  const [state, formAction, pending] = useActionState(resetPassword, {});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});

  const handleBlur = (name: FieldName) => (e: React.FocusEvent<HTMLInputElement>) => {
    setTouched((t) => ({ ...t, [name]: true }));
    const next = validate(...valuesOf(e.currentTarget.form));
    setErrors((prev) => ({ ...prev, [name]: next[name] }));
  };

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-center text-[26px] leading-9 font-semibold tracking-[-0.01em] text-ink">Set a new password</h1>

      {state.error && <ErrorState title="Couldn't reset your password" description={state.error} />}

      <form
        action={formAction}
        noValidate
        onSubmit={(e) => {
          const next = validate(...valuesOf(e.currentTarget));
          setErrors(next);
          setTouched({ password: true, confirmPassword: true });
          if (Object.values(next).some(Boolean)) e.preventDefault();
        }}
        className="flex flex-col gap-4"
      >
        <FormField id="password" label="New password" error={touched.password ? errors.password : undefined}>
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

        <FormField id="confirmPassword" label="Confirm new password" error={touched.confirmPassword ? errors.confirmPassword : undefined}>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            invalid={touched.confirmPassword && Boolean(errors.confirmPassword)}
            aria-describedby={touched.confirmPassword && errors.confirmPassword ? "confirmPassword-error" : undefined}
            onBlur={handleBlur("confirmPassword")}
            required
          />
        </FormField>

        <Button type="submit" size="lg" disabled={pending} className="mt-1 w-full justify-center">
          {pending ? "Saving…" : "Save new password"}
        </Button>
      </form>
    </div>
  );
}
