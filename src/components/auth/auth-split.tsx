import type { ReactNode } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/marketing/brand-mark";

/**
 * The two-column frame shared by /login and /signup.
 *
 * The form sits on the left; the right is Countorra's own brand panel
 * (below). The reference designs both put a photograph, a testimonial and a
 * product screenshot there — none of which this product has, and all of which
 * would be invented content on the one screen where a visitor is about to
 * hand over a password. The brand mark is the honest thing to show.
 *
 * Everything here is server-rendered. The entrance is CSS `@starting-style`
 * (`.section-enter`, globals.css), so there is no mounted-state bookkeeping
 * and no JavaScript standing between a visitor and the sign-in form.
 */
export function AuthSplit({ children, footer = <LegalLine /> }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-svh grid-cols-1 lg:grid-cols-2">
      <section className="flex flex-col px-6 py-8 sm:px-10 lg:px-12 xl:px-16">
        <div className="flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2 text-ink transition-opacity duration-100 ease-out hover:opacity-80">
            <BrandMark size={22} />
            <span className="text-[15px] font-semibold tracking-[-0.005em]">Countorra</span>
          </Link>
          <Link href="/" className="text-[13px] text-text-secondary transition-colors duration-100 ease-out hover:text-text-primary">
            Back to site
          </Link>
        </div>

        <div className="flex flex-1 items-center justify-center py-10 sm:py-14">
          <div className="w-full max-w-[416px]">{children}</div>
        </div>

        {footer}
      </section>

      <AuthBrandPanel />
    </div>
  );
}

/** The implicit-acceptance line the auth flow has always carried. Sign-up
 *  replaces it with an explicit checkbox, so it passes `footer={null}`. */
function LegalLine() {
  return (
    <p className="text-[12px] text-text-tertiary">
      By continuing, you agree to Countorra&rsquo;s{" "}
      <Link href="/terms" className="text-text-secondary hover:text-text-primary hover:underline">
        Terms
      </Link>{" "}
      and{" "}
      <Link href="/privacy" className="text-text-secondary hover:text-text-primary hover:underline">
        Privacy Policy
      </Link>
      .
    </p>
  );
}

/**
 * Ledger paper, and the mark that came from it.
 *
 * DESIGN.md §26 rules out most of what an auth-screen "hero panel" normally
 * reaches for: no gradient background, no glow, no glassmorphism, no
 * decorative blobs. What is left is the product's own metaphor — ruled
 * paper — drawn as hairlines on `--color-surface-sunken`, one step away from
 * the form's paper background rather than a slab of contrasting colour. In
 * dark mode that same token is graphite (#1C1C1C) against a near-black page,
 * so the panel reads as intended in both themes without a single hardcoded
 * hex value in this file.
 *
 * The rules are cleared from the centre by a radial mask so the mark sits on
 * open paper, and faded at the outer edge so they never collide with the
 * panel border. Hidden below `lg`, where a second column would become a
 * decorative band above the form; the mark still appears in the header there.
 */
function AuthBrandPanel() {
  return (
    <aside className="relative hidden overflow-hidden border-l border-border-subtle bg-surface-sunken lg:flex lg:flex-col lg:items-center lg:justify-center">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: "linear-gradient(to bottom, var(--color-border-subtle) 1px, transparent 1px)",
          backgroundSize: "100% 44px",
          maskImage: "radial-gradient(58% 42% at 50% 46%, transparent 30%, black 100%)",
          WebkitMaskImage: "radial-gradient(58% 42% at 50% 46%, transparent 30%, black 100%)",
        }}
      />

      <div
        className="section-enter relative flex flex-col items-center gap-7 px-12 text-center"
        style={{ "--enter-index": 1 } as React.CSSProperties}
      >
        <BrandMark size={76} className="text-ink" />
        <div className="flex flex-col gap-3">
          <p className="text-[30px] leading-9 font-semibold tracking-[-0.02em] text-ink">Countorra</p>
          <p className="max-w-[28ch] text-[15px] text-text-secondary">Financial intelligence for your own records.</p>
        </div>
      </div>
    </aside>
  );
}
