import { describe, expect, it } from "vitest";
import { forecastCashFlow, lowestProjectedPoint } from "./forecasting";
import type { RecurringPattern } from "@/domain/insights/recurring-detection";
import { money } from "@/domain/money/money";

const netflix: RecurringPattern = {
  merchantId: "netflix",
  merchantName: "Netflix",
  categoryId: "entertainment",
  interval: "monthly",
  averageAmount: money(1_500, "EUR"),
  lastAmount: money(1_500, "EUR"),
  amountChangeMinor: 0,
  occurrenceCount: 5,
  lastOccurredOn: "2026-05-15",
  nextExpectedOn: "2026-06-15",
  annualizedCost: money(18_000, "EUR"),
  confidence: 0.9,
};

describe("forecastCashFlow", () => {
  it("starts with today as an actual point", () => {
    const points = forecastCashFlow({
      startDate: "2026-06-01",
      currentBalanceMinor: 100_000,
      currency: "EUR",
      averageDailyNetMinor: 0,
      recurringPatterns: [],
      upcomingInvoices: [],
      horizonDays: 10,
    });
    expect(points[0]).toEqual({ date: "2026-06-01", balance: money(100_000, "EUR"), basis: "actual" });
  });

  it("produces horizonDays + 1 points", () => {
    const points = forecastCashFlow({
      startDate: "2026-06-01",
      currentBalanceMinor: 100_000,
      currency: "EUR",
      averageDailyNetMinor: 0,
      recurringPatterns: [],
      upcomingInvoices: [],
      horizonDays: 30,
    });
    expect(points).toHaveLength(31);
    expect(points.slice(1).every((p) => p.basis === "projected")).toBe(true);
  });

  it("applies the daily trend cumulatively", () => {
    const points = forecastCashFlow({
      startDate: "2026-06-01",
      currentBalanceMinor: 0,
      currency: "EUR",
      averageDailyNetMinor: 1_000,
      recurringPatterns: [],
      upcomingInvoices: [],
      horizonDays: 5,
    });
    expect(points[5].balance).toEqual(money(5_000, "EUR"));
  });

  it("subtracts a recurring payment on its expected date", () => {
    const points = forecastCashFlow({
      startDate: "2026-06-01",
      currentBalanceMinor: 100_000,
      currency: "EUR",
      averageDailyNetMinor: 0,
      recurringPatterns: [netflix],
      upcomingInvoices: [],
      horizonDays: 20,
    });
    const day14 = points.find((p) => p.date === "2026-06-14")!;
    const day15 = points.find((p) => p.date === "2026-06-15")!;
    expect(day14.balance.amountMinor - day15.balance.amountMinor).toBe(1_500);
  });

  it("adds an upcoming invoice on its due date", () => {
    const points = forecastCashFlow({
      startDate: "2026-06-01",
      currentBalanceMinor: 0,
      currency: "EUR",
      averageDailyNetMinor: 0,
      recurringPatterns: [],
      upcomingInvoices: [{ dueDate: "2026-06-10", totalMinor: 50_000 }],
      horizonDays: 15,
    });
    const before = points.find((p) => p.date === "2026-06-09")!;
    const after = points.find((p) => p.date === "2026-06-10")!;
    expect(after.balance.amountMinor - before.balance.amountMinor).toBe(50_000);
  });
});

describe("lowestProjectedPoint", () => {
  it("finds the minimum projected balance, ignoring the actual starting point", () => {
    const points = forecastCashFlow({
      startDate: "2026-06-01",
      currentBalanceMinor: 100_000,
      currency: "EUR",
      averageDailyNetMinor: -2_000,
      recurringPatterns: [],
      upcomingInvoices: [{ dueDate: "2026-06-20", totalMinor: 80_000 }],
      horizonDays: 30,
    });
    const lowest = lowestProjectedPoint(points);
    expect(lowest).not.toBeNull();
    expect(lowest!.basis).toBe("projected");
  });

  it("returns null when there are no projected points", () => {
    expect(lowestProjectedPoint([{ date: "2026-06-01", balance: money(0, "EUR"), basis: "actual" }])).toBeNull();
  });
});
