import { describe, expect, it } from "vitest";
import { normalizeProviderAccount, normalizeProviderTransaction } from "@/domain/bank-connections/normalization";
import { providerAccountSchema, providerTransactionSchema } from "@/domain/bank-connections/provider";
import {
  classifyPlaidWebhook,
  pickCurrency,
  plaidAmountToDecimal,
  plaidBalanceToDecimal,
  plaidSyncResponseSchema,
  plaidWebhookBodySchema,
  toProviderAccount,
  toProviderTransaction,
  type PlaidAccount,
  type PlaidTransaction,
} from "./mapping";

/**
 * Plaid's shapes, mapped onto the provider contract.
 *
 * Every case here is checked twice: the mapping produces what it should, and
 * the result passes the contract's own strict schema — so a mapping that
 * drifts cannot reach the sync engine.
 */

const transaction = (overrides: Partial<PlaidTransaction> = {}): PlaidTransaction => ({
  transaction_id: "plaid-tx-1",
  account_id: "plaid-acct-1",
  pending_transaction_id: null,
  pending: false,
  amount: 42.5,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
  date: "2026-09-11",
  authorized_date: "2026-09-10",
  name: "CORNER COFFEE 0042",
  merchant_name: "Corner Coffee",
  personal_finance_category: { primary: "FOOD_AND_DRINK" },
  ...overrides,
});

const account = (overrides: Partial<PlaidAccount> = {}): PlaidAccount => ({
  account_id: "plaid-acct-1",
  name: "Plaid Checking",
  official_name: "Plaid Gold Standard 0% Interest Checking",
  mask: "0000",
  type: "depository",
  subtype: "checking",
  balances: { current: 110, available: 100, iso_currency_code: "USD", unofficial_currency_code: null },
  ...overrides,
});

describe("amounts", () => {
  it("renders a JSON number as an exact decimal string", () => {
    expect(plaidAmountToDecimal(42.5)).toBe("42.5");
    expect(plaidAmountToDecimal(12.34)).toBe("12.34");
    expect(plaidAmountToDecimal(0)).toBe("0");
    expect(plaidAmountToDecimal(-18.99)).toBe("18.99");
    expect(plaidAmountToDecimal(1500)).toBe("1500");
  });

  it("refuses a number that cannot be a monetary amount, instead of rounding it into the books", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e15]) {
      expect(plaidAmountToDecimal(value), String(value)).toBeNull();
    }
  });

  it("flips the sign only for the account kinds where Plaid reports what is owed", () => {
    // Depository: 110 in the account is +110.
    expect(plaidBalanceToDecimal(110, false)).toBe("110");
    expect(plaidBalanceToDecimal(-25.5, false)).toBe("-25.5");
    // Credit card: Plaid's +410 means 410 owed, which is -410 in the ledger's
    // convention.
    expect(plaidBalanceToDecimal(410, true)).toBe("-410");
    expect(plaidBalanceToDecimal(-15, true)).toBe("15");
    expect(plaidBalanceToDecimal(0, true)).toBe("0");
    expect(plaidBalanceToDecimal(null, true)).toBeNull();
    expect(plaidBalanceToDecimal(undefined, false)).toBeNull();
  });

  it("takes the ISO currency, falls back to the unofficial one, and otherwise none", () => {
    expect(pickCurrency("USD", null)).toBe("USD");
    expect(pickCurrency(null, "CAD")).toBe("CAD");
    expect(pickCurrency(null, "BITCOIN")).toBeNull();
    expect(pickCurrency(null, null)).toBeNull();
  });
});

