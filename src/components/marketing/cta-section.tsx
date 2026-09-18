import { PrimaryCta, SignInLink } from "./primary-cta";

/**
 * Closing CTA (product spec). No invented pricing tiers — billing isn't
 * built yet, so this stays a plain call to action rather than a fake
 * pricing table.
 *
 * Both actions are auth-aware: for a signed-in reader this becomes a way
 * back into their own workspace, and the "Sign in" beside it disappears
 * rather than offering to do something they have already done.
 */
export function CtaSection() {
  return (
    <div className="flex flex-col items-center gap-6 rounded-lg border border-border-subtle bg-surface px-6 py-16 text-center sm:py-20">
      <h2 className="font-serif font-normal tracking-[0] max-w-[26ch] text-[30px] leading-[38px] text-ink sm:text-[36px] sm:leading-[44px]">
        Start understanding your money.
      </h2>
      <div className="flex flex-col items-center gap-3 sm:flex-row">
        <PrimaryCta />
        <SignInLink />
      </div>
    </div>
  );
}
