import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Reveal } from "@/components/marketing/reveal";
import { GUIDE_CATEGORIES, GUIDES, guidesInCategory, readingMinutes } from "@/components/guides/guides-content";

export const metadata: Metadata = {
  title: "Financial guides",
  description: "Practical guides to organizing your personal finances, understanding your cash flow, and preparing your tax year — written against what Countorra actually does.",
  alternates: { canonical: "/guides" },
};

/**
 * The guides index.
 *
 * Composed as a grouped ledger rather than a grid of equal cards: guides
 * differ in length and in who needs them, and DESIGN.md §26 rules out the
 * repeating three-card layout that would flatten that difference. Rows
 * divided by hairlines are also simply the right form for a list you scan by
 * title, and they hold up at every width without a breakpoint.
 */
export default function GuidesIndexPage() {
  return (
    <MarketingShell>
      <section className="mx-auto max-w-[1200px] px-6 pt-16 pb-12 lg:px-10 lg:pt-24">
        <Reveal>
          <p className="font-numeric text-[11px] tracking-[0.14em] text-text-tertiary uppercase">Resources</p>
          <h1 className="font-serif mt-3 max-w-[20ch] text-[40px] leading-[46px] font-normal tracking-[0] text-ink sm:text-[48px] sm:leading-[56px]">Financial guides.</h1>
          <p className="mt-5 max-w-[60ch] text-[17px] leading-[26px] text-text-secondary">
            Practical guidance on organizing your own money — how to read your cash flow, keep an imported ledger honest, and arrive at tax season with the work
            already done. {GUIDES.length} guides, written against what Countorra actually does.
          </p>
        </Reveal>
      </section>

      {GUIDE_CATEGORIES.map((category) => {
        const guides = guidesInCategory(category);
        if (guides.length === 0) return null;
        return (
          <section key={category} className="border-t border-border-subtle">
            <div className="mx-auto max-w-[900px] px-6 py-12 lg:px-10 lg:py-14">
              <Reveal>
                <h2 className="font-numeric flex items-center gap-3 border-b border-border pb-2.5 text-[10px] tracking-[0.14em] text-text-tertiary uppercase">
                  {category}
                  <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
                </h2>
              </Reveal>
              <ul className="mt-2 flex flex-col divide-y divide-border-subtle">
                {guides.map((guide) => (
                  <li key={guide.slug}>
                    <Reveal>
                      <Link
                        href={`/guides/${guide.slug}`}
                        className="group flex flex-col gap-1.5 rounded-sm py-6 transition-colors duration-100 ease-out sm:flex-row sm:items-baseline sm:gap-6"
                      >
                        <div className="min-w-0 flex-1">
                          <h3 className="text-[17px] font-semibold text-ink group-hover:text-accent">{guide.title}</h3>
                          <p className="mt-1.5 max-w-[62ch] text-[15px] leading-[1.6] text-text-secondary">{guide.summary}</p>
                        </div>
                        <span className="font-numeric shrink-0 text-[12px] text-text-tertiary">{readingMinutes(guide)} min read</span>
                      </Link>
                    </Reveal>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        );
      })}

      <section className="border-t border-border-subtle bg-surface-sunken/40">
        <div className="mx-auto max-w-[900px] px-6 py-12 lg:px-10">
          <Reveal>
            <p className="max-w-[60ch] text-[15px] leading-[1.7] text-text-secondary">
              Looking for how a particular screen works rather than how to think about your money? That lives in the{" "}
              <Link href="/help" className="text-accent hover:underline">
                Help Centre
              </Link>
              .
            </p>
          </Reveal>
        </div>
      </section>
    </MarketingShell>
  );
}
