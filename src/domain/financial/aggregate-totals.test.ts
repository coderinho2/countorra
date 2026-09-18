import { describe, expect, it } from "vitest";
import { comparePeriodTotals, marginFromTotals, spendByCategoryFromTotals, summarizeTotals, type CategoryTotalRow, type TransactionTotalRow } from "./calculation-engine";
import { money } from "@/domain/money/money";

/**
 * The deterministic layer for pre-aggregated input (FIN-01).
 *
 * These functions take what `transaction_totals` returns — one row per
 * (currency, kind), summed in Postgres over the whole period — and assign the
 * financial meaning: what income is, what profit is, what a margin is, and
 * what to do when the period contains more than one currency.
 *
 * The row-list functions they sit beside are still tested in
 * calculation-engine.test.ts and are still used where a caller genuinely holds
 * rows. Neither shape is a fallback for the other, so both are covered.
 */

const row = (
  kind: TransactionTotalRow["kind"],
  totalMinor: number,
  currency = "USD",
  transactionCount = 1,
  unreviewedCount = 0,
): TransactionTotalRow => ({ kind, totalMinor, currency: currency as TransactionTotalRow["currency"], transactionCount, unreviewedCount });

describe("summarizeTotals", () => {
  it("returns zeros in the base currency for an empty period", () => {
    const summary = summarizeTotals([], "USD");
    expect(summary.income).toEqual(money(0, "USD"));
    expect(summary.expense).toEqual(money(0, "USD"));
    expect(summary.profit).toEqual(money(0, "USD"));
    expect(summary.transactionCount).toBe(0);
    expect(summary.excluded).toEqual([]);
  });

  it("computes income, expense and profit", () => {
    const summary = summarizeTotals([row("income", 900_00, "USD", 9), row("expense", 400_00, "USD", 4)], "USD");
    expect(summary.income).toEqual(money(900_00, "USD"));
    expect(summary.expense).toEqual(money(400_00, "USD"));
    expect(summary.profit).toEqual(money(500_00, "USD"));
    expect(summary.transactionCount).toBe(13);
  });

  it("reports a loss as a negative profit rather than clamping at zero", () => {
    const summary = summarizeTotals([row("income", 100_00), row("expense", 350_00)], "USD");
    expect(summary.profit).toEqual(money(-250_00, "USD"));
  });

  it("excludes transfers, which move money without earning or spending it", () => {
    const summary = summarizeTotals([row("income", 100_00, "USD", 1), row("transfer", 5_000_00, "USD", 3)], "USD");
    expect(summary.income).toEqual(money(100_00, "USD"));
    expect(summary.profit).toEqual(money(100_00, "USD"));
    expect(summary.transactionCount).toBe(1);
  });

  it("never adds a foreign-currency group into the base total", () => {
    const summary = summarizeTotals([row("income", 900_00, "USD", 9), row("income", 700_00, "EUR", 7)], "USD");
    expect(summary.income).toEqual(money(900_00, "USD"));
    expect(summary.income.amountMinor).not.toBe(1_600_00);
  });

  it("reports every excluded currency once, with its transaction count", () => {
    const summary = summarizeTotals(
      [row("income", 900_00, "USD", 9), row("income", 700_00, "EUR", 7), row("expense", 100_00, "EUR", 2), row("expense", 50_00, "GBP", 1)],
      "USD",
    );
    expect(summary.excluded).toEqual([
      { currency: "EUR", count: 9 },
      { currency: "GBP", count: 1 },
    ]);
  });

  it("counts only base-currency rows toward the transaction and unreviewed counts", () => {
    const summary = summarizeTotals([row("income", 900_00, "USD", 9, 3), row("income", 700_00, "EUR", 7, 5)], "USD");
    expect(summary.transactionCount).toBe(9);
    expect(summary.unreviewedCount).toBe(3);
  });

  it("works with a non-USD base currency", () => {
    const summary = summarizeTotals([row("income", 900_00, "EUR", 9), row("income", 100_00, "USD", 1)], "EUR");
    expect(summary.income).toEqual(money(900_00, "EUR"));
    expect(summary.excluded).toEqual([{ currency: "USD", count: 1 }]);
  });
});

describe("marginFromTotals", () => {
  it("computes margin as a percentage of income", () => {
    expect(marginFromTotals([row("income", 1_000_00), row("expense", 250_00)], "USD")).toBe(75);
  });

  it("is undefined, not zero, when there is no income to divide by", () => {
    expect(marginFromTotals([row("expense", 250_00)], "USD")).toBeNull();
  });

  it("goes negative on a loss", () => {
    expect(marginFromTotals([row("income", 100_00), row("expense", 150_00)], "USD")).toBe(-50);
  });

  it("ignores foreign-currency income when deciding the divisor", () => {
    // EUR income must not make a USD margin computable.
    expect(marginFromTotals([row("income", 900_00, "EUR"), row("expense", 100_00, "USD")], "USD")).toBeNull();
  });
});

describe("comparePeriodTotals", () => {
  it("reports absolute and percentage change between two periods", () => {
    const comparison = comparePeriodTotals([row("income", 120_00), row("expense", 40_00)], [row("income", 100_00), row("expense", 50_00)], "USD");

    expect(comparison.current.profit).toEqual(money(80_00, "USD"));
    expect(comparison.previous.profit).toEqual(money(50_00, "USD"));
    expect(comparison.incomeChangeMinor).toBe(20_00);
    expect(comparison.expenseChangeMinor).toBe(-10_00);
    expect(comparison.incomePercentChange).toBe(20);
    expect(comparison.expensePercentChange).toBe(-20);
  });

  it("returns null percent change against a zero baseline rather than infinity", () => {
    const comparison = comparePeriodTotals([row("income", 100_00)], [], "USD");
    expect(comparison.incomePercentChange).toBeNull();
    expect(comparison.incomeChangeMinor).toBe(100_00);
  });

  it("compares base-currency figures only", () => {
    const comparison = comparePeriodTotals([row("income", 100_00, "USD"), row("income", 999_00, "EUR")], [row("income", 100_00, "USD")], "USD");
    expect(comparison.incomeChangeMinor).toBe(0);
    expect(comparison.incomePercentChange).toBe(0);
  });
});

describe("spendByCategoryFromTotals", () => {
  const cat = (categoryId: string | null, totalMinor: number, currency = "USD"): CategoryTotalRow => ({
    categoryId,
    totalMinor,
    currency: currency as CategoryTotalRow["currency"],
  });

  it("orders categories by spend, largest first", () => {
    const result = spendByCategoryFromTotals([cat("a", 100_00), cat("b", 400_00), cat("c", 250_00)], "USD");
    expect(result.map((r) => r.categoryId)).toEqual(["b", "c", "a"]);
  });

  it("keeps uncategorised spend as its own bucket", () => {
    const result = spendByCategoryFromTotals([cat(null, 90_00), cat("a", 10_00)], "USD");
    expect(result[0].categoryId).toBeNull();
    expect(result[0].total).toEqual(money(90_00, "USD"));
  });

  it("drops foreign-currency groups rather than merging them into a same-named category", () => {
    const result = spendByCategoryFromTotals([cat("a", 100_00, "USD"), cat("a", 400_00, "EUR")], "USD");
    expect(result).toHaveLength(1);
    expect(result[0].total).toEqual(money(100_00, "USD"));
  });

  it("returns nothing for an empty period", () => {
    expect(spendByCategoryFromTotals([], "USD")).toEqual([]);
  });
});
