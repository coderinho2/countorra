import Link from "next/link";
import { BrandMark } from "@/components/marketing/brand-mark";

/**
 * Shared shell for /login, /signup, /verify-email, /forgot-password,
 * /reset-password. A quiet top bar (brand mark only — no marketing nav
 * inside an auth flow) and a legal footer bracket a centered column,
 * matching the restrained, precision-typography auth pattern the brief
 * asks for (Vercel-level simplicity) while staying entirely within
 * DESIGN.md's paper/ink/hairline-border language — no card chrome, no
 * gradients, no illustration.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
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
