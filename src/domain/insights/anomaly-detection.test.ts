import { describe, expect, it } from "vitest";
import { money } from "@/domain/money/money";
import {
  detectCategorySpikes,
  detectDuplicateTransactions,
  detectLargeTransactions,
  detectRecurringPriceIncreases,
  detectUnusualMerchants,
  type TransactionForAnomalyDetection,
} from "./anomaly-detection";
import type { RecurringPattern } from "./recurring-detection";

function tx(overrides: Partial<TransactionForAnomalyDetection> & { id: string }): TransactionForAnomalyDetection {
  return {
    merchantId: "m1",
    merchantName: "Merchant",
    categoryId: "cat-1",
    amountMinor: 1_000,
    currency: "EUR",
    occurredOn: "2026-06-01",
    kind: "expense",
    ...overrides,
  };
}

describe("detectLargeTransactions", () => {
  it("flags a transaction far above the mean", () => {
    const normal = Array.from({ length: 8 }, (_, i) => tx({ id: `n${i}`, amountMinor: 1_000 + i * 10 }));
    const outlier = tx({ id: "outlier", amountMinor: 50_000 });
    const result = detectLargeTransactions([...normal, outlier]);
    expect(result.map((a) => a.transactionId)).toContain("outlier");
  });

  it("does not flag anything with too little history", () => {
    const few = Array.from({ length: 3 }, (_, i) => tx({ id: `n${i}`, amountMinor: 1_000 }));
    expect(detectLargeTransactions(few)).toHaveLength(0);
  });

  it("does not flag a uniform set (zero variance)", () => {
    const uniform = Array.from({ length: 8 }, (_, i) => tx({ id: `n${i}`, amountMinor: 1_000 }));
    expect(detectLargeTransactions(uniform)).toHaveLength(0);
  });
});

describe("detectUnusualMerchants", () => {
  it("flags a large transaction from a merchant not in known history", () => {
    const transactions = [
      tx({ id: "a", merchantId: "known", amountMinor: 1_000 }),
      tx({ id: "b", merchantId: "known", amountMinor: 1_000 }),
      tx({ id: "c", merchantId: "new-merchant", amountMinor: 5_000 }),
    ];
    const result = detectUnusualMerchants(transactions, new Set(["known"]));
    expect(result.map((a) => a.transactionId)).toEqual(["c"]);
  });

  it("does not flag a small transaction from a new merchant", () => {
    const transactions = [
      tx({ id: "a", merchantId: "known", amountMinor: 1_000 }),
      tx({ id: "b", merchantId: "new-merchant", amountMinor: 500 }),
    ];
    expect(detectUnusualMerchants(transactions, new Set(["known"]))).toHaveLength(0);
  });
});

describe("detectDuplicateTransactions", () => {
  it("flags same merchant + same amount within 2 days", () => {
    const transactions = [
      tx({ id: "a", occurredOn: "2026-06-01", amountMinor: 2_000 }),
      tx({ id: "b", occurredOn: "2026-06-02", amountMinor: 2_000 }),
    ];
    const result = detectDuplicateTransactions(transactions);
    expect(result.map((a) => a.transactionId)).toEqual(["b"]);
  });

  it("does not flag transactions more than 2 days apart", () => {
    const transactions = [
      tx({ id: "a", occurredOn: "2026-06-01", amountMinor: 2_000 }),
      tx({ id: "b", occurredOn: "2026-06-10", amountMinor: 2_000 }),
    ];
    expect(detectDuplicateTransactions(transactions)).toHaveLength(0);
  });

  it("does not flag different amounts", () => {
    const transactions = [
      tx({ id: "a", occurredOn: "2026-06-01", amountMinor: 2_000 }),
      tx({ id: "b", occurredOn: "2026-06-02", amountMinor: 2_500 }),
    ];
    expect(detectDuplicateTransactions(transactions)).toHaveLength(0);
  });
});

describe("detectCategorySpikes", () => {
  it("flags a category well above its baseline", () => {
    const current = [tx({ id: "a", categoryId: "dining", amountMinor: 30_000 })];
    const baselines = new Map([["dining", money(10_000, "EUR")]]);
    const result = detectCategorySpikes(current, baselines);
    expect(result).toHaveLength(1);
    expect(result[0].categoryId).toBe("dining");
  });

  it("does not flag a category near its baseline", () => {
    const current = [tx({ id: "a", categoryId: "dining", amountMinor: 10_500 })];
    const baselines = new Map([["dining", money(10_000, "EUR")]]);
    expect(detectCategorySpikes(current, baselines)).toHaveLength(0);
  });

  it("skips categories with no baseline data", () => {
    const current = [tx({ id: "a", categoryId: "unknown-category", amountMinor: 30_000 })];
    expect(detectCategorySpikes(current, new Map())).toHaveLength(0);
  });
});

describe("detectRecurringPriceIncreases", () => {
  const basePattern: RecurringPattern = {
    merchantId: "netflix",
    merchantName: "Netflix",
    categoryId: "entertainment",
    interval: "monthly",
    averageAmount: money(1_400, "EUR"),
    lastAmount: money(1_600, "EUR"),
    amountChangeMinor: 200,
    occurrenceCount: 5,
    lastOccurredOn: "2026-06-01",
    nextExpectedOn: "2026-07-01",
    annualizedCost: money(16_800, "EUR"),
    confidence: 0.8,
  };

  it("flags a meaningful price increase", () => {
    expect(detectRecurringPriceIncreases([basePattern])).toHaveLength(1);
  });

  it("does not flag a trivial increase", () => {
    const tiny = { ...basePattern, amountChangeMinor: 5, lastAmount: money(1_405, "EUR") };
    expect(detectRecurringPriceIncreases([tiny])).toHaveLength(0);
  });

  it("does not flag a price decrease", () => {
    const decrease = { ...basePattern, amountChangeMinor: -200, lastAmount: money(1_200, "EUR") };
    expect(detectRecurringPriceIncreases([decrease])).toHaveLength(0);
  });
});
