import Link from "next/link";
import { getMarketingAuthState } from "@/server/marketing/auth-state";
import { BrandMark } from "./brand-mark";

const COLUMNS = [
  {
    label: "Product",
    links: [
      { label: "Financial intelligence", href: "/product#financial-intelligence" },
      { label: "Accounting", href: "/product#accounting" },
      { label: "Invoicing", href: "/product#invoicing" },
      { label: "Documents", href: "/product#documents" },
      { label: "AI", href: "/product#financial-intelligence" },
    ],
  },
  {
    label: "Solutions",
    links: [
      { label: "Personal", href: "/solutions/personal" },
      { label: "Freelancer", href: "/solutions/freelancer" },
      { label: "Business", href: "/solutions/business" },
    ],
  },
  {
    label: "Resources",
    links: [
      { label: "How it works", href: "/resources#how-it-works" },
      { label: "Guides", href: "/resources#guides" },
    ],
  },
  {
    label: "Company",
    links: [
      { label: "Security", href: "/security" },
      { label: "Pricing", href: "/pricing" },
    ],
  },
];

/** Every link is a route or anchor that actually exists — no
 *  Documentation/Changelog/Status placeholders with nothing behind
 *  them. Privacy and Terms are real pages (honest placeholders, not
 *  dead links); see src/app/privacy and src/app/terms. */
/** The Account column's links share one treatment; naming it keeps the
 *  signed-in and signed-out branches from drifting apart. */
const ACCOUNT_LINK = "text-[13px] text-text-secondary transition-colors duration-100 ease-out hover:text-text-primary";

export async function MarketingFooter() {
  const { identity, appHref, settingsHref } = await getMarketingAuthState();

  return (
    <footer className="border-t border-border-subtle">
      <div className="mx-auto grid max-w-[1200px] grid-cols-2 gap-x-8 gap-y-10 px-6 py-16 sm:grid-cols-3 lg:grid-cols-6 lg:px-10">
        <div className="col-span-2 sm:col-span-3 lg:col-span-2">
          <Link href="/" className="flex items-center gap-2 text-[15px] font-semibold text-ink">
            <BrandMark size={20} />
            Countorra
          </Link>
          <p className="mt-3 max-w-[34ch] text-[13px] text-text-secondary">Your personal financial intelligence and accounting system.</p>
        </div>

        {COLUMNS.map((column) => (
          <div key={column.label}>
            <p className="text-[11px] font-semibold tracking-wide text-text-tertiary uppercase">{column.label}</p>
            <ul className="mt-3 flex flex-col gap-2">
              {column.links.map((link) => (
                <li key={link.label}>
                  <Link href={link.href} className="text-[13px] text-text-secondary transition-colors duration-100 ease-out hover:text-text-primary">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <div>
          <p className="text-[11px] font-semibold tracking-wide text-text-tertiary uppercase">Account</p>
          {/* The last place on the page that could still ask a signed-in
              reader to open a second account. For them the column becomes
              the two things they can actually act on instead. */}
          <ul className="mt-3 flex flex-col gap-2">
            {identity ? (
              <>
                <li>
                  <Link href={appHref} className={ACCOUNT_LINK}>
                    Open Countorra
                  </Link>
                </li>
                <li>
                  <Link href={settingsHref} className={ACCOUNT_LINK}>
                    Settings
                  </Link>
                </li>
              </>
            ) : (
              <>
                <li>
                  <Link href="/login" className={ACCOUNT_LINK}>
                    Sign in
                  </Link>
                </li>
                <li>
                  <Link href="/signup" className={ACCOUNT_LINK}>
                    Get started
                  </Link>
                </li>
              </>
            )}
          </ul>
        </div>
      </div>

      <div className="mx-auto flex max-w-[1200px] flex-col items-start justify-between gap-3 border-t border-border-subtle px-6 py-6 text-[12px] text-text-tertiary sm:flex-row sm:items-center lg:px-10">
        <span>© {new Date().getFullYear()} Countorra. All figures shown on this site are illustrative.</span>
        <div className="flex items-center gap-4">
          <Link href="/privacy" className="transition-colors duration-100 ease-out hover:text-text-secondary">
            Privacy
          </Link>
          <Link href="/terms" className="transition-colors duration-100 ease-out hover:text-text-secondary">
            Terms
          </Link>
        </div>
      </div>
    </footer>
  );
}
