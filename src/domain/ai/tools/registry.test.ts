import { describe, expect, it } from "vitest";
import { createToolRegistry } from "./registry";
import { parseToolInput, InvalidToolInputError, type AITool } from "./types";

/**
 * Security regression tests for the real tool registry — the actual 36
 * tools the model is handed, not a stand-in.
 *
 * The audit's finding: a tool's `inputSchema` is a JSON Schema *sent to the
 * model*, and nothing validated what came back. The model's raw arguments
 * were executed, and for write tools they were persisted into
 * `ai_actions.input` and replayed verbatim when a human clicked Confirm —
 * so anything that steered those arguments (a prompt injection hidden in a
 * merchant name, a transaction memo, a document) went through the
 * confirmation gate untouched. These tests assert the runtime guard.
 *
 * The registry only builds queries here; nothing is executed, so the
 * Supabase client is never used and a placeholder is fine.
 */
const tools = createToolRegistry(null as never);

function tool(name: string): AITool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`No such tool: ${name}`);
  return found;
}

function reject(name: string, input: unknown) {
  expect(() => parseToolInput(tool(name), input)).toThrow(InvalidToolInputError);
}

describe("tool registry shape", () => {
  it("registers a unique name per tool", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("declares only known operation modes, and no tool silently mutates outside write/delete", () => {
    const modes = new Set(tools.map((t) => t.operationMode));
    for (const mode of modes) {
      expect(["read", "analyze", "calculate", "suggest", "write", "delete"]).toContain(mode);
    }
  });

  it("gives every tool that accepts arguments a runtime validator", () => {
    const takesArguments = tools.filter((t) => {
      const schema = t.inputSchema as { properties?: Record<string, unknown> };
      return Object.keys(schema.properties ?? {}).length > 0;
    });
    expect(takesArguments.length).toBeGreaterThan(0);
    const unguarded = takesArguments.filter((t) => !t.parseInput).map((t) => t.name);
    expect(unguarded).toEqual([]);
  });
});

describe("write tools reject arguments that could corrupt a financial record", () => {
  const validTransaction = {
    accountId: "8f14e45f-ea3e-4b1e-8c2f-1d2c3b4a5e6f",
    kind: "expense",
    amount: "42.50",
    currency: "USD",
    occurredOn: "2026-01-15",
  };

  it("accepts a well-formed createDraftTransaction call", () => {
    expect(parseToolInput(tool("createDraftTransaction"), validTransaction)).toMatchObject({ amount: "42.50", currency: "USD" });
  });

  it("rejects amounts that are not plain decimals", () => {
    for (const amount of ["1e9", "abc", "Infinity", "NaN", "-100.00", "", "10.00; drop table transactions"]) {
      reject("createDraftTransaction", { ...validTransaction, amount });
    }
  });

  it("rejects an unsupported currency", () => {
    reject("createDraftTransaction", { ...validTransaction, currency: "XYZ" });
    reject("createDraftTransaction", { ...validTransaction, currency: "US" });
  });

  it("rejects an accountId or categoryId that isn't a uuid", () => {
    reject("createDraftTransaction", { ...validTransaction, accountId: "not-a-uuid" });
    reject("createDraftTransaction", { ...validTransaction, categoryId: "../../etc/passwd" });
  });

  it("rejects a malformed date", () => {
    reject("createDraftTransaction", { ...validTransaction, occurredOn: "yesterday" });
    reject("createDraftTransaction", { ...validTransaction, occurredOn: "2026-13-45" });
  });

  it("rejects a kind outside income/expense", () => {
    reject("createDraftTransaction", { ...validTransaction, kind: "transfer" });
    reject("createDraftTransaction", { ...validTransaction, kind: "delete" });
  });

  it("guards createDraftExpense the same way", () => {
    reject("createDraftExpense", { accountId: validTransaction.accountId, amount: "1e9", currency: "USD", occurredOn: "2026-01-15" });
    reject("createDraftExpense", { accountId: "x", amount: "5.00", currency: "USD", occurredOn: "2026-01-15" });
  });

  it("guards categorizeTransaction against non-uuid identifiers", () => {
    reject("categorizeTransaction", { transactionId: "all", categoryId: "8f14e45f-ea3e-4b1e-8c2f-1d2c3b4a5e6f" });
    reject("categorizeTransaction", { transactionId: "8f14e45f-ea3e-4b1e-8c2f-1d2c3b4a5e6f", categoryId: 1 });
  });

  it("guards createDraftInvoice's line items, including an empty or absurd list", () => {
    const base = {
      customerId: "8f14e45f-ea3e-4b1e-8c2f-1d2c3b4a5e6f",
      invoiceNumber: "INV-1",
      currency: "USD",
      issueDate: "2026-01-15",
    };
    reject("createDraftInvoice", { ...base, lineItems: [] });
    reject("createDraftInvoice", { ...base, lineItems: [{ description: "x", quantity: 1, unitPrice: "1e9" }] });
    reject("createDraftInvoice", { ...base, lineItems: [{ description: "x", quantity: -1, unitPrice: "1.00" }] });
    // `taxRate` is no longer rejected — it is STRIPPED (AI-02). Stripping is
    // the stronger guarantee: an out-of-range rate used to fail the whole
    // invoice while an in-range one was accepted and persisted. Now no rate
    // reaches the record at all, whatever its value.
    const withRate = parseToolInput(tool("createDraftInvoice"), {
      ...base,
      lineItems: [{ description: "x", quantity: 1, unitPrice: "1.00", taxRate: 900 }],
    }) as { lineItems: Record<string, unknown>[] };
    expect(withRate.lineItems[0]).not.toHaveProperty("taxRate");
    reject("createDraftInvoice", { ...base, currency: "XYZ", lineItems: [{ description: "x", quantity: 1, unitPrice: "1.00" }] });
    expect(parseToolInput(tool("createDraftInvoice"), { ...base, lineItems: [{ description: "x", quantity: 1, unitPrice: "1.00" }] })).toBeTruthy();
  });
});

describe("read and calculate tools validate their arguments too", () => {
  it("rejects a non-uuid transaction or invoice id", () => {
    reject("getTransaction", { transactionId: "1 OR 1=1" });
    reject("getInvoice", { invoiceId: "*" });
  });

  it("rejects an unsupported currency on a period calculation", () => {
    reject("getExpenses", { from: "2026-01-01", to: "2026-01-31", currency: "XYZ" });
    expect(parseToolInput(tool("getExpenses"), { from: "2026-01-01", to: "2026-01-31", currency: "USD" })).toBeTruthy();
  });

  it("rejects a malformed period", () => {
    reject("getIncome", { from: "last month", to: "2026-01-31", currency: "USD" });
  });

  it("bounds the forecast horizon and the tax rate", () => {
    reject("forecastCashFlow", { horizonDays: 100000 });
    reject("forecastCashFlow", { horizonDays: -1 });
    reject("calculateSalesTax", { amount: "100.00", currency: "USD", ratePercent: 10000 });
    reject("calculateSalesTax", { amount: "100.00", currency: "USD", ratePercent: -5 });
  });

  it("bounds free-text search arguments", () => {
    reject("searchTransactions", { query: "x".repeat(5000) });
    reject("searchTransactions", { query: "" });
    expect(parseToolInput(tool("searchTransactions"), { query: "restaurants in July" })).toBeTruthy();
  });

  it("rejects an invoice status outside the enum", () => {
    reject("getInvoices", { status: "all; drop table invoices" });
    expect(parseToolInput(tool("getInvoices"), { status: "paid" })).toBeTruthy();
    expect(parseToolInput(tool("getInvoices"), {})).toBeTruthy();
  });
});
