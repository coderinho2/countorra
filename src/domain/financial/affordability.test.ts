import { describe, expect, it } from "vitest";
import { money } from "@/domain/money/money";
import { assessAffordability, paymentDates } from "./affordability";
import type { ForecastPoint } from "./forecasting";

/** A flat projection: `balance` every day from 2026-03-01 for `days` days. */
function flat(balance: number, days = 60): ForecastPoint[] {
  return Array.from({ length: days + 1 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 2, 1 + i)).toISOString().slice(0, 10);
    return { date: d, balance: money(balance, "USD"), basis: i === 0 ? "actual" : "projected" };
  });
}

const base = { currency: "USD" as const, frequency: "ONE_TIME" as const, firstPaymentOn: "2026-03-01", safetyBufferMinor: 300_000, accountCount: 2 };

describe("assessAffordability", () => {
  it("is AFFORDABLE when the balance stays above the one-month buffer", () => {
    const r = assessAffordability({ ...base, forecast: flat(1_000_000), amountMinor: 200_000 });
    expect(r.verdict).toBe("AFFORDABLE");
    expect(r.lowestWith?.balance.amountMinor).toBe(800_000);
    expect(r.lowestWithout?.balance.amountMinor).toBe(1_000_000);
    expect(r.headroomAboveBuffer?.amountMinor).toBe(500_000);
  });

  it("is TIGHT when it stays above zero but dips under the buffer", () => {
    expect(assessAffordability({ ...base, forecast: flat(400_000), amountMinor: 200_000 }).verdict).toBe("TIGHT");
  });

  it("is NOT_AFFORDABLE when the balance goes negative", () => {
    const r = assessAffordability({ ...base, forecast: flat(150_000), amountMinor: 200_000 });
    expect(r.verdict).toBe("NOT_AFFORDABLE");
    expect(r.lowestWith?.balance.amountMinor).toBe(-50_000);
  });

  it("takes a monthly payment out once per month, cumulatively", () => {
    const r = assessAffordability({ ...base, frequency: "MONTHLY", forecast: flat(1_000_000, 90), amountMinor: 70_000 });
    // Mar 1, Apr 1, May 1 fall within a 90-day window starting Mar 1.
    expect(r.paymentsInWindow).toBe(3);
    expect(r.totalPaidInWindow.amountMinor).toBe(210_000);
    expect(r.lowestWith?.balance.amountMinor).toBe(790_000);
  });

  it("only deducts from the payment date onward", () => {
    const forecast = flat(100_000);
    forecast[10] = { ...forecast[10], balance: money(10_000, "USD") }; // a dip before the purchase
    const r = assessAffordability({ ...base, firstPaymentOn: "2026-03-20", forecast, amountMinor: 50_000 });
    expect(r.lowestWith).toEqual({ date: "2026-03-11", balance: money(10_000, "USD") });
  });

  it("reads a negative starting balance (an overdraft) as it is", () => {
    expect(assessAffordability({ ...base, forecast: flat(-5_000), amountMinor: 1 }).verdict).toBe("NOT_AFFORDABLE");
  });

  it("refuses to answer without accounts or a projection", () => {
    expect(assessAffordability({ ...base, accountCount: 0, forecast: flat(1_000_000), amountMinor: 1 }).verdict).toBe("INSUFFICIENT_DATA");
    expect(assessAffordability({ ...base, forecast: [], amountMinor: 1 }).verdict).toBe("INSUFFICIENT_DATA");
  });

  it("always states its assumptions", () => {
    expect(assessAffordability({ ...base, forecast: flat(1), amountMinor: 1 }).assumptions.length).toBeGreaterThan(0);
  });
});

describe("paymentDates", () => {
  it("clamps a monthly payment to the last day of shorter months", () => {
    expect(paymentDates("MONTHLY", "2026-01-31", "2026-04-30")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("has no payment when the first falls after the window", () => {
    expect(paymentDates("ONE_TIME", "2026-06-01", "2026-05-31")).toEqual([]);
  });
});
