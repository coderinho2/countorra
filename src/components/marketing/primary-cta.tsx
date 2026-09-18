import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getMarketingAuthState } from "@/server/marketing/auth-state";
import { cn } from "@/lib/utils";

/**
 * The public site's primary call to action, resolved against who is
 * actually reading it.
 *
 * Signed out it is "Get started" → `/signup`. Signed in it is "Open
 * Countorra" → the user's own dashboard. Asking someone who is already
 * logged in to create an account is the kind of detail that quietly tells a
 * visitor the product isn't paying attention, and this product's whole
 * claim is that it is.
 *
 * A server component on purpose: the session it reads is the real
 * cookie-validated one (see `getMarketingAuthState`), so the correct button
 * is in the HTML on first paint — no flash of the wrong CTA, and no
 * client-side auth state to get out of step with the server's.
 */
export async function PrimaryCta({
  signedOutLabel = "Get started",
  size = "lg",
  className,
}: {
  /** Overridable because the pricing table's Free plan says "Get started"
   *  in the context of a plan, not of the site. */
  signedOutLabel?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const { identity, appHref } = await getMarketingAuthState();

  return (
    <Button asChild variant="primary" size={size} className={className}>
      <Link href={identity ? appHref : "/signup"}>{identity ? "Open Countorra" : signedOutLabel}</Link>
    </Button>
  );
}

/**
 * The quiet "Sign in" that sits beside a primary CTA. It disappears
 * entirely when there is already a session — there is nothing to sign in
 * to, and leaving it up would imply otherwise.
 */
export async function SignInLink({ className }: { className?: string }) {
  const { identity } = await getMarketingAuthState();
  if (identity) return null;

  return (
    <Link
      href="/login"
      className={cn("text-[14px] text-text-secondary transition-colors duration-100 ease-out hover:text-text-primary", className)}
    >
      Sign in
    </Link>
  );
}
