import { type CurrencyCode, type Money, money } from "@/domain/money/money";
import type { RecurringPattern } from "./recurring-detection";

/**
 * Rule-based anomaly detection (product spec §19). Deliberately NOT
 * "everything unusual is an anomaly" — each rule has an explicit
 * threshold and every result carries a confidence, so the UI/AI can say
 * "3 possible anomalies" instead of asserting certainty the math doesn't
 * support. Written as independent, composable, pure functions so a
 * future statistical/ML method can replace one rule without touching the
 * others — see the module-level `detectAnomalies` combinator.
 */

export type AnomalyType =
  | "large_transaction"
  | "unusual_merchant"
  | "duplicate_transaction"
  | "category_spike"
  | "recurring_price_increase";

export interface Anomaly {
  type: AnomalyType;
  transactionId?: string;
  merchantName?: string;
  categoryId?: string | null;
  title: string;
  description: string;
  amount?: Money;
  /** 0–1. Callers should treat < 0.5 as "worth a footnote", not "worth a notification". */
  confidence: number;
  occurredOn?: string;
}

export interface TransactionForAnomalyDetection {
  id: string;
  merchantId: string | null;
  merchantName: string;
  categoryId: string | null;
  amountMinor: number;
  currency: CurrencyCode;
  occurredOn: string;
  kind: "income" | "expense" | "transfer";
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length);
}

/** Flags expenses more than ~2.5 standard deviations above the mean —
 *  skipped entirely for a merchant/category history too small (<5) to
 *  compute a meaningful standard deviation from. */
export function detectLargeTransactions(transactions: TransactionForAnomalyDetection[]): Anomaly[] {
  const expenses = transactions.filter((t) => t.kind === "expense");
  if (expenses.length < 5) return [];

  const amounts = expenses.map((t) => t.amountMinor);
  const avg = mean(amounts);
  const sd = stddev(amounts);
  if (sd === 0) return [];

  return expenses
    .filter((t) => t.amountMinor > avg + 2.5 * sd)
    .map((t) => {
      const deviations = (t.amountMinor - avg) / sd;
      return {
        type: "large_transaction" as const,
        transactionId: t.id,
        merchantName: t.merchantName,
        categoryId: t.categoryId,
        title: "Unusually large transaction",
        description: `${t.merchantName} was significantly larger than your typical expense.`,
        amount: money(t.amountMinor, t.currency),
        confidence: Math.min(0.5 + deviations / 10, 0.95),
        occurredOn: t.occurredOn,
      };
    });
}

/** Flags a first-time merchant whose transaction is well above the
 *  average transaction size — a new, large expense is worth a second
 *  look; a new $4 coffee shop is not. `knownMerchantIds` is the set seen
 *  *before* the window being analyzed (pass prior-period history). */
export function detectUnusualMerchants(
  transactions: TransactionForAnomalyDetection[],
  knownMerchantIds: ReadonlySet<string>,
): Anomaly[] {
  const expenses = transactions.filter((t) => t.kind === "expense");
  if (expenses.length === 0) return [];
  const avg = mean(expenses.map((t) => t.amountMinor));
  if (avg === 0) return [];

  return expenses
    .filter((t) => t.merchantId && !knownMerchantIds.has(t.merchantId) && t.amountMinor > avg * 2)
    .map((t) => ({
      type: "unusual_merchant" as const,
      transactionId: t.id,
      merchantName: t.merchantName,
      categoryId: t.categoryId,
      title: "New merchant, larger than usual",
      description: `First transaction from ${t.merchantName}, above your average expense size.`,
      amount: money(t.amountMinor, t.currency),
      confidence: 0.6,
      occurredOn: t.occurredOn,
    }));
}

/** Flags same-merchant, same-amount transactions within 2 days of each
 *  other — the classic "accidentally charged twice" pattern. Confidence
 *  is intentionally capped below 1: it may be two genuinely separate
 *  purchases. */
