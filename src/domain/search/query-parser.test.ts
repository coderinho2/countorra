import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "./query-parser";

const REFERENCE = new Date("2026-08-15T00:00:00Z");

describe("parseSearchQuery", () => {
  it("parses a merchant/category free-text query with a month", () => {
    const result = parseSearchQuery("restaurants july", REFERENCE);
    expect(result.monthStart).toBe("2026-07-01");
    expect(result.monthEnd).toBe("2026-07-31");
    expect(result.freeText).toBe("restaurants");
  });

  it("parses a resource keyword plus free text", () => {
    const result = parseSearchQuery("invoice acme", REFERENCE);
    expect(result.resourceType).toBe("invoice");
    expect(result.freeText).toBe("acme");
  });

  it("parses an amount threshold with a currency symbol", () => {
    const result = parseSearchQuery("expenses over €500", REFERENCE);
    expect(result.kind).toBe("expense");
    expect(result.amountMinMinor).toBe(50_000);
  });

  it("parses 'overdue invoices'", () => {
    const result = parseSearchQuery("overdue invoices", REFERENCE);
    expect(result.overdueOnly).toBe(true);
    expect(result.resourceType).toBe("invoice");
  });

  it("parses 'transactions from Uber'", () => {
    const result = parseSearchQuery("transactions from Uber", REFERENCE);
    expect(result.resourceType).toBe("transaction");
    expect(result.freeText).toBe("from uber");
  });

  it("parses an amount over 1000 lei", () => {
    const result = parseSearchQuery("transactions over 1000 lei", REFERENCE);
    expect(result.amountMinMinor).toBe(100_000);
  });

  it("parses 'subscriptions'", () => {
    const result = parseSearchQuery("subscriptions", REFERENCE);
    expect(result.recurringOnly).toBe(true);
  });

  it("resolves a past-this-year month to this year", () => {
    const result = parseSearchQuery("vat june", REFERENCE); // June is before August (reference)
    expect(result.monthStart).toBe("2026-06-01");
  });

  it("resolves a not-yet-happened month to last year", () => {
    const result = parseSearchQuery("vat december", REFERENCE); // December hasn't happened yet in 2026
    expect(result.monthStart).toBe("2025-12-01");
  });

  it("respects an explicit year", () => {
    const result = parseSearchQuery("expenses march 2024", REFERENCE);
    expect(result.monthStart).toBe("2024-03-01");
    expect(result.monthEnd).toBe("2024-03-31");
  });

  it("parses an under threshold", () => {
    const result = parseSearchQuery("expenses under $50", REFERENCE);
    expect(result.amountMaxMinor).toBe(5_000);
  });

  it("returns all-null/empty for an empty query", () => {
    const result = parseSearchQuery("", REFERENCE);
    expect(result.resourceType).toBeNull();
    expect(result.freeText).toBe("");
  });
});
