import { toMajorUnits, type Money } from "@/domain/money/money";
import { EmptyState } from "@/components/ui/empty-state";

export interface MonthlyBarChartDatum {
  label: string;
  income: Money;
  expense: Money;
}

/**
 * DESIGN.md §12: flat fills (no gradients), horizontal gridlines only,
 * income/expense use the semantic positive/negative tokens rather than the
 * categorical chart palette — direction (money in vs. out) is exactly what
 * those tokens exist to communicate. Renders a real empty state instead of a
 * fake chart when there is no data.
 *
 * The Phase 2 pass added the parts that make it a chart rather than a
 * picture of one: a value axis, gridlines that are labelled instead of
 * decorative, and a solid baseline. §12 asks for labelled axes in
 * `--color-text-tertiary` at the Small scale, and without them a reader can
 * see that March was taller than April but not by how much — which is the
 * only question a cash-flow chart exists to answer.
 *
 * Per-bar `<title>` elements give the native browser tooltip on hover. That
 * is deliberate rather than a JS tooltip: it keeps this a Server Component,
 * it works on keyboard focus and in assistive tech, and DESIGN.md §12's
 * tooltip spec is for the interactive charting this product does not need
 * yet. Faking a richer tooltip would cost the whole page a client boundary.
 */
export function MonthlyBarChart({ data }: { data: MonthlyBarChartDatum[] }) {
  const hasData = data.some((d) => d.income.amountMinor > 0 || d.expense.amountMinor > 0);
  if (!hasData) {
    return <EmptyState title="No activity yet" description="Income and expenses will appear here once you have transactions." />;
  }

  const width = 720;
  const height = 240;
  const paddingLeft = 52; // room for the value axis
  const paddingBottom = 26; // room for the month labels
  const paddingTop = 8;
  const chartBottom = height - paddingBottom;
  const plotHeight = chartBottom - paddingTop;

  const rawMax = Math.max(...data.map((d) => Math.max(d.income.amountMinor, d.expense.amountMinor)), 1);
  // Round the axis up to a clean step so the labels read as round numbers
  // rather than as whatever the tallest bar happened to be.
  const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(rawMax)) - 1);
  const maxValue = Math.ceil(rawMax / magnitude) * magnitude;

  const currency = data[0].income.currency;
  const axisTicks = [0, 0.5, 1];
  const compact = new Intl.NumberFormat("en-US", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 });

  const groupWidth = (width - paddingLeft) / data.length;
  const barWidth = Math.min(groupWidth * 0.26, 20);
  const y = (amountMinor: number) => chartBottom - (amountMinor / maxValue) * plotHeight;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Monthly income and expenses over the last six months">
      {axisTicks.map((fraction) => {
        const lineY = chartBottom - fraction * plotHeight;
        return (
          <g key={fraction}>
            <line
              x1={paddingLeft}
              x2={width}
              y1={lineY}
              y2={lineY}
              stroke={fraction === 0 ? "var(--color-border)" : "var(--color-border-subtle)"}
              strokeWidth={1}
            />
            <text x={paddingLeft - 10} y={lineY + 4} textAnchor="end" fontSize={11} fill="var(--color-text-tertiary)" className="font-numeric">
              {compact.format(toMajorUnits({ amountMinor: Math.round(maxValue * fraction), currency }))}
            </text>
          </g>
        );
      })}

      {data.map((d, i) => {
        const groupX = paddingLeft + i * groupWidth + groupWidth / 2;
        const incomeTop = y(d.income.amountMinor);
        const expenseTop = y(d.expense.amountMinor);
        return (
          <g key={d.label}>
            <rect x={groupX - barWidth - 2} y={incomeTop} width={barWidth} height={Math.max(0, chartBottom - incomeTop)} rx={2} fill="var(--color-positive)">
              <title>{`${d.label} income: ${new Intl.NumberFormat("en-US", { style: "currency", currency }).format(toMajorUnits(d.income))}`}</title>
            </rect>
            <rect x={groupX + 2} y={expenseTop} width={barWidth} height={Math.max(0, chartBottom - expenseTop)} rx={2} fill="var(--color-negative)">
              <title>{`${d.label} expenses: ${new Intl.NumberFormat("en-US", { style: "currency", currency }).format(toMajorUnits(d.expense))}`}</title>
            </rect>
            <text x={groupX} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--color-text-tertiary)">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function monthlyChartSummary(data: MonthlyBarChartDatum[]) {
  const totalIncome = data.reduce((sum, d) => sum + d.income.amountMinor, 0);
  const totalExpense = data.reduce((sum, d) => sum + d.expense.amountMinor, 0);
  return { totalIncome, totalExpense };
}

export function moneyMajor(value: Money): number {
  return toMajorUnits(value);
}
