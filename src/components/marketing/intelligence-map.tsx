import { MonthlyBarChart } from "@/components/charts/monthly-bar-chart";
import { CategoryBreakdown } from "@/components/charts/category-breakdown";
import { healthLabel } from "@/domain/insights/financial-health";
import { money } from "@/domain/money/money";

const CASH_FLOW = [
  { label: "Aug", income: money(880000, "USD"), expense: money(510000, "USD") },
  { label: "Sep", income: money(910000, "USD"), expense: money(470000, "USD") },
  { label: "Oct", income: money(870000, "USD"), expense: money(560000, "USD") },
  { label: "Nov", income: money(918200, "USD"), expense: money(412600, "USD") },
];

const CATEGORIES = [
  { categoryId: "software", categoryName: "Software", total: money(112400, "USD") },
  { categoryId: "dining", categoryName: "Dining", total: money(84200, "USD") },
  { categoryId: "travel", categoryName: "Travel", total: money(52100, "USD") },
];

/**
 * Financial intelligence section (product spec, DESIGN.md §10/§15).
 * Asymmetric bento — exactly three cells sized by information priority,
 * not the banned equal three-card grid — reusing the same chart
 * primitives the real dashboard renders, with static illustrative data.
 */
export function IntelligenceMap() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:grid-rows-2">
      <div className="rounded-md border border-border-subtle bg-surface p-6 lg:col-span-2 lg:row-span-2">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-ink">Cash flow</h3>
            <p className="text-[13px] text-text-secondary">Income and expenses, connected across every account</p>
          </div>
          <div className="flex items-center gap-3 text-[13px] text-text-secondary">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-positive" />
              Income
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-negative" />
              Expenses
            </span>
          </div>
        </div>
        <MonthlyBarChart data={CASH_FLOW} />
      </div>

      <div className="rounded-md border border-border-subtle bg-surface p-6">
        <h3 className="text-base font-semibold text-ink">Top categories</h3>
        <p className="mb-4 text-[13px] text-text-secondary">Where spending concentrates</p>
        <CategoryBreakdown items={CATEGORIES} />
      </div>

      <div className="rounded-md border border-border-subtle bg-surface p-6">
        <h3 className="text-base font-semibold text-ink">Financial health</h3>
        <p className="mb-3 text-[13px] text-text-secondary">Five weighted, explainable factors</p>
        <div className="flex items-baseline gap-2">
          <span className="font-numeric text-3xl font-medium text-ink">78</span>
          <span className="text-[13px] text-text-secondary">/ 100 — {healthLabel(78)}</span>
        </div>
      </div>
    </div>
  );
}
