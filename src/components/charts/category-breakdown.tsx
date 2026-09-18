import { format, type Money } from "@/domain/money/money";
import { EmptyState } from "@/components/ui/empty-state";

export interface CategoryBreakdownItem {
  categoryId: string | null;
  categoryName: string;
  total: Money;
}

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--color-chart-6)",
];

/**
 * DESIGN.md §12 categorical palette, flat fills, no pie chart.
 *
 * The bar length was previously scaled against the largest category, which
 * makes the top category always a full bar and tells the reader nothing —
 * every breakdown looks identical regardless of how concentrated the
 * spending actually is. Scaling against the *total* instead means the bar
 * length is the share, and a category that is half of all spending looks
 * like half. The share is also printed, because a 14%-wide bar is not
 * something anyone can read a number off.
 */
export function CategoryBreakdown({ items }: { items: CategoryBreakdownItem[] }) {
  if (items.length === 0) {
    return <EmptyState title="No spending yet" description="Categorized expenses will show up here." />;
  }

  const total = items.reduce((sum, item) => sum + item.total.amountMinor, 0) || 1;

  return (
    <ul className="flex flex-col">
      {items.map((item, i) => {
        const share = (item.total.amountMinor / total) * 100;
        return (
          <li key={item.categoryId ?? "uncategorized"} className="flex flex-col gap-1.5 border-b border-border-subtle py-2.5 last:border-0 last:pb-0 first:pt-0">
            <div className="flex items-baseline justify-between gap-4 text-[13px]">
              <span className="truncate text-text-primary">{item.categoryName}</span>
              <span className="flex shrink-0 items-baseline gap-2">
                <span className="font-numeric text-text-tertiary">{share.toFixed(0)}%</span>
                <span className="font-numeric text-text-primary">{format(item.total)}</span>
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-pill bg-surface-sunken">
              <div className="h-full rounded-pill" style={{ width: `${Math.max(share, 1)}%`, backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
