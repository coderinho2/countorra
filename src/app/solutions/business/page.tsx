import type { Metadata } from "next";
import { PersonaPage } from "@/components/marketing/persona-page";
import { SEGMENTS } from "@/components/marketing/segments-data";
import { StatBlock } from "@/components/stat-block";
import { CategoryBreakdown } from "@/components/charts/category-breakdown";
import { money } from "@/domain/money/money";

export const metadata: Metadata = {
  title: "Business — Countorra",
  description: "Revenue, customers, and financial performance in one system.",
};

const EXPENSE_CATEGORIES = [
  { categoryId: "payroll", categoryName: "Contractors", total: money(840000, "USD") },
  { categoryId: "software", categoryName: "Software", total: money(112400, "USD") },
  { categoryId: "office", categoryName: "Office", total: money(46200, "USD") },
];

export default function BusinessSolutionPage() {
  const segment = SEGMENTS.find((s) => s.key === "business")!;
  return (
    <PersonaPage
      segment={segment}
      emphasis={{
        label: "The question",
        title: "Is the business performing the way I think it is?",
        body: "One place where revenue, spend and receivables reconcile against each other, so a monthly review is reading a position rather than assembling one from four exports.",
      }}
      visual={
        <div className="overflow-hidden rounded-md border border-border-subtle bg-surface">
          {/* The same asymmetric position band the real dashboard uses:
              one figure that outweighs the others, on a ruled strip. */}
          <div className="flex flex-col gap-5 p-6 max-[359px]:p-4 sm:p-8">
            <StatBlock label="Revenue this month" value={money(1842000, "USD")} size="hero" />
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-t max-[359px]:grid-cols-1 border-border-subtle pt-5 sm:grid-cols-3 sm:gap-x-0 sm:divide-x sm:divide-border-subtle">
              <div className="sm:pr-8">
                <StatBlock label="Expenses this month" value={money(998600, "USD")} />
              </div>
              <div className="sm:px-8">
                <StatBlock label="Outstanding invoices" value={money(324000, "USD")} />
              </div>
              <div className="sm:px-8">
                <StatBlock label="Profit this month" value={money(843400, "USD")} />
              </div>
            </div>
          </div>
          <div className="border-t border-border-subtle p-6 max-[359px]:p-4 sm:p-8">
            <p className="mb-5 text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">Top expense categories</p>
            <CategoryBreakdown items={EXPENSE_CATEGORIES} />
          </div>
        </div>
      }
    />
  );
}
