import { describe, expect, it } from "vitest";
import { money } from "@/domain/money/money";
import { calculateInvoiceTotals, calculateLineItemTotals, isOverdue } from "./invoice-calculations";

describe("calculateLineItemTotals", () => {
  it("computes amount and tax with no discount", () => {
    const result = calculateLineItemTotals({ quantity: 2, unitPriceMinor: 5_000, taxRate: 19, discountRate: 0 }, "EUR");
    expect(result.amount).toEqual(money(10_000, "EUR"));
    expect(result.taxAmount).toEqual(money(1_900, "EUR"));
  });

  it("applies a discount before computing tax", () => {
    // 1 x €100.00, 10% discount -> €90.00, then 20% tax -> €18.00
    const result = calculateLineItemTotals({ quantity: 1, unitPriceMinor: 10_000, taxRate: 20, discountRate: 10 }, "EUR");
    expect(result.amount).toEqual(money(9_000, "EUR"));
    expect(result.taxAmount).toEqual(money(1_800, "EUR"));
  });

  it("handles fractional quantities", () => {
    const result = calculateLineItemTotals({ quantity: 2.5, unitPriceMinor: 4_000, taxRate: 0, discountRate: 0 }, "EUR");
    expect(result.amount).toEqual(money(10_000, "EUR"));
  });
});

describe("calculateInvoiceTotals", () => {
  it("sums multiple line items exactly", () => {
    const totals = calculateInvoiceTotals(
      [
        { quantity: 1, unitPriceMinor: 10_000, taxRate: 19, discountRate: 0 },
        { quantity: 3, unitPriceMinor: 2_500, taxRate: 19, discountRate: 0 },
      ],
      "EUR",
    );
    // subtotal: 10000 + 7500 = 17500; tax: 1900 + 1425 = 3325; total: 20825
    expect(totals.subtotal).toEqual(money(17_500, "EUR"));
    expect(totals.tax).toEqual(money(3_325, "EUR"));
    expect(totals.total).toEqual(money(20_825, "EUR"));
  });

  it("returns zero totals for no line items", () => {
    const totals = calculateInvoiceTotals([], "EUR");
    expect(totals.total).toEqual(money(0, "EUR"));
  });
});

describe("isOverdue", () => {
  const today = new Date("2026-06-15T00:00:00Z");

  it("is true when past due date and unpaid", () => {
    expect(isOverdue("2026-06-01", "sent", today)).toBe(true);
  });

  it("is false when paid, even if past due date", () => {
    expect(isOverdue("2026-06-01", "paid", today)).toBe(false);
  });

  it("is false for drafts regardless of due date", () => {
    expect(isOverdue("2026-06-01", "draft", today)).toBe(false);
  });

  it("is false when due date is in the future", () => {
    expect(isOverdue("2026-07-01", "sent", today)).toBe(false);
  });

  it("is false with no due date", () => {
    expect(isOverdue(null, "sent", today)).toBe(false);
  });
});
