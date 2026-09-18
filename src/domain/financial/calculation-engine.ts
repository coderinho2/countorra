import { type CurrencyCode, type Money, add, money, subtract, sum, zero } from "@/domain/money/money";
import { totalInBaseCurrency, type ExcludedCurrency } from "@/domain/money/aggregate";

/**
 * The deterministic core of DESIGN brief §10's pipeline:
 *
 *   user request → AI interpretation → structured operation →
 *   CALCULATION ENGINE → verified result → AI explanation
 *
 * Every function here is pure — no I/O, no AI, just arithmetic over
 * already-fetched rows — which is what makes it unit-testable and what
 * makes it safe to say "the AI never computes a financial number itself."
 * A caller (a Server Component, a Route Handler, or an AI tool in
 * src/domain/ai/tools) fetches rows via a repository and hands them to
 * these functions; the AI only ever sees the result, never derives it.
 *
 * Transfers are excluded from every aggregate below — a transfer between
 * two of the organization's own accounts is not income or expense, and
 * including it would double-count money that never left the organization.
 */

export interface TransactionForCalculation {
  kind: "income" | "expense" | "transfer";
  amountMinor: number;
  currency: CurrencyCode;
  categoryId: string | null;
}

function toMoney(t: TransactionForCalculation): Money {
  return { amountMinor: t.amountMinor, currency: t.currency };
}

export function calculateTotalByKind(
  transactions: TransactionForCalculation[],
  kind: "income" | "expense",
  currency: CurrencyCode,
): Money {
  return sum(
    transactions.filter((t) => t.kind === kind).map(toMoney),
    currency,
  );
}

/** Income minus expenses over the given transactions. Not tax profit — see
 *  src/domain/tax for that; this is cash-basis operating profit only. */
export function calculateProfit(transactions: TransactionForCalculation[], currency: CurrencyCode): Money {
  const income = calculateTotalByKind(transactions, "income", currency);
  const expense = calculateTotalByKind(transactions, "expense", currency);
  return subtract(income, expense);
}

/** Alias of calculateProfit under the name DESIGN brief §13's example tool
 *  list uses — kept distinct so a future divergence (e.g. cash flow
 *  including financing activity) doesn't require renaming call sites. */
export function calculateNetCashFlow(transactions: TransactionForCalculation[], currency: CurrencyCode): Money {
  return calculateProfit(transactions, currency);
}

export interface CategoryTotal {
  categoryId: string | null;
  total: Money;
}

export function calculateSpendByCategory(
  transactions: TransactionForCalculation[],
  currency: CurrencyCode,
): CategoryTotal[] {
  const expenses = transactions.filter((t) => t.kind === "expense");
  const totals = new Map<string | null, Money>();

  for (const t of expenses) {
    const running = totals.get(t.categoryId) ?? zero(currency);
    totals.set(t.categoryId, add(running, toMoney(t)));
  }

  return [...totals.entries()]
    .map(([categoryId, total]) => ({ categoryId, total }))
    .sort((a, b) => b.total.amountMinor - a.total.amountMinor);
}

/** Profit margin as a percentage of income: `profit / income * 100`.
 *  `null` when income is zero — a margin is undefined, not zero, when
 *  there's nothing to divide by. */
export function calculateMargin(transactions: TransactionForCalculation[], currency: CurrencyCode): number | null {
  const income = calculateTotalByKind(transactions, "income", currency);
  if (income.amountMinor === 0) return null;
  const profit = calculateProfit(transactions, currency);
  return Math.round((profit.amountMinor / income.amountMinor) * 10_000) / 100;
}

export interface PeriodSummary {
  income: Money;
  expense: Money;
  profit: Money;
}

export interface PeriodComparison {
  current: PeriodSummary;
  previous: PeriodSummary;
  incomeChangeMinor: number;
  expenseChangeMinor: number;
  profitChangeMinor: number;
  /** Percent change vs. the previous period; `null` when the previous
   *  period's value was zero (percent change is undefined, not infinite). */
  incomePercentChange: number | null;
  expensePercentChange: number | null;
}

function summarize(transactions: TransactionForCalculation[], currency: CurrencyCode): PeriodSummary {
  return {
    income: calculateTotalByKind(transactions, "income", currency),
    expense: calculateTotalByKind(transactions, "expense", currency),
    profit: calculateProfit(transactions, currency),
  };
}

function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

export function comparePeriods(
  currentPeriodTransactions: TransactionForCalculation[],
  previousPeriodTransactions: TransactionForCalculation[],
  currency: CurrencyCode,
): PeriodComparison {
  const current = summarize(currentPeriodTransactions, currency);
  const previous = summarize(previousPeriodTransactions, currency);
  return {
    current,
    previous,
    incomeChangeMinor: current.income.amountMinor - previous.income.amountMinor,
    expenseChangeMinor: current.expense.amountMinor - previous.expense.amountMinor,
    profitChangeMinor: current.profit.amountMinor - previous.profit.amountMinor,
    incomePercentChange: percentChange(current.income.amountMinor, previous.income.amountMinor),
    expensePercentChange: percentChange(current.expense.amountMinor, previous.expense.amountMinor),
  };
}

