import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  BankProviderError,
  MAX_PAGE_SIZE,
  ProviderSecret,
  SECRET_REF_PATTERN,
  providerTransactionsPageSchema,
  environmentMatches,
  providerWebhookEventSchema,
  resolveBankProvider,
  runBankProviderCall,
  type BankConnectionProvider,
} from "./provider";

const transaction = (id: string, overrides: Record<string, unknown> = {}) => ({
  providerTransactionId: id,
  providerAccountId: "acct-1",
  pendingProviderTransactionId: null,
  status: "POSTED",
  direction: "DEBIT",
  amount: "12.34",
  currency: "USD",
  transactionDate: "2026-09-01",
  postedDate: "2026-09-02",
  authorizedDate: null,
  merchantName: "Corner Coffee",
  description: "CORNER COFFEE 1234",
  categoryHint: null,
  ...overrides,
});

const page = (overrides: Record<string, unknown> = {}) => ({ accounts: [], added: [transaction("t1")], modified: [], removed: [], nextCursor: "cursor-1", hasMore: false, ...overrides });

describe("provider page validation", () => {
  it("accepts a well-formed page", () => {
    expect(providerTransactionsPageSchema.safeParse(page()).success).toBe(true);
  });

  it("refuses floats, signed amounts and sub-cent precision beyond four places", () => {
    for (const amount of [12.34, "-12.34", "12.34567", "1e3", ""]) {
      expect(providerTransactionsPageSchema.safeParse(page({ added: [transaction("t1", { amount })] })).success).toBe(false);
    }
  });

  it("refuses unknown fields, so a provider cannot smuggle extra data through", () => {
    expect(providerTransactionsPageSchema.safeParse(page({ added: [transaction("t1", { accountNumber: "123456789" })] })).success).toBe(false);
    expect(providerTransactionsPageSchema.safeParse({ ...page(), accessToken: "x" }).success).toBe(false);
  });

  it("bounds the page size", () => {
    const added = Array.from({ length: MAX_PAGE_SIZE }, (_, i) => transaction(`t${i}`));
    expect(providerTransactionsPageSchema.safeParse(page({ added })).success).toBe(true);
    expect(providerTransactionsPageSchema.safeParse(page({ added, modified: [transaction("extra")] })).success).toBe(false);
  });

  it("refuses the same transaction twice in one page", () => {
    expect(providerTransactionsPageSchema.safeParse(page({ added: [transaction("t1")], modified: [transaction("t1")] })).success).toBe(false);
  });

  it("refuses non-ISO dates and lowercase currency codes", () => {
    expect(providerTransactionsPageSchema.safeParse(page({ added: [transaction("t1", { transactionDate: "09/01/2026" })] })).success).toBe(false);
    expect(providerTransactionsPageSchema.safeParse(page({ added: [transaction("t1", { currency: "usd" })] })).success).toBe(false);
  });

  it("validates webhook events strictly", () => {
    const event = { providerEventId: "evt-1", providerEventType: "TRANSACTIONS:SYNC_UPDATES_AVAILABLE", type: "TRANSACTIONS_UPDATED", providerConnectionId: "item-1", occurredAt: "2026-09-15T12:00:00Z" };
    expect(providerWebhookEventSchema.safeParse(event).success).toBe(true);
    expect(providerWebhookEventSchema.safeParse({ ...event, type: "DELETE_EVERYTHING" }).success).toBe(false);
    expect(providerWebhookEventSchema.safeParse({ ...event, transactions: [] }).success).toBe(false);
  });
});

describe("provider secrets never leak by accident", () => {
  it("does not appear in JSON, string conversion or util.inspect", () => {
    const secret = new ProviderSecret("access-sandbox-0000-super-secret");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[provider secret]"}');
    expect(`${secret}`).toBe("[provider secret]");
    expect(inspect({ secret })).not.toContain("super-secret");
    expect(secret.reveal()).toBe("access-sandbox-0000-super-secret");
  });

  it("stores references, never tokens", () => {
    expect(SECRET_REF_PATTERN.test("vault:5f0c7a52-9a57-4a55-9d0e-6a8c7a1f7d21")).toBe(true);
    expect(SECRET_REF_PATTERN.test("access-sandbox-1234567890")).toBe(false);
    expect(SECRET_REF_PATTERN.test("vault:short")).toBe(false);
  });
});

