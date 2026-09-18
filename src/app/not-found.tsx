import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * 404, for every route the App Router cannot match.
 *
 * There was none, so a mistyped URL fell through to Next's built-in page —
 * unstyled, off-brand, and with no way back into the product. Deliberately
 * offers only public destinations: this renders for signed-out visitors too,
 * and a link into /app would bounce them to login for no reason.
 *
 * No error detail is shown because a 404 has none worth showing; the path is
 * already visible in the address bar.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center">
      <p className="font-numeric text-[11px] tracking-[0.14em] text-text-tertiary uppercase">Error 404</p>
      <h1 className="font-serif max-w-[20ch] text-[32px] leading-[38px] font-normal tracking-[0] text-ink sm:text-[40px] sm:leading-[46px]">
        We couldn&apos;t find that page.
      </h1>
      <p className="max-w-[46ch] text-[15px] leading-[24px] text-text-secondary">
        The link may be out of date, or the page may have moved. Nothing in your records has changed.
      </p>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row">
        <Button asChild variant="primary" size="lg">
          <Link href="/">Back to the homepage</Link>
        </Button>
        <Button asChild variant="secondary" size="lg">
          <Link href="/product">See what Countorra does</Link>
        </Button>
      </div>
    </main>
  );
}
