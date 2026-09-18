import type { Metadata } from "next";
import Link from "next/link";
import { BookOpen } from "@phosphor-icons/react/dist/ssr/BookOpen";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Reveal } from "@/components/marketing/reveal";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata: Metadata = {
  title: "Resources — Countorra",
  description: "How Countorra works, and where the product is headed.",
};

const CHAPTERS = [
  { number: "01", title: "See everything.", body: "Income, expenses, accounts, and invoices, read as one connected system instead of five separate spreadsheets." },
  { number: "02", title: "Ask anything.", body: "Real questions, answered from your actual transactions and invoices — as financial UI, not a wall of chat text." },
  { number: "03", title: "Understand what changed.", body: "When something moves, Countorra shows the comparison and the reason, not just a number." },
  { number: "04", title: "Act.", body: "Categorize, draft an invoice, or follow up on one that's overdue — reads run instantly, writes wait for your confirmation." },
  { number: "05", title: "Stay ahead.", body: "Countorra can surface things worth noticing before you go looking for them." },
];

/**
 * Resources (product spec §10): an editorial, document-oriented reading
 * of the same product story shown interactively on the homepage —
 * different composition (plain numbered prose, no widgets) for a
 * different reading context.
 */
export default function ResourcesPage() {
  return (
    <MarketingShell>
      <section className="mx-auto max-w-[1200px] px-6 pt-16 pb-14 lg:px-10 lg:pt-24">
        <Reveal>
          <p className="font-numeric text-[11px] tracking-[0.14em] text-text-tertiary uppercase">Resources</p>
          <h1 className="font-serif font-normal tracking-[0] mt-3 max-w-[20ch] text-[40px] leading-[46px] text-ink sm:text-[48px] sm:leading-[56px]">
            How Countorra works.
          </h1>
          <p className="mt-5 max-w-[56ch] text-[17px] leading-[26px] text-text-secondary">
            The whole product, read end to end — and where to go for the interactive version.
          </p>
        </Reveal>
      </section>

      <section id="how-it-works" className="border-t border-border-subtle">
        <div className="mx-auto max-w-[720px] px-6 py-14 lg:px-10 lg:py-16">
          <Reveal>
            <h2 className="font-numeric flex items-center gap-3 border-b border-border pb-2.5 text-[10px] tracking-[0.14em] text-text-tertiary uppercase">The five chapters<span aria-hidden="true" className="h-px flex-1 bg-border-subtle" /></h2>
          </Reveal>
          <div className="mt-6 flex flex-col divide-y divide-border-subtle">
            {CHAPTERS.map((chapter) => (
              <Reveal key={chapter.number} className="py-6">
                <div className="flex items-baseline gap-3">
                  <span className="font-numeric text-[13px] text-text-tertiary">{chapter.number}</span>
                  <h3 className="text-[17px] font-semibold text-ink">{chapter.title}</h3>
                </div>
                <p className="mt-2 max-w-[62ch] text-[15px] leading-[1.6] text-text-secondary">{chapter.body}</p>
              </Reveal>
            ))}
          </div>
          <Reveal className="mt-6">
            <Link href="/#story" className="text-[14px] text-accent hover:underline">
              See it in the product →
            </Link>
          </Reveal>
        </div>
      </section>

      <section id="guides" className="border-t border-border-subtle bg-surface-sunken/40">
        <div className="mx-auto max-w-[1200px] px-6 py-16 lg:px-10">
          <Reveal>
            <EmptyState
              icon={<BookOpen size={24} />}
              title="Financial guides aren't published yet"
              description="Practical guidance on organizing your finances is planned for this section."
            />
          </Reveal>
        </div>
      </section>
    </MarketingShell>
  );
}