describe("running a provider call", () => {
  const schema = providerTransactionsPageSchema;

  it("returns validated data", async () => {
    const outcome = await runBankProviderCall(async () => page(), schema);
    expect(outcome.ok).toBe(true);
  });

  it("maps a malformed response to a category", async () => {
    expect(await runBankProviderCall(async () => ({ nope: true }), schema)).toMatchObject({ ok: false, category: "MALFORMED_PROVIDER_RESPONSE" });
  });

  it("keeps an adapter's category and discards any other error's message", async () => {
    expect(await runBankProviderCall(async () => Promise.reject(new BankProviderError("REAUTH_REQUIRED")), schema)).toMatchObject({ ok: false, category: "REAUTH_REQUIRED" });
    const outcome = await runBankProviderCall(async () => Promise.reject(new Error("token access-sandbox-123 invalid for account 123456789")), schema);
    expect(outcome).toMatchObject({ ok: false, category: "PROVIDER_UNAVAILABLE" });
    expect(JSON.stringify(outcome)).not.toContain("access-sandbox");
  });

  it("times out and aborts a slow provider", async () => {
    let aborted = false;
    const outcome = await runBankProviderCall(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(page());
          });
        }),
      schema,
      20,
    );
    expect(outcome).toMatchObject({ ok: false, category: "PROVIDER_TIMEOUT" });
    expect(aborted).toBe(true);
  });
});

describe("resolving a provider", () => {
  it("reports NOT_CONFIGURED when this deployment has none", () => {
    const availability = resolveBankProvider([]);
    expect(availability).toMatchObject({ available: false, reason: "NOT_CONFIGURED" });
    expect(resolveBankProvider([], "plaid").available).toBe(false);
  });

  it("finds a registered provider by id", () => {
    const fake = { id: "fixture", version: "1", displayName: "Fixture" } as BankConnectionProvider;
    expect(resolveBankProvider([fake], "fixture")).toEqual({ available: true, provider: fake });
    expect(resolveBankProvider([fake], "plaid").available).toBe(false);
  });
});

describe("the provider environment boundary", () => {
  /**
   * The rule a connection's access token depends on: it may only be used
   * against the environment that issued it. `provider_environment` is stamped
   * at link time and immutable (0048); this predicate is what compares it to
   * the environment the deployment is pointed at now.
   */

  it("allows a connection worked in the environment it was made in", () => {
    expect(environmentMatches("sandbox", "sandbox")).toBe(true);
    expect(environmentMatches("production", "production")).toBe(true);
  });

  it("refuses a sandbox connection on a production runtime", () => {
    expect(environmentMatches("sandbox", "production")).toBe(false);
  });

  it("refuses a production connection on a sandbox runtime", () => {
    // The direction that matters most: a PRODUCTION token must never be sent
    // to sandbox.plaid.com, whatever a misconfigured deployment asks for.
    expect(environmentMatches("production", "sandbox")).toBe(false);
  });

  it("refuses a connection with no recorded environment", () => {
    // Rows created before 0048 recorded one. "We do not know which world this
    // belongs to" is exactly the case that must not reach a provider.
    expect(environmentMatches(null, "production")).toBe(false);
    expect(environmentMatches(undefined, "production")).toBe(false);
    expect(environmentMatches(null, "sandbox")).toBe(false);
    expect(environmentMatches(undefined, "sandbox")).toBe(false);
  });

  it("refuses when the deployment names no environment", () => {
    expect(environmentMatches("production", null)).toBe(false);
    expect(environmentMatches("production", undefined)).toBe(false);
    expect(environmentMatches(null, null)).toBe(false);
    expect(environmentMatches(undefined, undefined)).toBe(false);
  });

  it("refuses the empty string, rather than matching it against itself", () => {
    // `"" === ""` is true, so a naive equality check would PASS two blank
    // environments. A blank is an absent value that happens to be a string.
    expect(environmentMatches("", "")).toBe(false);
    expect(environmentMatches("", "production")).toBe(false);
    expect(environmentMatches("production", "")).toBe(false);
  });

  it("compares exactly — no case folding, trimming or prefixing", () => {
    // Nothing here may widen what counts as a match.
    expect(environmentMatches("Production", "production")).toBe(false);
    expect(environmentMatches("production ", "production")).toBe(false);
    expect(environmentMatches("production", "production-eu")).toBe(false);
    expect(environmentMatches("prod", "production")).toBe(false);
  });

  it("does not privilege any particular environment name", () => {
    // It knows nothing about Plaid's vocabulary, so a second provider with
    // different environment names is covered by the same rule.
    expect(environmentMatches("fixture", "fixture")).toBe(true);
    expect(environmentMatches("development", "sandbox")).toBe(false);
  });
});
