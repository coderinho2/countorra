import { money, type Money } from "@/domain/money/money";
import type { CurrencyCode } from "@/domain/money/currency";
import type { ForecastPoint } from "./forecasting";

/**
 * "Can I afford this?" — answered by arithmetic, never by the model.
 *
 * It starts from the SAME projection `forecastCashFlow` produces (today's
 * balances, the recent daily net, and the recurring payments detected in the
 * person's own history), takes the purchase out of every projected day on or
 * after it is paid, and asks one question: what is the lowest the balance gets?
 *
 *   NOT_AFFORDABLE     the balance goes below zero at some point
 *   TIGHT              it stays above zero but dips under the safety buffer
 *                      (one month of the person's average spending)
 *   AFFORDABLE         it never dips under the buffer
 *   INSUFFICIENT_DATA  no accounts or no projection — nothing is guessed
 *
 * What it does NOT know is stated in `assumptions`, because a verdict without
 * its limits is advice nobody can check: it does not know about savings goals
 * or budgets Countorra has no record of, one-off bills that have never
 * happened before, or income that is not in the history.
 */

export type PurchaseFrequency = "ONE_TIME" | "MONTHLY";

export interface AffordabilityInput {
  currency: CurrencyCode;
  /** From `forecastCashFlow`, first point = today. */
  forecast: readonly ForecastPoint[];
  amountMinor: number;
  frequency: PurchaseFrequency;
  /** YYYY-MM-DD; the first (or only) payment. */
  firstPaymentOn: string;
  /** One month of average spending, from the person's own history. */
  safetyBufferMinor: number;
  /** Accounts with a balance in the base currency. */
  accountCount: number;
}

export type AffordabilityVerdict = "AFFORDABLE" | "TIGHT" | "NOT_AFFORDABLE" | "INSUFFICIENT_DATA";

export interface AffordabilityResult {
  verdict: AffordabilityVerdict;
  reason: string;
  currentBalance: Money | null;
  lowestWithout: { date: string; balance: Money } | null;
  lowestWith: { date: string; balance: Money } | null;
  /** How far the lowest point stays above the buffer (negative = below it). */
  headroomAboveBuffer: Money | null;
  safetyBuffer: Money;
  /** Total the purchase takes out within the projection window. */
  totalPaidInWindow: Money;
  paymentsInWindow: number;
  windowEnd: string | null;
  assumptions: readonly string[];
}

const ASSUMPTIONS = [
  "Projected from the accounts and transaction history in Countorra only; accounts that are not in Countorra are not counted.",
  "Recurring payments and income are the ones detected in your history; a bill or paycheck that has never appeared before is not included.",
  "Savings goals, budgets and planned purchases are not deducted unless they already show up as recurring transactions.",
  "The safety buffer is one month of your average spending over the last three months.",
];

/** Date-only month arithmetic in UTC, clamped to the month's last day. */
function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Payment dates on or before `until`. */
export function paymentDates(frequency: PurchaseFrequency, firstPaymentOn: string, until: string): string[] {
  if (firstPaymentOn > until) return [];
  if (frequency === "ONE_TIME") return [firstPaymentOn];
  const dates: string[] = [];
  for (let i = 0; i < 1000; i++) {
    const next = addMonths(firstPaymentOn, i);
    if (next > until) break;
    dates.push(next);
  }
  return dates;
}

function lowest(points: readonly { date: string; balanceMinor: number }[]) {
  return points.reduce<{ date: string; balanceMinor: number } | null>((low, p) => (low === null || p.balanceMinor < low.balanceMinor ? p : low), null);
}

export function assessAffordability(input: AffordabilityInput): AffordabilityResult {
  const zero = money(0, input.currency);
  const safetyBuffer = money(Math.max(0, input.safetyBufferMinor), input.currency);

  if (input.accountCount === 0 || input.forecast.length === 0) {
    return {
      verdict: "INSUFFICIENT_DATA",
      reason: "There are no account balances to project from, so affordability can't be worked out.",
      currentBalance: null,
      lowestWithout: null,
      lowestWith: null,
      headroomAboveBuffer: null,
      safetyBuffer,
      totalPaidInWindow: zero,
      paymentsInWindow: 0,
      windowEnd: null,
      assumptions: ASSUMPTIONS,
    };
  }

  const windowEnd = input.forecast[input.forecast.length - 1].date;
  const dates = paymentDates(input.frequency, input.firstPaymentOn, windowEnd);

  const without = input.forecast.map((p) => ({ date: p.date, balanceMinor: p.balance.amountMinor }));
  const withPurchase = without.map((p) => ({
    date: p.date,
    balanceMinor: p.balanceMinor - input.amountMinor * dates.filter((d) => d <= p.date).length,
  }));

  const lowWithout = lowest(without)!;
  const lowWith = lowest(withPurchase)!;
  const headroom = lowWith.balanceMinor - safetyBuffer.amountMinor;

  const verdict: AffordabilityVerdict = lowWith.balanceMinor < 0 ? "NOT_AFFORDABLE" : headroom < 0 ? "TIGHT" : "AFFORDABLE";
  const reason =
    verdict === "NOT_AFFORDABLE"
      ? `With this purchase the projected balance falls below zero, to its lowest on ${lowWith.date}.`
      : verdict === "TIGHT"
        ? `The projected balance stays above zero but dips under your one-month safety buffer, lowest on ${lowWith.date}.`
        : `The projected balance stays above your one-month safety buffer throughout, lowest on ${lowWith.date}.`;

  return {
    verdict,
    reason,
    currentBalance: money(without[0].balanceMinor, input.currency),
    lowestWithout: { date: lowWithout.date, balance: money(lowWithout.balanceMinor, input.currency) },
    lowestWith: { date: lowWith.date, balance: money(lowWith.balanceMinor, input.currency) },
    headroomAboveBuffer: money(headroom, input.currency),
    safetyBuffer,
    totalPaidInWindow: money(input.amountMinor * dates.length, input.currency),
    paymentsInWindow: dates.length,
    windowEnd,
    assumptions: ASSUMPTIONS,
  };
}