export function detectDuplicateTransactions(transactions: TransactionForAnomalyDetection[]): Anomaly[] {
  const expenses = [...transactions.filter((t) => t.kind === "expense")].sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
  const anomalies: Anomaly[] = [];
  const flagged = new Set<string>();

  for (let i = 0; i < expenses.length; i++) {
    for (let j = i + 1; j < expenses.length; j++) {
      const a = expenses[i];
      const b = expenses[j];
      const gapDays = (new Date(b.occurredOn).getTime() - new Date(a.occurredOn).getTime()) / 86_400_000;
      if (gapDays > 2) break; // sorted by date — nothing further out can be within range
      if (a.merchantId && a.merchantId === b.merchantId && a.amountMinor === b.amountMinor && !flagged.has(b.id)) {
        flagged.add(b.id);
        anomalies.push({
          type: "duplicate_transaction",
          transactionId: b.id,
          merchantName: b.merchantName,
          categoryId: b.categoryId,
          title: "Possible duplicate charge",
          description: `Same amount from ${b.merchantName} within ${Math.round(gapDays * 10) / 10} day(s) of another transaction.`,
          amount: money(b.amountMinor, b.currency),
          confidence: 0.65,
          occurredOn: b.occurredOn,
        });
      }
    }
  }
  return anomalies;
}

/** Flags a category whose current-period spend is well above its
 *  historical baseline. `baselineAverages` is per-category average spend
 *  for prior comparable periods — computed by the caller (typically a
 *  rolling 3-month average), not by this function, so this stays a pure
 *  comparison with no I/O or date-window logic of its own. */
export function detectCategorySpikes(
  currentPeriodTransactions: TransactionForAnomalyDetection[],
  baselineAverages: ReadonlyMap<string, Money>,
): Anomaly[] {
  const totals = new Map<string, number>();
  const currency = currentPeriodTransactions[0]?.currency;
  for (const t of currentPeriodTransactions) {
    if (t.kind !== "expense" || !t.categoryId) continue;
    totals.set(t.categoryId, (totals.get(t.categoryId) ?? 0) + t.amountMinor);
  }

  const anomalies: Anomaly[] = [];
  for (const [categoryId, total] of totals) {
    const baseline = baselineAverages.get(categoryId);
    if (!baseline || baseline.amountMinor === 0) continue;
    const ratio = total / baseline.amountMinor;
    if (ratio < 1.5) continue;
    anomalies.push({
      type: "category_spike",
      categoryId,
      title: "Spending increase in a category",
      description: `This category is running ${Math.round((ratio - 1) * 100)}% above its recent average.`,
      amount: currency ? money(total, currency) : undefined,
      confidence: Math.min(0.4 + (ratio - 1.5) * 0.2, 0.9),
    });
  }
  return anomalies;
}

/** Flags a recurring payment whose price just went up meaningfully
 *  (>5%) — reuses recurring-detection's output rather than
 *  re-deriving pattern matching here. */
export function detectRecurringPriceIncreases(patterns: RecurringPattern[]): Anomaly[] {
  return patterns
    .filter((p) => p.amountChangeMinor > 0 && p.amountChangeMinor / (p.lastAmount.amountMinor - p.amountChangeMinor) > 0.05)
    .map((p) => ({
      type: "recurring_price_increase" as const,
      merchantName: p.merchantName,
      categoryId: p.categoryId,
      title: "A recurring payment increased",
      description: `${p.merchantName} increased by ${money(p.amountChangeMinor, p.lastAmount.currency).amountMinor > 0 ? "+" : ""}${p.amountChangeMinor / 100} ${p.lastAmount.currency} since last time.`,
      amount: p.lastAmount,
      confidence: p.confidence,
      occurredOn: p.lastOccurredOn,
    }));
}

export function detectAnomalies(input: {
  transactions: TransactionForAnomalyDetection[];
  knownMerchantIds: ReadonlySet<string>;
  categoryBaselines: ReadonlyMap<string, Money>;
  recurringPatterns: RecurringPattern[];
}): Anomaly[] {
  return [
    ...detectLargeTransactions(input.transactions),
    ...detectUnusualMerchants(input.transactions, input.knownMerchantIds),
    ...detectDuplicateTransactions(input.transactions),
    ...detectCategorySpikes(input.transactions, input.categoryBaselines),
    ...detectRecurringPriceIncreases(input.recurringPatterns),
  ].sort((a, b) => b.confidence - a.confidence);
}
