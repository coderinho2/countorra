import { describe, expect, it } from "vitest";
import { calculateFinancialHealth, healthLabel } from "./financial-health";

const baseInput = {
  currency: "EUR" as const,
  cashBalanceMinor: 600_000, // €6,000
  averageMonthlyExpenseMinor: 200_000, // €2,000
  averageMonthlyIncomeMinor: 300_000, // €3,000
  monthlyExpenseTotalsMinor: [195_000, 200_000, 205_000],
  recurringAnnualCostMinor: 600_000, // €6,000/yr
  overdueReceivablesMinor: 0,
  totalReceivablesMinor: 0,
};

describe("calculateFinancialHealth", () => {
  it("scores a healthy financial position as strong overall", () => {
    const result = calculateFinancialHealth(baseInput);
    expect(result.overallScore).toBeGreaterThanOrEqual(70);
    expect(healthLabel(result.overallScore)).toBe("Healthy");
  });

  it("flags negative savings rate (spending more than earning) as a risk", () => {
    const result = calculateFinancialHealth({
      ...baseInput,
      averageMonthlyIncomeMinor: 150_000,
      averageMonthlyExpenseMinor: 200_000,
    });
    const savings = result.factors.find((f) => f.key === "savingsRate")!;
    expect(savings.status).toBe("risk");
    expect(result.risks).toContainEqual(savings);
  });

  it("flags low cash runway as a risk", () => {
    const result = calculateFinancialHealth({ ...baseInput, cashBalanceMinor: 20_000 });
    const runway = result.factors.find((f) => f.key === "cashRunway")!;
    expect(runway.status).toBe("risk");
    expect(result.cashRunwayMonths).toBeCloseTo(0.1, 1);
  });

  it("flags a high overdue-receivables ratio as a risk", () => {
    const result = calculateFinancialHealth({
      ...baseInput,
      totalReceivablesMinor: 100_000,
      overdueReceivablesMinor: 90_000,
    });
    const receivables = result.factors.find((f) => f.key === "receivablesHealth")!;
    expect(receivables.status).toBe("risk");
  });

  it("does not penalize receivables when there are none", () => {
    const result = calculateFinancialHealth(baseInput);
    const receivables = result.factors.find((f) => f.key === "receivablesHealth")!;
    expect(receivables.score).toBe(100);
  });

  it("every factor score is within 0-100", () => {
    const result = calculateFinancialHealth(baseInput);
    for (const factor of result.factors) {
      expect(factor.score).toBeGreaterThanOrEqual(0);
      expect(factor.score).toBeLessThanOrEqual(100);
    }
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.overallScore).toBeLessThanOrEqual(100);
  });

  it("handles zero income/expense history without throwing", () => {
    const result = calculateFinancialHealth({
      currency: "EUR",
      cashBalanceMinor: 0,
      averageMonthlyExpenseMinor: 0,
      averageMonthlyIncomeMinor: 0,
      monthlyExpenseTotalsMinor: [],
      recurringAnnualCostMinor: 0,
      overdueReceivablesMinor: 0,
      totalReceivablesMinor: 0,
    });
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.cashRunwayMonths).toBeNull();
  });
});
