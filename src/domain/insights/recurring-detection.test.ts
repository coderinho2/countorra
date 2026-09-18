import { describe, expect, it } from "vitest";
import { detectRecurringPatterns, type TransactionForRecurrence } from "./recurring-detection";

function monthlyTx(merchant: string, amountMinor: number, months: number): TransactionForRecurrence[] {
  const out: TransactionForRecurrence[] = [];
  for (let i = 0; i < months; i++) {
    const date = new Date(2026, i, 5);
    out.push({
      merchantId: merchant,
      merchantName: merchant,
      categoryId: "cat-software",
      amountMinor,
      currency: "EUR",
      occurredOn: date.toISOString().slice(0, 10),
    });
  }
  return out;
}

describe("detectRecurringPatterns", () => {
  it("detects a consistent monthly subscription", () => {
    const patterns = detectRecurringPatterns(monthlyTx("netflix", 1_499, 5));
    expect(patterns).toHaveLength(1);
    expect(patterns[0].interval).toBe("monthly");
    expect(patterns[0].confidence).toBeGreaterThanOrEqual(0.6);
    expect(patterns[0].occurrenceCount).toBe(5);
  });

  it("computes annualized cost from the average amount", () => {
    const patterns = detectRecurringPatterns(monthlyTx("spotify", 1_000, 4));
    // monthly (~30 day interval) => ~12.2 occurrences/year
    expect(patterns[0].annualizedCost.amountMinor).toBeGreaterThan(11_000);
    expect(patterns[0].annualizedCost.amountMinor).toBeLessThan(13_000);
  });

  it("flags an amount increase between the last two occurrences", () => {
    const tx = monthlyTx("gym", 3_000, 4);
    tx[tx.length - 1].amountMinor = 3_500;
    const patterns = detectRecurringPatterns(tx);
    expect(patterns[0].amountChangeMinor).toBe(500);
  });

  it("does not flag a one-off large purchase as recurring", () => {
    const patterns = detectRecurringPatterns([
      { merchantId: "furniture-store", merchantName: "Furniture Store", categoryId: null, amountMinor: 250_000, currency: "EUR", occurredOn: "2026-03-01" },
    ]);
    expect(patterns).toHaveLength(0);
  });

  it("does not flag irregular, inconsistent spending as recurring", () => {
    const irregular: TransactionForRecurrence[] = [
      { merchantId: "grocery", merchantName: "Grocery", categoryId: null, amountMinor: 4_200, currency: "EUR", occurredOn: "2026-01-03" },
      { merchantId: "grocery", merchantName: "Grocery", categoryId: null, amountMinor: 8_900, currency: "EUR", occurredOn: "2026-01-11" },
      { merchantId: "grocery", merchantName: "Grocery", categoryId: null, amountMinor: 2_300, currency: "EUR", occurredOn: "2026-01-29" },
      { merchantId: "grocery", merchantName: "Grocery", categoryId: null, amountMinor: 15_000, currency: "EUR", occurredOn: "2026-02-20" },
    ];
    expect(detectRecurringPatterns(irregular)).toHaveLength(0);
  });

  it("requires a merchant id — cannot detect recurrence without a stable identity", () => {
    const noMerchant: TransactionForRecurrence[] = monthlyTx("x", 1_000, 5).map((t) => ({ ...t, merchantId: null }));
    expect(detectRecurringPatterns(noMerchant)).toHaveLength(0);
  });
});