describe("transactions", () => {
  it("maps a posted transaction, and the result satisfies the contract", () => {
    const mapped = toProviderTransaction(transaction());
    expect(mapped).toEqual({
      providerTransactionId: "plaid-tx-1",
      providerAccountId: "plaid-acct-1",
      pendingProviderTransactionId: null,
      status: "POSTED",
      direction: "DEBIT",
      amount: "42.5",
      currency: "USD",
      // When it happened, not when it cleared.
      transactionDate: "2026-09-10",
      postedDate: "2026-09-11",
      authorizedDate: "2026-09-10",
      merchantName: "Corner Coffee",
      description: "CORNER COFFEE 0042",
      categoryHint: "FOOD_AND_DRINK",
    });
    expect(providerTransactionSchema.safeParse(mapped).success).toBe(true);
    const normalized = normalizeProviderTransaction(mapped);
    expect(normalized).toMatchObject({ ok: true, transaction: { amountMinor: 4250, currency: "USD" } });
  });

  it("makes money leaving the account an expense and money arriving an income", () => {
    expect(toProviderTransaction(transaction({ amount: 42.5 })).direction).toBe("DEBIT");
    expect(toProviderTransaction(transaction({ amount: -4200 })).direction).toBe("CREDIT");
    expect(toProviderTransaction(transaction({ amount: -4200 })).amount).toBe("4200");
    expect(toProviderTransaction(transaction({ amount: 0 })).direction).toBe("DEBIT");
  });

  it("maps a pending transaction with no posted date, and the id it will replace", () => {
    const pending = toProviderTransaction(transaction({ pending: true, authorized_date: null }));
    expect(pending).toMatchObject({ status: "PENDING", postedDate: null, transactionDate: "2026-09-11" });
    const posted = toProviderTransaction(transaction({ transaction_id: "plaid-tx-2", pending_transaction_id: "plaid-tx-1" }));
    expect(posted.pendingProviderTransactionId).toBe("plaid-tx-1");
  });

  it("keeps an unrepresentable amount out of the ledger rather than guessing", () => {
    const mapped = toProviderTransaction(transaction({ amount: Number.NaN }));
    expect(mapped.currency).toBeNull();
    expect(providerTransactionSchema.safeParse(mapped).success).toBe(true);
    // No currency, so normalization refuses it and it is counted as rejected.
    expect(normalizeProviderTransaction(mapped)).toMatchObject({ ok: false, reason: "CURRENCY_MISSING" });
  });

  it("falls back from the merchant to the raw name, and to no category", () => {
    const mapped = toProviderTransaction(transaction({ merchant_name: null, personal_finance_category: null, category: ["Food and Drink", "Coffee"] }));
    expect(mapped).toMatchObject({ merchantName: null, description: "CORNER COFFEE 0042", categoryHint: "Food and Drink" });
    expect(toProviderTransaction(transaction({ name: null, merchant_name: null, personal_finance_category: null, category: null })).categoryHint).toBeNull();
  });
});

describe("accounts", () => {
  it("maps a depository account onto the contract, keeping only a short mask", () => {
    const mapped = toProviderAccount(account({ mask: "9876543210" }));
    expect(mapped).toEqual({
      providerAccountId: "plaid-acct-1",
      name: "Plaid Checking",
      type: "DEPOSITORY",
      subtype: "checking",
      mask: "9876543210",
      currency: "USD",
      currentBalance: "110",
      availableBalance: "100",
      state: "OPEN",
    });
    expect(providerAccountSchema.safeParse(mapped).success).toBe(true);
    // Normalization is what actually shortens it: four characters, never an
    // account number.
    expect(normalizeProviderAccount(mapped).mask).toBe("3210");
  });

  it("maps every Plaid account type, and anything unknown to OTHER", () => {
    const types: [string, string][] = [
      ["depository", "DEPOSITORY"],
      ["credit", "CREDIT"],
      ["loan", "LOAN"],
      ["investment", "INVESTMENT"],
      ["brokerage", "INVESTMENT"],
      ["other", "OTHER"],
      ["something-new", "OTHER"],
    ];
    for (const [plaidType, expected] of types) expect(toProviderAccount(account({ type: plaidType })).type, plaidType).toBe(expected);
  });

  it("reports a credit card's balance in the ledger's direction", () => {
    const card = toProviderAccount(account({ type: "credit", subtype: "credit card", balances: { current: 410.25, available: 1589.75, iso_currency_code: "USD" } }));
    expect(card).toMatchObject({ type: "CREDIT", subtype: "credit card", currentBalance: "-410.25", availableBalance: "-1589.75" });
    expect(providerAccountSchema.safeParse(card).success).toBe(true);
  });

  it("survives an account with no name, subtype, mask or balances", () => {
    const sparse = toProviderAccount({ account_id: "a", name: null, official_name: null, mask: null, type: null, subtype: null, balances: null });
    expect(sparse).toMatchObject({ name: "Bank account", type: "OTHER", subtype: null, mask: null, currency: null, currentBalance: null });
    expect(providerAccountSchema.safeParse(sparse).success).toBe(true);
  });
});

