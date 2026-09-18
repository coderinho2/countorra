import { type CurrencyCode, type Money, add, money, multiply, percentageOf, subtract, sum, zero } from "@/domain/money/money";

/**
 * Invoice totals are always recomputed from line items server-side
 * (DESIGN brief / product spec §15) — never trusted from client input,
 * even though `invoices.subtotal_minor` etc. are stored columns (for fast
 * list rendering). This is the one place that computation happens, built
 * entirely on src/domain/money so it inherits the same BigInt-exact
 * rounding guarantees.
 */

export interface LineItemInput {
  quantity: number;
  unitPriceMinor: number;
  taxRate: number;
  discountRate: number;
}

export interface LineItemTotals {
  /** Pre-tax, post-discount amount for this line. */
  amount: Money;
  taxAmount: Money;
}

export function calculateLineItemTotals(item: LineItemInput, currency: CurrencyCode): LineItemTotals {
  const gross = multiply(money(item.unitPriceMinor, currency), item.quantity, 3);
  const discount = percentageOf(gross, item.discountRate);
  const amount = subtract(gross, discount);
  const taxAmount = percentageOf(amount, item.taxRate);
  return { amount, taxAmount };
}

export interface InvoiceTotals {
  subtotal: Money;
  tax: Money;
  total: Money;
}

export function calculateInvoiceTotals(items: LineItemInput[], currency: CurrencyCode): InvoiceTotals {
  const lineTotals = items.map((item) => calculateLineItemTotals(item, currency));
  const subtotal = sum(
    lineTotals.map((t) => t.amount),
    currency,
  );
  const tax = sum(
    lineTotals.map((t) => t.taxAmount),
    currency,
  );
  return { subtotal, tax, total: add(subtotal, tax) };
}

export function isOverdue(dueDate: string | null, status: string, today: Date = new Date()): boolean {
  if (!dueDate || status === "paid" || status === "void" || status === "draft") return false;
  return new Date(dueDate) < new Date(today.toISOString().slice(0, 10));
}

export const ZERO_TOTALS = (currency: CurrencyCode): InvoiceTotals => ({
  subtotal: zero(currency),
  tax: zero(currency),
  total: zero(currency),
});
