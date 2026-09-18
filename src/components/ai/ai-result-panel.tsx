import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ToolResultSummary } from "@/server/ai/actions";

/**
 * Product spec §6: financial answers should render as part of the product
 * — a stat, a table, a badge — never a wall of AI markdown or raw JSON.
 * With ~35 tools, this deliberately does NOT special-case every tool by
 * name; it pattern-matches the handful of *shapes* tool output actually
 * takes (a single money result, a income/expense/profit composite, a
 * comparison, a recurring-charges list, a named-money list, a
 * transaction-like list) and renders whichever one matches. An
 * unrecognized shape renders nothing extra — the AI's text answer already
 * covers it, and this never had a JSON-dump fallback in the first place.
 */

interface MoneyResult {
  amountMinor: number;
  currency: string;
  formatted: string;
}

function isMoneyResult(v: unknown): v is MoneyResult {
  return !!v && typeof v === "object" && typeof (v as Record<string, unknown>).formatted === "string" && typeof (v as Record<string, unknown>).amountMinor === "number";
}

/**
 * A figure the assistant computed.
 *
 * Set at DESIGN.md §4's "Numeric — prominent total" scale (22/28, -0.01em,
 * Geist Mono) — the same treatment the dashboard gives its secondary
 * metrics. That is the point of §14's rule that the assistant's numbers must
 * look like the app's numbers: a figure quoted in a conversation and a figure
 * on the dashboard are the same fact, and typography is what says so.
 */
