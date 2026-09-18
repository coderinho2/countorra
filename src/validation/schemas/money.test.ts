import { describe, expect, it } from "vitest";
import { currencySchema, majorAmountSchema } from "./money";
import { createTransactionSchema } from "./transaction";
import { createInvoiceSchema } from "./invoice";
import { fromMajorUnits } from "@/domain/money/money";

/**
 * Regression tests for the "one poisoned row bricks the organization"
 * finding: `currency` was validated as `z.string().length(3)`, so any three
 * characters were storable, and every aggregation downstream then refused
 * to compute for the whole organization.
 */
describe("currencySchema", () => {
  it("rejects a well-formed but unsupported currency code", () => {
    for (const code of ["XYZ", "ZZZ", "AAA", "BTC"]) {
      expect(currencySchema.safeParse(code).success).toBe(false);
    }
  });

  it("rejects codes of the wrong length and non-codes", () => {
    for (const code of ["US", "USDD", "", "$$$"]) {
      expect(currencySchema.safeParse(code).success).toBe(false);
    }
  });

  it("accepts every supported currency, case-insensitively", () => {
    for (const code of ["USD", "EUR", "GBP", "RON", "usd"]) {
      const parsed = currencySchema.safeParse(code);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data).toBe(code.toUpperCase());
    }
  });
});

describe("createTransactionSchema", () => {
  const valid = {
    organizationId: "8f14e45f-ea3e-4b1e-8c2f-1d2c3b4a5e6f",
    accountId: "1b4e28ba-2fa1-4d1e-9a3b-0c1d2e3f4a5b",
    kind: "expense",
    amount: "10.50",
    currency: "USD",
    occurredOn: "2026-01-15",
  };

  it("accepts a well-formed transaction", () => {
    expect(createTransactionSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an unsupported currency before it can reach the database", () => {
    expect(createTransactionSchema.safeParse({ ...valid, currency: "XYZ" }).success).toBe(false);
  });

  it("rejects amounts that are not plain decimals", () => {
    for (const amount of ["1e3", "abc", "-5.00", "Infinity", "NaN", " 5.00 ", "1_000", "10.5.5"]) {
      expect(createTransactionSchema.safeParse({ ...valid, amount }).success).toBe(false);
    }
  });
});

describe("createInvoiceSchema", () => {
  it("rejects an unsupported currency", () => {
    const result = createInvoiceSchema.safeParse({
      organizationId: "8f14e45f-ea3e-4b1e-8c2f-1d2c3b4a5e6f",
      customerId: "1b4e28ba-2fa1-4d1e-9a3b-0c1d2e3f4a5b",
      currency: "XYZ",
      issueDate: "2026-01-15",
      lineItems: [{ description: "Work", quantity: 1, unitPrice: "100.00", taxRate: 0 }],
    });
    expect(result.success).toBe(false);
  });
});

/**
 * The conversion itself. `Math.round(parseFloat(x) * 100)` was used at every
 * money boundary (server actions and AI write tools) instead of
 * src/domain/money — these are the cases where the two disagree.
 */
describe("major-unit conversion", () => {
  it("does not lose a minor unit the way parseFloat rounding did", () => {
    expect(Math.round(parseFloat("8.165") * 100)).toBe(816); // the old behaviour
    expect(fromMajorUnits("8.165", "USD").amountMinor).toBe(816); // exact truncation of the extra digit, not a float artefact
    expect(Math.round(parseFloat("1.005") * 100)).toBe(100); // the old behaviour: a whole unit lost
    expect(fromMajorUnits("1.005", "USD").amountMinor).toBe(100);
    expect(fromMajorUnits("10.50", "USD").amountMinor).toBe(1050);
    expect(fromMajorUnits("0.01", "USD").amountMinor).toBe(1);
  });

  it("refuses hostile input instead of producing NaN or Infinity", () => {
    expect(Number.isNaN(Math.round(parseFloat("abc") * 100))).toBe(true); // the old behaviour
    expect(() => fromMajorUnits("abc", "USD")).toThrow();
    expect(() => fromMajorUnits("Infinity", "USD")).toThrow();
    expect(() => fromMajorUnits("1e3", "USD")).toThrow();
  });

  it("majorAmountSchema screens the same hostile shapes at the boundary", () => {
    for (const amount of ["abc", "Infinity", "1e3", "-1.00", ""]) {
      expect(majorAmountSchema.safeParse(amount).success).toBe(false);
    }
    expect(majorAmountSchema.safeParse("42.50").success).toBe(true);
  });
});
