import Link from "next/link";
import { EnvelopeSimple } from "@phosphor-icons/react/dist/ssr/EnvelopeSimple";
import { Button } from "@/components/ui/button";

/** DESIGN.md §16 empty-state pattern: one small line icon, an H4
 *  headline, one line of explanatory text, exactly one primary action —
 *  no illustration, no mascot. */
export default function VerifyEmailPage() {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <span className="flex size-12 items-center justify-center rounded-md border border-border-subtle bg-surface text-text-tertiary">
        <EnvelopeSimple size={24} />
      </span>

      <div className="flex flex-col gap-1.5">
        <h1 className="text-[20px] leading-7 font-semibold tracking-[-0.005em] text-ink">Check your inbox</h1>
        <p className="max-w-[320px] text-[15px] text-text-secondary">
          We&apos;ve sent a confirmation link to your email address. Click it to activate your account.
        </p>
        {/* PKCE keeps the sign-in half of the link in this browser. Opened
            anywhere else, the address is still confirmed, but the visitor has
            to sign in with their password — say so up front. */}
        <p className="max-w-[320px] text-[13px] text-text-tertiary">
          Open the link in this browser to be signed in straight away. Opened on another device, it still confirms your address — you&apos;ll just sign in afterwards.
        </p>
      </div>

      <Button asChild variant="secondary" size="md" className="mt-1">
        <Link href="/login">Back to sign in</Link>
      </Button>
    </div>
  );
}
