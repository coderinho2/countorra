import Link from "next/link";
import { getRecoverySession } from "@/server/auth/recovery";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { ResetPasswordForm } from "./reset-password-form";

/**
 * The form is rendered only for a recent recovery session — one created by
 * exchanging a recovery link's code in /auth/callback. Anyone else (no
 * session, an ordinary password session, a recovery session past its window)
 * gets a way to request a new link instead.
 *
 * This is not the security boundary on its own: `resetPassword` applies the
 * same check, because a Server Action can be invoked without loading this page.
 */
export default async function ResetPasswordPage() {
  const recovery = await getRecoverySession();
  if (recovery) return <ResetPasswordForm />;

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-center text-[26px] leading-9 font-semibold tracking-[-0.01em] text-ink">Set a new password</h1>

      <ErrorState
        title="This reset link can't be used"
        description="Reset links work once, for a short time, in the browser where the reset was requested. Request a new link to set your password."
        action={
          <Button asChild variant="secondary" size="md">
            <Link href="/forgot-password">Request a new link</Link>
          </Button>
        }
      />

      <p className="text-center text-[13px] text-text-secondary">
        <Link href="/login" className="font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