function Stat({ label, value, tone }: { label: string; value: string; tone?: "positive" | "negative" }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[12px] text-text-tertiary">{label}</span>
      <span
        className={`font-numeric text-[22px] leading-7 font-medium tracking-[-0.01em] ${
          tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : "text-ink"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function ChangeBadge({ percent }: { percent: number }) {
  const positive = percent >= 0;
  return (
    <Badge variant={positive ? "positive" : "negative"}>
      {positive ? "+" : ""}
      {percent.toFixed(1)}%
    </Badge>
  );
}

function ProfitAndLossResult({ output }: { output: Record<string, unknown> }) {
  const income = output.income;
  const expense = output.expense;
  const profit = output.profit;
  if (!isMoneyResult(income) || !isMoneyResult(expense) || !isMoneyResult(profit)) return null;
  return (
    <div className="flex flex-wrap gap-x-10 gap-y-5">
      <Stat label="Income" value={income.formatted} />
      <Stat label="Expenses" value={expense.formatted} />
      <Stat label="Profit" value={profit.formatted} tone={profit.amountMinor >= 0 ? "positive" : "negative"} />
      {typeof output.marginPercent === "number" && <Stat label="Margin" value={`${output.marginPercent.toFixed(1)}%`} />}
    </div>
  );
}

function ComparePeriodsResult({ output }: { output: Record<string, unknown> }) {
  const current = output.current as Record<string, unknown> | undefined;
  const previous = output.previous as Record<string, unknown> | undefined;
  if (!current || !previous || !isMoneyResult(current.profit) || !isMoneyResult(previous.profit)) return null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-10 gap-y-5">
        <Stat label="This period" value={(current.profit as MoneyResult).formatted} tone={(current.profit as MoneyResult).amountMinor >= 0 ? "positive" : "negative"} />
        <Stat label="Prior period" value={(previous.profit as MoneyResult).formatted} />
      </div>
      <div className="flex gap-2">
        {typeof output.incomePercentChange === "number" && (
          <span className="flex items-center gap-1.5 text-[13px] text-text-secondary">
            Income <ChangeBadge percent={output.incomePercentChange} />
          </span>
        )}
        {typeof output.expensePercentChange === "number" && (
          <span className="flex items-center gap-1.5 text-[13px] text-text-secondary">
            Expenses <ChangeBadge percent={output.expensePercentChange} />
          </span>
        )}
      </div>
    </div>
  );
}

function FinancialOverviewResult({ output }: { output: Record<string, unknown> }) {
  const totalBalance = output.totalBalance;
  const thisMonth = output.thisMonth as Record<string, unknown> | undefined;
  if (!isMoneyResult(totalBalance) || !thisMonth || !isMoneyResult(thisMonth.income) || !isMoneyResult(thisMonth.expense)) return null;
  return (
    <div className="flex flex-wrap gap-x-10 gap-y-5">
      <Stat label="Total balance" value={totalBalance.formatted} />
      <Stat label="Income (30d)" value={(thisMonth.income as MoneyResult).formatted} />
      <Stat label="Expenses (30d)" value={(thisMonth.expense as MoneyResult).formatted} />
    </div>
  );
}

function RecurringListResult({ items }: { items: Record<string, unknown>[] }) {
  const rows = items.filter((r) => typeof r.merchantName === "string" && isMoneyResult(r.annualizedCost) && typeof r.label === "string");
  if (rows.length === 0) return null;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Merchant</TableHead>
          <TableHead>Interval</TableHead>
          <TableHead numeric>Annual cost</TableHead>
          <TableHead>Confidence</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.slice(0, 8).map((r, i) => (
          <TableRow key={i}>
            <TableCell>{String(r.merchantName)}</TableCell>
            <TableCell>{String(r.interval ?? "—")}</TableCell>
            <TableCell numeric>{(r.annualizedCost as MoneyResult).formatted}</TableCell>
            <TableCell>
              <Badge variant={r.label === "Likely recurring" ? "positive" : "neutral"}>{String(r.label)}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function NamedMoneyListResult({ items }: { items: Record<string, unknown>[] }) {
  const rows = items.filter((r) => typeof r.name === "string" && isMoneyResult(r as unknown));
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {rows.slice(0, 8).map((r, i) => (
        <div key={i} className="flex items-center justify-between border-b border-border-subtle py-1.5 last:border-0">
          <span className="text-[13px] text-text-secondary">{String(r.name)}</span>
          <span className="font-numeric text-[13px] text-text-primary">{(r as unknown as MoneyResult).formatted}</span>
        </div>
      ))}
    </div>
  );
}

function TransactionListResult({ items }: { items: Record<string, unknown>[] }) {
  const rows = items.filter((r) => typeof r.occurredOn === "string" && typeof r.amountMinor === "number" && typeof r.currency === "string");
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Description</TableHead>
            <TableHead numeric>Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.slice(0, 8).map((r, i) => (
            <TableRow key={i}>
              <TableCell>{String(r.occurredOn)}</TableCell>
              <TableCell>{typeof r.description === "string" && r.description ? r.description : "—"}</TableCell>
              <TableCell numeric className={r.kind === "income" ? "text-positive" : undefined}>
                {r.kind === "income" ? "+" : r.kind === "expense" ? "−" : ""}
                {new Intl.NumberFormat("en-US", { style: "currency", currency: String(r.currency) }).format(Math.abs(Number(r.amountMinor)) / 100)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length > 8 && <p className="text-[13px] text-text-tertiary">+{rows.length - 8} more</p>}
    </div>
  );
}

function renderResult(result: ToolResultSummary, index: number) {
  const output = result.output;
  if (!output || typeof output !== "object") return null;
  const record = output as Record<string, unknown>;

  if (isMoneyResult(output) && !Array.isArray(output)) {
    return <Stat key={index} label="Result" value={(output as MoneyResult).formatted} />;
  }
  if ("income" in record && "expense" in record && "profit" in record) {
    return <ProfitAndLossResult key={index} output={record} />;
  }
  if ("current" in record && "previous" in record) {
    return <ComparePeriodsResult key={index} output={record} />;
  }
  if ("totalBalance" in record && "thisMonth" in record) {
    return <FinancialOverviewResult key={index} output={record} />;
  }
  if (Array.isArray(output) && output.length > 0 && typeof output[0] === "object") {
    const items = output as Record<string, unknown>[];
    return (
      <div key={index} className="flex flex-col gap-2">
        <RecurringListResult items={items} />
        <NamedMoneyListResult items={items} />
        <TransactionListResult items={items} />
      </div>
    );
  }
  if (Array.isArray(record.transactions)) {
    return <TransactionListResult key={index} items={record.transactions as Record<string, unknown>[]} />;
  }
  return null;
}

export function AiResultPanel({ results }: { results: ToolResultSummary[] }) {
  const rendered = results.map(renderResult).filter(Boolean);
  if (rendered.length === 0) return null;
  // A ruled band, not a tinted box. The results are part of the answer, so
  // they sit in the same column as the prose with a rule above and below; an
  // inset grey card would read as a quotation from somewhere else.
  return <div className="mt-1 mb-4 flex max-w-[70ch] flex-col gap-5 border-y border-border-subtle py-4">{rendered}</div>;
}