describe("the sync response", () => {
  it("accepts a real-shaped page and rejects one missing its cursor", () => {
    const page = { added: [transaction()], modified: [], removed: [{ transaction_id: "gone" }], next_cursor: "CURSOR_1", has_more: false, request_id: "req" };
    expect(plaidSyncResponseSchema.safeParse(page).success).toBe(true);
    expect(plaidSyncResponseSchema.safeParse({ ...page, next_cursor: "" }).success).toBe(false);
    expect(plaidSyncResponseSchema.safeParse({ ...page, has_more: "no" }).success).toBe(false);
  });
});

describe("webhooks", () => {
  const classify = (body: Record<string, unknown>) =>
    classifyPlaidWebhook(plaidWebhookBodySchema.parse(body), { providerEventId: "a".repeat(64), occurredAt: "2026-09-16T10:00:00.000Z" });

  it("turns every transactions webhook into one instruction: fetch from Plaid", () => {
    for (const code of ["SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE", "INITIAL_UPDATE", "HISTORICAL_UPDATE", "TRANSACTIONS_REMOVED"]) {
      expect(classify({ webhook_type: "TRANSACTIONS", webhook_code: code, item_id: "item-1" }), code).toMatchObject({ type: "TRANSACTIONS_UPDATED", providerConnectionId: "item-1" });
    }
  });

  it("reads ITEM:ERROR through its error code", () => {
    expect(classify({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "item-1", error: { error_code: "ITEM_LOGIN_REQUIRED" } }).type).toBe("CONNECTION_REQUIRES_REAUTH");
    expect(classify({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "item-1", error: { error_code: "USER_PERMISSION_REVOKED" } }).type).toBe("CONNECTION_REVOKED");
    expect(classify({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "item-1", error: { error_code: "INSTITUTION_DOWN" } }).type).toBe("CONNECTION_ERROR");
    expect(classify({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "item-1" }).type).toBe("CONNECTION_ERROR");
  });

  it("maps the item lifecycle events Countorra acts on", () => {
    expect(classify({ webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION", item_id: "i" }).type).toBe("CONSENT_EXPIRING");
    expect(classify({ webhook_type: "ITEM", webhook_code: "PENDING_DISCONNECT", item_id: "i" }).type).toBe("CONNECTION_REQUIRES_REAUTH");
    expect(classify({ webhook_type: "ITEM", webhook_code: "USER_PERMISSION_REVOKED", item_id: "i" }).type).toBe("CONNECTION_REVOKED");
    expect(classify({ webhook_type: "ITEM", webhook_code: "LOGIN_REPAIRED", item_id: "i" }).type).toBe("CONNECTION_RECOVERED");
    expect(classify({ webhook_type: "ITEM", webhook_code: "NEW_ACCOUNTS_AVAILABLE", item_id: "i" }).type).toBe("TRANSACTIONS_UPDATED");
  });

  it("acknowledges anything else as unsupported instead of inventing a meaning", () => {
    for (const body of [
      { webhook_type: "ITEM", webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED", item_id: "i" },
      { webhook_type: "ASSETS", webhook_code: "PRODUCT_READY" },
      { webhook_type: "INVESTMENTS_TRANSACTIONS", webhook_code: "DEFAULT_UPDATE", item_id: "i" },
      { webhook_type: "LIABILITIES", webhook_code: "DEFAULT_UPDATE", item_id: "i" },
    ]) {
      expect(classify(body).type, `${body.webhook_type}:${body.webhook_code}`).toBe("UNSUPPORTED");
    }
  });

  it("carries the provider's own event identity and time", () => {
    const event = classify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1" });
    expect(event.providerEventId).toHaveLength(64);
    expect(event.providerEventType).toBe("TRANSACTIONS:SYNC_UPDATES_AVAILABLE");
    expect(event.occurredAt).toBe("2026-09-16T10:00:00.000Z");
  });
});

describe("performance", () => {
  it("maps 5,000 transactions in well under a second, with exact totals", () => {
    const raw = Array.from({ length: 5000 }, (_, i) => transaction({ transaction_id: `tx-${i}`, amount: (i % 100) + 0.25 }));
    const started = performance.now();
    let minor = 0;
    for (const item of raw) {
      const normalized = normalizeProviderTransaction(toProviderTransaction(item));
      if (normalized.ok) minor += normalized.transaction.amountMinor ?? 0;
    }
    const expected = raw.reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
    expect(minor).toBe(expected);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
