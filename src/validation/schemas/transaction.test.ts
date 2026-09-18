import { describe, expect, it } from "vitest";
import { createTransactionSchema } from "./transaction";

const valid = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  kind: "expense" as const,
  amount: "10.50",
  currency: "EUR",
  occurredOn: "2026-01-15",
};

describe("createTransactionSchema", () => {
  it("accepts a valid transaction", () => {
    expect(createTransactionSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts whole-number amounts without decimals", () => {
    expect(createTransactionSchema.safeParse({ ...valid, amount: "10" }).success).toBe(true);
  });

  it("rejects amounts with more than 2 decimal places", () => {
    expect(createTransactionSchema.safeParse({ ...valid, amount: "10.505" }).success).toBe(false);
  });

  it("rejects a negative amount string (direction comes from `kind`, not sign)", () => {
    expect(createTransactionSchema.safeParse({ ...valid, amount: "-10.50" }).success).toBe(false);
  });

  it("rejects an invalid currency length", () => {
    expect(createTransactionSchema.safeParse({ ...valid, currency: "EURO" }).success).toBe(false);
  });

  it("rejects an invalid kind", () => {
    expect(createTransactionSchema.safeParse({ ...valid, kind: "refund" }).success).toBe(false);
  });

  it("rejects a malformed organizationId", () => {
    expect(createTransactionSchema.safeParse({ ...valid, organizationId: "not-a-uuid" }).success).toBe(false);
  });
});
