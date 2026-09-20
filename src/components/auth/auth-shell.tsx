import type { ReactNode } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/marketing/brand-mark";

/**
 * The centered single-column auth shell: a quiet top bar (brand mark only —
 * no marketing nav inside an auth flow) and a legal footer bracketing a
 * narrow column.
 *
 * This used to be `(auth)/layout.tsx` itself. It moved here when /login and
 * /signup became full-bleed two-column screens: a route-group layout wraps
 * every page under it, so the shell had to become something a page opts into
 * rather than something every page inherits. /verify-email, /forgot-password
 * and /reset-password are unchanged by that move — they render exactly the
 * same markup they always did.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-1 flex-col">
      <header className="flex h-16 items-center justify-center border-b border-border-subtle">
        <Link href="/" className="flex items-center gap-2 text-ink transition-opacity duration-100 ease-out hover:opacity-80">
          <BrandMark size={22} />
          <span className="text-[15px] font-semibold tracking-[-0.005em]">Countorra</span>
        </Link>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-12 sm:py-16">
        <div className="page-enter w-full max-w-[400px]">{children}</div>
      </main>

      <footer className="border-t border-border-subtle px-6 py-6">
        <p className="text-center text-[12px] text-text-tertiary">
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
      </footer>
    </div>
  );
}
