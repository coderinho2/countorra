import { z } from "zod";

export const signUpSchema = z.object({
  email: z.email(),
  password: z.string().min(8, "Password must be at least 8 characters."),
  fullName: z.string().min(1, "Full name is required.").max(200),
});

/**
 * Sign-up collects a given and a family name; the account stores a single
 * display name (`raw_user_meta_data.full_name`, which src/lib/identity.ts
 * reads). Composing the two halves here — shared by the form's own validation
 * and by the Server Action — keeps both fields real inputs without adding a
 * second name column to anything downstream.
 */
export const givenNameSchema = z.string().trim().min(1, "First name is required.").max(100);
export const familyNameSchema = z.string().trim().min(1, "Last name is required.").max(100);

export function composeFullName(firstName: string, lastName: string): string {
  return [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");
}

export const signInSchema = z.object({
  email: z.email(),
  password: z.string().min(1, "Password is required."),
});

export const requestPasswordResetSchema = z.object({
  email: z.email(),
});

export const PASSWORD_MISMATCH_MESSAGE = "The passwords don't match.";

export const resetPasswordSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters."),
    confirmPassword: z.string(),
  })
  .refine((input) => input.password === input.confirmPassword, {
    message: PASSWORD_MISMATCH_MESSAGE,
    path: ["confirmPassword"],
  });

export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