// ── Pre-aggregated input (FIN-01) ────────────────────────────────────────
//
// Everything above takes a list of transaction rows. That was the only shape
// available while aggregation happened in JavaScript, and it is exactly what
// PostgREST's silent 1000-row cap corrupted: the arithmetic was always right,
// it was just given the first thousand rows of a larger set.
//
// `transaction_totals` (supabase/migrations/0027) now does the summation in
// Postgres, in exact bigint, over the whole set. The functions below are the
// deterministic layer for that shape — the engine is still the only place
// financial *meaning* is assigned (what profit is, what a margin is, what a
// period comparison is); SQL only did the addition, the way `sum()` in
// src/domain/money does it one layer up.
//
// The row-list functions above are kept and still used wherever the caller
// genuinely holds rows. Neither shape is a fallback for the other.

/** One (currency, kind) group as returned by `transaction_totals`. */
export interface TransactionTotalRow {
  currency: CurrencyCode;
  kind: "income" | "expense" | "transfer";
  totalMinor: number;
  transactionCount: number;
  unreviewedCount: number;
}

export interface AggregateSummary extends PeriodSummary {
  /** Rows counted toward the figures above — base-currency rows only. */
  transactionCount: number;
  unreviewedCount: number;
  /** Currencies present in the period that were deliberately left out. Never
   *  converted; see src/domain/money/aggregate.ts. */
  excluded: ExcludedCurrency[];
}

/**
 * Collapses `transaction_totals` rows into income/expense/profit in the
 * organization's base currency.
 *
 * Transfers are dropped here for the same reason they are dropped from every
 * aggregate above: moving money between two of the organization's own accounts
 * is neither income nor expense, and counting it would double-count money that
 * never left.
 */
export function summarizeTotals(rows: TransactionTotalRow[], baseCurrency: CurrencyCode): AggregateSummary {
  const relevant = rows.filter((r) => r.kind !== "transfer");

  const income = totalInBaseCurrency(
    relevant.filter((r) => r.kind === "income").map((r) => ({ amountMinor: r.totalMinor, currency: r.currency })),
    baseCurrency,
  );
  const expense = totalInBaseCurrency(
    relevant.filter((r) => r.kind === "expense").map((r) => ({ amountMinor: r.totalMinor, currency: r.currency })),
    baseCurrency,
  );

  const inBase = relevant.filter((r) => r.currency === baseCurrency);

  // One excluded-currency list across both kinds, deduplicated: a reader cares
  // that EUR was left out of "this period", not that it was left out of the
  // income line and the expense line separately.
  const excludedCounts = new Map<CurrencyCode, number>();
  for (const row of relevant) {
    if (row.currency === baseCurrency) continue;
    excludedCounts.set(row.currency, (excludedCounts.get(row.currency) ?? 0) + row.transactionCount);
  }

  return {
    income: income.total,
    expense: expense.total,
    profit: subtract(income.total, expense.total),
    transactionCount: inBase.reduce((n, r) => n + r.transactionCount, 0),
    unreviewedCount: inBase.reduce((n, r) => n + r.unreviewedCount, 0),
    excluded: [...excludedCounts.entries()]
      .map(([currency, count]) => ({ currency, count }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}

/** Margin over pre-aggregated totals. Same rule as `calculateMargin`:
 *  undefined (null), not zero, when there is no income to divide by. */
export function marginFromTotals(rows: TransactionTotalRow[], baseCurrency: CurrencyCode): number | null {
  const summary = summarizeTotals(rows, baseCurrency);
  if (summary.income.amountMinor === 0) return null;
  return Math.round((summary.profit.amountMinor / summary.income.amountMinor) * 10_000) / 100;
}

/** Period comparison over pre-aggregated totals. */
export function comparePeriodTotals(
  currentRows: TransactionTotalRow[],
  previousRows: TransactionTotalRow[],
  baseCurrency: CurrencyCode,
): PeriodComparison {
  const current = summarizeTotals(currentRows, baseCurrency);
  const previous = summarizeTotals(previousRows, baseCurrency);
  return {
    current: { income: current.income, expense: current.expense, profit: current.profit },
    previous: { income: previous.income, expense: previous.expense, profit: previous.profit },
    incomeChangeMinor: current.income.amountMinor - previous.income.amountMinor,
    expenseChangeMinor: current.expense.amountMinor - previous.expense.amountMinor,
    profitChangeMinor: current.profit.amountMinor - previous.profit.amountMinor,
    incomePercentChange: percentChange(current.income.amountMinor, previous.income.amountMinor),
    expensePercentChange: percentChange(current.expense.amountMinor, previous.expense.amountMinor),
  };
}

/** One (category, currency) group as returned by `transaction_category_totals`. */
export interface CategoryTotalRow {
  categoryId: string | null;
  currency: CurrencyCode;
  totalMinor: number;
}

/**
 * Spend by category in the base currency, largest first. Foreign-currency
 * groups are excluded rather than merged into a same-named category — a
 * "Software €400" row silently folded into "Software $400" would be the same
 * fabrication as a mixed grand total, just harder to spot.
 */
export function spendByCategoryFromTotals(rows: CategoryTotalRow[], baseCurrency: CurrencyCode): CategoryTotal[] {
  return rows
    .filter((r) => r.currency === baseCurrency)
    .map((r) => ({ categoryId: r.categoryId, total: money(r.totalMinor, baseCurrency) }))
    .sort((a, b) => b.total.amountMinor - a.total.amountMinor);
}
