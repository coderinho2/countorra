import { describe, expect, it } from "vitest";
import { anchorDayOf, hasEnded, isDueToIssue, nextIssueDate, pendingIssueDates, type RecurrenceSpec } from "./recurrence";

/**
 * Recurrence dates.
 *
 * The property that matters is that a series does not DRIFT. A monthly
 * invoice anchored to the 31st must not become the 28th forever the first
 * time it passes February — that is how a yearly series ends up a fortnight
 * early, and nobody notices until the customer asks why.
 */

const monthly: RecurrenceSpec = { interval: "monthly", intervalCount: 1 };

describe("nextIssueDate", () => {
  it("advances a month", () => {
    expect(nextIssueDate("2026-01-15", monthly)).toBe("2026-02-15");
  });

  it("advances a week", () => {
    expect(nextIssueDate("2026-01-15", { interval: "weekly", intervalCount: 1 })).toBe("2026-01-22");
    expect(nextIssueDate("2026-01-15", { interval: "weekly", intervalCount: 2 })).toBe("2026-01-29");
  });

  it("advances a quarter and a year", () => {
    expect(nextIssueDate("2026-01-15", { interval: "quarterly", intervalCount: 1 })).toBe("2026-04-15");
    expect(nextIssueDate("2026-01-15", { interval: "yearly", intervalCount: 1 })).toBe("2027-01-15");
  });

  it("treats monthly×3 and quarterly×1 as the same series", () => {
    expect(nextIssueDate("2026-01-15", { interval: "monthly", intervalCount: 3 })).toBe(
      nextIssueDate("2026-01-15", { interval: "quarterly", intervalCount: 1 }),
    );
  });

  it("crosses a year boundary", () => {
    expect(nextIssueDate("2026-12-15", monthly)).toBe("2027-01-15");
  });

  describe("month-end", () => {
    it("clamps 31 January to the last day of February", () => {
      expect(nextIssueDate("2026-01-31", monthly)).toBe("2026-02-28");
    });

    it("RECOVERS the anchor day afterwards, rather than drifting", () => {
      // The bug this guards: anchoring to the previous issue date means
      // 31 Jan → 28 Feb → 28 Mar → 28 Apr, and the series has silently moved
      // three days earlier forever. With the anchor, March returns to 31.
      const spec: RecurrenceSpec = { ...monthly, anchorDay: anchorDayOf("2026-01-31") };
      expect(nextIssueDate("2026-02-28", spec)).toBe("2026-03-31");
      expect(nextIssueDate("2026-03-31", spec)).toBe("2026-04-30");
      expect(nextIssueDate("2026-04-30", spec)).toBe("2026-05-31");
    });

    it("clamps into a leap February", () => {
      const spec: RecurrenceSpec = { ...monthly, anchorDay: 31 };
      expect(nextIssueDate("2028-01-31", spec)).toBe("2028-02-29");
    });

    it("clamps a 30th into February too", () => {
      expect(nextIssueDate("2026-01-30", monthly)).toBe("2026-02-28");
    });

    it("never produces an invalid date for any day-of-month", () => {
      for (let day = 1; day <= 31; day++) {
        const start = `2026-01-${String(day).padStart(2, "0")}`;
        const next = nextIssueDate(start, { ...monthly, anchorDay: day });
        expect(Number.isNaN(Date.parse(next)), `${start} -> ${next}`).toBe(false);
        expect(next.startsWith("2026-02"), `${start} -> ${next}`).toBe(true);
      }
    });
  });

  it("is deterministic", () => {
    // Same inputs, same answer — no clock, no randomness reaches a date a
    // customer will be billed on.
    const first = nextIssueDate("2026-01-31", monthly);
    const second = nextIssueDate("2026-01-31", monthly);
    expect(first).toBe(second);
  });

  it("always moves forward", () => {
    for (const interval of ["weekly", "monthly", "quarterly", "yearly"] as const) {
      const next = nextIssueDate("2026-05-15", { interval, intervalCount: 1 });
      expect(next > "2026-05-15", interval).toBe(true);
    }
  });

  it("refuses an unparseable start date rather than producing NaN", () => {
    expect(() => nextIssueDate("not-a-date", monthly)).toThrow(/Invalid recurrence start date/);
  });
});

describe("isDueToIssue", () => {
  const today = new Date("2026-06-15T00:00:00Z");

  it("is due on and before the scheduled date", () => {
    expect(isDueToIssue({ nextIssueDate: "2026-06-15", endsOn: null, status: "active" }, today)).toBe(true);
    expect(isDueToIssue({ nextIssueDate: "2026-06-01", endsOn: null, status: "active" }, today)).toBe(true);
  });

  it("is not due before the scheduled date", () => {
    expect(isDueToIssue({ nextIssueDate: "2026-06-16", endsOn: null, status: "active" }, today)).toBe(false);
  });

  it.each(["paused", "ended"] as const)("is never due while %s", (status) => {
    // Pausing a series has to actually stop it billing, not just hide it.
    expect(isDueToIssue({ nextIssueDate: "2026-01-01", endsOn: null, status }, today)).toBe(false);
  });

  it("stops after the end date", () => {
    expect(isDueToIssue({ nextIssueDate: "2026-06-15", endsOn: "2026-05-01", status: "active" }, today)).toBe(false);
  });
});

describe("pendingIssueDates", () => {
  const today = new Date("2026-06-15T00:00:00Z");

  it("returns EVERY missed date, not just the next one", () => {
    // A generator that has not run since March owes three invoices. Issuing
    // one and advancing would silently swallow two months of revenue.
    const dates = pendingIssueDates({ nextIssueDate: "2026-03-15", endsOn: null, status: "active" }, monthly, today);
    expect(dates).toEqual(["2026-03-15", "2026-04-15", "2026-05-15", "2026-06-15"]);
  });

  it("returns nothing when the series is not yet due", () => {
    expect(pendingIssueDates({ nextIssueDate: "2026-07-01", endsOn: null, status: "active" }, monthly, today)).toEqual([]);
  });

  it("returns nothing for a paused series", () => {
    expect(pendingIssueDates({ nextIssueDate: "2026-01-15", endsOn: null, status: "paused" }, monthly, today)).toEqual([]);
  });

  it("stops at the end date", () => {
    const dates = pendingIssueDates({ nextIssueDate: "2026-03-15", endsOn: "2026-04-20", status: "active" }, monthly, today);
    expect(dates).toEqual(["2026-03-15", "2026-04-15"]);
  });

  it("is bounded, so a long outage cannot produce an unbounded list", () => {
    const dates = pendingIssueDates({ nextIssueDate: "2000-01-01", endsOn: null, status: "active" }, { interval: "weekly", intervalCount: 1 }, today, 10);
    expect(dates).toHaveLength(10);
  });
});

describe("hasEnded", () => {
  it("is true once the schedule passes the end date", () => {
    expect(hasEnded({ nextIssueDate: "2026-07-01", endsOn: "2026-06-01", status: "active" })).toBe(true);
  });

  it("is false for an open-ended active series", () => {
    expect(hasEnded({ nextIssueDate: "2026-07-01", endsOn: null, status: "active" })).toBe(false);
  });

  it("is true for an explicitly ended series", () => {
    expect(hasEnded({ nextIssueDate: "2026-07-01", endsOn: null, status: "ended" })).toBe(true);
  });
});
