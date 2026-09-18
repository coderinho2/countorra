import { type CurrencyCode, type Money, money } from "@/domain/money/money";

/**
 * Detects *probable* recurring payments (subscriptions, rent, utilities)
 * from transaction history — a statistical pattern match, not a fact the
 * system was told. Every result is labeled with how confident the match
 * is; nothing here is ever presented as "this IS a subscription" (product
 * spec §14: "Likely recurring", not false certainty).
 */

export interface TransactionForRecurrence {
  merchantId: string | null;
  merchantName: string;
  categoryId: string | null;
  amountMinor: number;
  currency: CurrencyCode;
  occurredOn: string; // YYYY-MM-DD
}

export type RecurrenceInterval = "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";

export interface RecurringPattern {
  merchantId: string | null;
  merchantName: string;
  categoryId: string | null;
  interval: RecurrenceInterval;
  averageAmount: Money;
  lastAmount: Money;
  /** Positive = price went up since the previous occurrence. */
  amountChangeMinor: number;
  occurrenceCount: number;
  lastOccurredOn: string;
  nextExpectedOn: string;
  annualizedCost: Money;
  /** 0–1. Below RECURRING_CONFIDENCE_THRESHOLD, a pattern is not returned
   *  at all rather than shown as low-confidence noise. */
  confidence: number;
}

const INTERVAL_DAYS: Record<RecurrenceInterval, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 91,
  annual: 365,
};

const RECURRING_CONFIDENCE_THRESHOLD = 0.6;
const MIN_OCCURRENCES = 3;

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

function closestInterval(avgGapDays: number): { interval: RecurrenceInterval; deviation: number } | null {
  let best: { interval: RecurrenceInterval; deviation: number } | null = null;
  for (const [interval, days] of Object.entries(INTERVAL_DAYS) as [RecurrenceInterval, number][]) {
    const deviation = Math.abs(avgGapDays - days) / days;
    if (deviation <= 0.25 && (!best || deviation < best.deviation)) {
      best = { interval, deviation };
    }
  }
  return best;
}

function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function detectRecurringPatterns(transactions: TransactionForRecurrence[]): RecurringPattern[] {
  const groups = new Map<string, TransactionForRecurrence[]>();
  for (const t of transactions) {
    if (!t.merchantId) continue; // can't detect recurrence without a stable merchant identity
    const key = t.merchantId;
    const group = groups.get(key) ?? [];
    group.push(t);
    groups.set(key, group);
  }

  const patterns: RecurringPattern[] = [];

  for (const group of groups.values()) {
    if (group.length < MIN_OCCURRENCES) continue;
    const sorted = [...group].sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));

    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(daysBetween(sorted[i - 1].occurredOn, sorted[i].occurredOn));
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const gapStddev = stddev(gaps);
    const intervalMatch = closestInterval(avgGap);
    if (!intervalMatch) continue;

    const amounts = sorted.map((t) => t.amountMinor);
    const avgAmount = Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length);
    const amountStddev = stddev(amounts);
    const amountConsistency = avgAmount === 0 ? 0 : 1 - Math.min(amountStddev / avgAmount, 1);

    // Confidence blends: how regular the timing is, how consistent the
    // amount is, and how many occurrences support the pattern.
    const timingConsistency = 1 - Math.min(gapStddev / INTERVAL_DAYS[intervalMatch.interval], 1);
    const occurrenceBonus = Math.min((sorted.length - MIN_OCCURRENCES) * 0.05, 0.2);
    const confidence = Math.min(timingConsistency * 0.5 + amountConsistency * 0.4 + occurrenceBonus, 1);

    if (confidence < RECURRING_CONFIDENCE_THRESHOLD) continue;

    const last = sorted[sorted.length - 1];
    const previous = sorted[sorted.length - 2];
    const currency = last.currency;
    const nextExpected = new Date(last.occurredOn);
    nextExpected.setUTCDate(nextExpected.getUTCDate() + INTERVAL_DAYS[intervalMatch.interval]);

    const occurrencesPerYear = 365 / INTERVAL_DAYS[intervalMatch.interval];

    patterns.push({
      merchantId: last.merchantId,
      merchantName: last.merchantName,
      categoryId: last.categoryId,
      interval: intervalMatch.interval,
      averageAmount: money(avgAmount, currency),
      lastAmount: money(last.amountMinor, currency),
      amountChangeMinor: last.amountMinor - previous.amountMinor,
      occurrenceCount: sorted.length,
      lastOccurredOn: last.occurredOn,
      nextExpectedOn: nextExpected.toISOString().slice(0, 10),
      annualizedCost: money(Math.round(avgAmount * occurrencesPerYear), currency),
      confidence: Math.round(confidence * 100) / 100,
    });
  }

  return patterns.sort((a, b) => b.annualizedCost.amountMinor - a.annualizedCost.amountMinor);
}
