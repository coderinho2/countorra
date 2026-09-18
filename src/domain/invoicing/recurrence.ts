/**
 * When a recurring invoice is next due to be issued.
 *
 * Pure and deterministic: same inputs, same date, every time. That matters
 * more here than it looks — a recurrence that drifts by a day each month
 * bills a customer on the 28th, then the 27th, then the 26th, and nobody
 * notices until the year is out by a fortnight.
 *
 * THE MONTH-END RULE
 *
 * A monthly series starting 31 January cannot issue on 31 February. The two
 * usual answers are "clamp to the last day of the month" and "roll into the
 * next month"; this clamps, because rolling would move a January invoice
 * into March and skip February entirely.
 *
 * Clamping is applied against the ANCHOR day — the day of the month the
 * series started — not against the previous issue date. Anchoring to the
 * previous date is how 31 Jan becomes 28 Feb becomes 28 Mar: once it clamps
 * it never recovers. Keeping the anchor means February issues on the 28th
 * and March goes back to the 31st.
 */

export type RecurrenceInterval = "weekly" | "monthly" | "quarterly" | "yearly";

export interface RecurrenceSpec {
  interval: RecurrenceInterval;
  /** Every N intervals. `monthly` × 3 and `quarterly` × 1 are the same series. */
  intervalCount: number;
  /** The day-of-month the series is anchored to, for monthly-family
   *  intervals. Taken from the first issue date. */
  anchorDay?: number;
}

const MONTHS_PER_INTERVAL: Record<RecurrenceInterval, number> = {
  weekly: 0,
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * The issue date after `from`.
 *
 * `from` is the date an invoice was (or would have been) issued; the result
 * is strictly after it for any valid spec.
 */
export function nextIssueDate(from: string, spec: RecurrenceSpec): string {
  const count = Math.max(1, Math.trunc(spec.intervalCount));
  const base = new Date(`${from}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) throw new Error(`Invalid recurrence start date: ${from}`);

  if (spec.interval === "weekly") {
    // Weeks are exact — no month-length problem to solve.
    base.setUTCDate(base.getUTCDate() + 7 * count);
    return base.toISOString().slice(0, 10);
  }

  const monthsToAdd = MONTHS_PER_INTERVAL[spec.interval] * count;
  const anchorDay = spec.anchorDay ?? base.getUTCDate();

  const targetMonth = base.getUTCMonth() + monthsToAdd;
  const targetYear = base.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;

  const day = Math.min(anchorDay, lastDayOfMonth(targetYear, normalizedMonth));
  return new Date(Date.UTC(targetYear, normalizedMonth, day)).toISOString().slice(0, 10);
}

/** The anchor a series should carry, taken from where it started. */
export function anchorDayOf(startDate: string): number {
  return new Date(`${startDate}T00:00:00Z`).getUTCDate();
}

export interface RecurrenceState {
  nextIssueDate: string;
  endsOn: string | null;
  status: "active" | "paused" | "ended";
}

/** Whether an invoice is due to be issued for this series as of `today`. */
export function isDueToIssue(state: RecurrenceState, today: Date = new Date()): boolean {
  if (state.status !== "active") return false;
  const todayIso = today.toISOString().slice(0, 10);
  if (state.endsOn && state.nextIssueDate > state.endsOn) return false;
  return state.nextIssueDate <= todayIso;
}

/**
 * Every date a series should have issued on, up to and including today.
 *
 * A series whose generator has not run for three months has THREE invoices
 * outstanding, not one. Returning all of them is what makes a missed run
 * catch up instead of silently swallowing two months of revenue.
 *
 * Bounded, because an `ends_on` far in the future combined with a weekly
 * interval and a long outage would otherwise produce an unbounded list.
 */
export function pendingIssueDates(state: RecurrenceState, spec: RecurrenceSpec, today: Date = new Date(), limit = 24): string[] {
  const dates: string[] = [];
  const todayIso = today.toISOString().slice(0, 10);
  let cursor = state.nextIssueDate;

  if (state.status !== "active") return dates;

  while (dates.length < limit && cursor <= todayIso) {
    if (state.endsOn && cursor > state.endsOn) break;
    dates.push(cursor);
    cursor = nextIssueDate(cursor, spec);
  }

  return dates;
}

/** Whether the series has run its course and should stop. */
export function hasEnded(state: RecurrenceState): boolean {
  if (state.status === "ended") return true;
  return Boolean(state.endsOn && state.nextIssueDate > state.endsOn);
}
