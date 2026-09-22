import { describe, expect, it } from "vitest";
import { calculateNetWorth, type NetWorthAccount } from "./net-worth";

const account = (overrides: Partial<NetWorthAccount>): NetWorthAccount => ({
  id: overrides.name ?? "a",
  name: "Account",
  kind: "bank",
  currency: "USD",
  balanceMinor: 0,
  isArchived: false,
  ...overrides,
});

describe("calculateNetWorth", () => {
  it("is assets minus liabilities", () => {
    const r = calculateNetWorth(
      [account({ name: "Checking", balanceMinor: 500_000 }), account({ name: "Savings", balanceMinor: 1_000_000 }), account({ name: "Card", kind: "credit_card", balanceMinor: -120_000 })],
      "USD",
    );
    expect(r.totalAssets.amountMinor).toBe(1_500_000);
    expect(r.totalLiabilities.amountMinor).toBe(120_000);
    expect(r.netWorth.amountMinor).toBe(1_380_000);
    expect(r.liabilities.map((l) => l.name)).toEqual(["Card"]);
  });

  it("counts an overdraft as money owed, and a card in credit as an asset", () => {
    const r = calculateNetWorth([account({ name: "Checking", balanceMinor: -2_000 }), account({ name: "Card", kind: "credit_card", balanceMinor: 1_500 })], "USD");
    expect(r.liabilities.map((l) => [l.name, l.amount.amountMinor])).toEqual([["Checking", 2_000]]);
    expect(r.assets.map((l) => [l.name, l.amount.amountMinor])).toEqual([["Card", 1_500]]);
    expect(r.netWorth.amountMinor).toBe(-500);
  });

  it("treats a zero balance as neither owed nor owned", () => {
    expect(calculateNetWorth([account({ balanceMinor: 0 })], "USD").netWorth.amountMinor).toBe(0);
  });

  it("leaves out archived and other-currency accounts, and counts them", () => {
    const r = calculateNetWorth([account({ name: "Old", balanceMinor: 900, isArchived: true }), account({ name: "EUR", currency: "EUR", balanceMinor: 900 })], "USD");
    expect(r.netWorth.amountMinor).toBe(0);
    expect(r.excluded).toEqual({ archivedAccounts: 1, otherCurrencyAccounts: 1 });
  });

  it("says what it cannot see", () => {
    expect(calculateNetWorth([], "USD").coverage).toMatch(/not included/);
  });
});
