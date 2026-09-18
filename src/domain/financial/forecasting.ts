import { type CurrencyCode, type Money, add, money, subtract } from "@/domain/money/money";
import type { RecurringPattern } from "@/domain/insights/recurring-detection";

/**
 * Cash-flow forecasting foundation (product spec §18). Every point is
 * explicitly labeled `actual` (today) or `projected` (everything after) —
 * never presented as a fact. The projection combines two things, kept
 * separate on purpose:
 *   1. a smoothed historical daily trend (discretionary income/spending
 *      that doesn't follow a detected pattern)
 *   2. known/likely future events: detected recurring payments
 *      (src/domain/insights/recurring-detection) and invoices already
 *      issued with a due date
 * This is intentionally simple (linear trend + known events), not a
 * statistical model — good enough to answer "roughly where am I headed",
 * not precise enough to be treated as accounting fact, which is exactly
 * why every point carries its basis.
 */

const INTERVAL_DAYS: Record<RecurringPattern["interval"], number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 91,
  annual: 365,
};

export interface ForecastPoint {
  date: string;
  balance: Money;
  basis: "actual" | "projected";
}

export interface UpcomingInvoice {
  dueDate: string;
  totalMinor: number;
}

export interface ForecastInput {
  startDate: string; // YYYY-MM-DD, "today"
  currentBalanceMinor: number;
  currency: CurrencyCode;
  /** Net daily change (income minus non-recurring expense) from recent
   *  history, excluding amounts already captured by `recurringPatterns` —
   *  see src/server/db/repositories for how this is derived. */
  averageDailyNetMinor: number;
  recurringPatterns: RecurringPattern[];
  upcomingInvoices: UpcomingInvoice[];
  horizonDays: number;
}

/** Date-only math, done entirely in UTC. `setDate`/`getDate` operate in
 *  local time, so mixing them with a UTC-parsed date-only string can drift
 *  by a day right at a DST boundary — `setUTCDate`/`getUTCDate` don't have
 *  that problem (same bug class caught in src/domain/search/query-parser). */
function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Every occurrence date of a recurring pattern that falls within
 *  [startDate, startDate + horizonDays]. */
function recurringOccurrencesInWindow(pattern: RecurringPattern, startDate: string, horizonDays: number): string[] {
  const intervalDays = INTERVAL_DAYS[pattern.interval];
  const windowEnd = addDays(startDate, horizonDays);
  const dates: string[] = [];
  let next = pattern.nextExpectedOn;
  let guard = 0;
  while (next <= windowEnd && guard < 1000) {
    if (next >= startDate) dates.push(next);
    next = addDays(next, intervalDays);
    guard++;
  }
  return dates;
}

export function forecastCashFlow(input: ForecastInput): ForecastPoint[] {
  const points: ForecastPoint[] = [
    { date: input.startDate, balance: money(input.currentBalanceMinor, input.currency), basis: "actual" },
  ];

  // Precompute which day-offsets carry a known recurring event or invoice
  // due date, so the day loop stays O(horizon) rather than O(horizon * events).
  const eventsByDate = new Map<string, number>(); // date -> net minor delta
  for (const pattern of input.recurringPatterns) {
    // A recurring pattern's amountMinor is an outflow if it was detected
    // from expense transactions; recurring-detection doesn't currently
    // distinguish recurring income, so every pattern here is treated as
    // an outflow (subscriptions, rent) — the common case in practice.
    for (const date of recurringOccurrencesInWindow(pattern, input.startDate, input.horizonDays)) {
      eventsByDate.set(date, (eventsByDate.get(date) ?? 0) - pattern.averageAmount.amountMinor);
    }
  }
  for (const invoice of input.upcomingInvoices) {
    if (invoice.dueDate >= input.startDate && invoice.dueDate <= addDays(input.startDate, input.horizonDays)) {
      eventsByDate.set(invoice.dueDate, (eventsByDate.get(invoice.dueDate) ?? 0) + invoice.totalMinor);
    }
  }

  let runningBalance: Money = money(input.currentBalanceMinor, input.currency);
  for (let day = 1; day <= input.horizonDays; day++) {
    const date = addDays(input.startDate, day);
    runningBalance = add(runningBalance, money(input.averageDailyNetMinor, input.currency));
    const eventDelta = eventsByDate.get(date);
    if (eventDelta !== undefined) {
      runningBalance =
        eventDelta >= 0
          ? add(runningBalance, money(eventDelta, input.currency))
          : subtract(runningBalance, money(-eventDelta, input.currency));
    }
    points.push({ date, balance: runningBalance, basis: "projected" });
  }

  return points;
}

export function lowestProjectedPoint(points: ForecastPoint[]): ForecastPoint | null {
  const projected = points.filter((p) => p.basis === "projected");
  if (projected.length === 0) return null;
  return projected.reduce((min, p) => (p.balance.amountMinor < min.balance.amountMinor ? p : min));
}
