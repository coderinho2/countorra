import { describe, expect, it } from "vitest";
import { money } from "@/domain/money/money";
import {
  calculateMargin,
  calculateProfit,
  calculateSpendByCategory,
  calculateTotalByKind,
  comparePeriods,
  type TransactionForCalculation,
} from "./calculation-engine";

const tx = (
  kind: TransactionForCalculation["kind"],
  amountMinor: number,
  categoryId: string | null = null,
): TransactionForCalculation => ({ kind, amountMinor, currency: "EUR", categoryId });

describe("calculateTotalByKind", () => {
  it("sums only the requested kind", () => {
    const transactions = [tx("income", 5_000), tx("expense", 2_000), tx("income", 1_000)];
    expect(calculateTotalByKind(transactions, "income", "EUR")).toEqual(money(6_000, "EUR"));
    expect(calculateTotalByKind(transactions, "expense", "EUR")).toEqual(money(2_000, "EUR"));
  });

  it("excludes transfers from income and expense totals", () => {
    const transactions = [tx("income", 5_000), tx("transfer", 10_000)];
    expect(calculateTotalByKind(transactions, "income", "EUR")).toEqual(money(5_000, "EUR"));
  });

  it("returns zero for an empty set", () => {
    expect(calculateTotalByKind([], "income", "EUR")).toEqual(money(0, "EUR"));
  });
});

describe("calculateProfit", () => {
  it("is income minus expense", () => {
    const transactions = [tx("income", 10_000), tx("expense", 3_500)];
    expect(calculateProfit(transactions, "EUR")).toEqual(money(6_500, "EUR"));
  });

  it("can be negative", () => {
    const transactions = [tx("income", 1_000), tx("expense", 4_000)];
    expect(calculateProfit(transactions, "EUR")).toEqual(money(-3_000, "EUR"));
  });

  it("ignores transfers", () => {
    const transactions = [tx("income", 1_000), tx("expense", 400), tx("transfer", 50_000)];
    expect(calculateProfit(transactions, "EUR")).toEqual(money(600, "EUR"));
  });
});

describe("calculateSpendByCategory", () => {
  it("groups and sums expenses by category, sorted descending", () => {
    const transactions = [
      tx("expense", 1_000, "cat-groceries"),
      tx("expense", 500, "cat-groceries"),
      tx("expense", 3_000, "cat-rent"),
      tx("income", 10_000, "cat-groceries"), // must not appear in spend totals
    ];

    const result = calculateSpendByCategory(transactions, "EUR");

    expect(result).toEqual([
      { categoryId: "cat-rent", total: money(3_000, "EUR") },
      { categoryId: "cat-groceries", total: money(1_500, "EUR") },
    ]);
  });

  it("groups uncategorized expenses under null", () => {
    const transactions = [tx("expense", 200, null), tx("expense", 300, null)];
    expect(calculateSpendByCategory(transactions, "EUR")).toEqual([{ categoryId: null, total: money(500, "EUR") }]);
  });
});

describe("calculateMargin", () => {
  it("computes profit as a percentage of income", () => {
    const transactions = [tx("income", 10_000), tx("expense", 4_000)];
    expect(calculateMargin(transactions, "EUR")).toBe(60);
  });

  it("returns null when there is no income", () => {
    expect(calculateMargin([tx("expense", 1_000)], "EUR")).toBeNull();
  });

  it("can be negative", () => {
    const transactions = [tx("income", 1_000), tx("expense", 3_000)];
    expect(calculateMargin(transactions, "EUR")).toBe(-200);
  });
});

describe("comparePeriods", () => {
  it("computes deltas and percent changes between two periods", () => {
    const current = [tx("income", 12_000), tx("expense", 4_000)];
    const previous = [tx("income", 10_000), tx("expense", 5_000)];
    const result = comparePeriods(current, previous, "EUR");

    expect(result.incomeChangeMinor).toBe(2_000);
    expect(result.expenseChangeMinor).toBe(-1_000);
    expect(result.incomePercentChange).toBe(20);
    expect(result.expensePercentChange).toBe(-20);
  });

  it("returns null percent change when the previous period was zero", () => {
    const current = [tx("income", 5_000)];
    const result = comparePeriods(current, [], "EUR");
    expect(result.incomePercentChange).toBeNull();
  });
});
