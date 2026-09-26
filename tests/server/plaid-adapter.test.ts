import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// src/lib/env.ts validates the public environment at import time, and the
// adapter's module graph reaches it. None of these is a real credential, and
// no PLAID_* value is set: this suite never touches a Plaid environment.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
});
import {
  ProviderSecret,
  providerCompletedLinkSchema,
  providerConnectionStateSchema,
  providerLinkSessionSchema,
  providerTransactionsPageSchema,
  providerWebhookEventSchema,
  runBankProviderCall,
  type ProviderCallOutcome,
} from "@/domain/bank-connections/provider";
import { PlaidBankProvider } from "@/server/bank-connections/providers/plaid/adapter";
import type { PlaidGateway } from "@/server/bank-connections/providers/plaid/gateway";
import { createPlaidWebhookVerifier } from "@/server/bank-connections/providers/plaid/webhook-verification";
import { PlaidGatewayDouble } from "../fixtures/plaid-gateway-double";

/**
 * The Plaid adapter, exercised exactly as the sync engine exercises it:
 * through `runBankProviderCall`, so every result is validated against the
 * provider contract and every failure becomes a category.
 *
 * The transport is a deterministic double that answers with Plaid-shaped
 * payloads. What is under test is real: the adapter, its mapping, the contract
 * schemas, the error classification and the webhook verification.
 */

let double: PlaidGatewayDouble;
let provider: PlaidBankProvider;

const unwrap = <T>(outcome: ProviderCallOutcome<T>): T => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.category}`);
  return outcome.value;
};

const linkSession = (input: { reauthSecret?: ProviderSecret } = {}) =>
  runBankProviderCall((signal) => provider.createLinkSession({ organizationId: "org-1", userId: "user-1", signal, ...input }), providerLinkSessionSchema);

const completeLink = (publicToken = "public-1") => runBankProviderCall((signal) => provider.completeLink({ publicToken, signal }), providerCompletedLinkSchema);

const page = (secret: ProviderSecret, cursor: string | null, pageSize = 500) =>
  runBankProviderCall((signal) => provider.fetchTransactions({ secret, cursor, pageSize, signal }), providerTransactionsPageSchema);

async function connectedSecret(): Promise<ProviderSecret> {
  const link = unwrap(await completeLink());
  return link.secret;
}

/** The double, with one endpoint replaced — for testing what the adapter does
 *  with a response no real Plaid would send. */
function gatewayWith(overrides: Partial<PlaidGateway>): PlaidGateway {
  return {
    environment: double.environment,
    createLinkToken: (request) => double.createLinkToken(request),
    exchangePublicToken: (token) => double.exchangePublicToken(token),
    getItem: (token) => double.getItem(token),
    getInstitution: (institutionId) => double.getInstitution(institutionId),
    getAccounts: (token) => double.getAccounts(token),
    syncTransactions: (input) => double.syncTransactions(input),
    removeItem: (token) => double.removeItem(token),
    getWebhookVerificationKey: (keyId) => double.getWebhookVerificationKey(keyId),
    ...overrides,
  };
}

beforeEach(() => {
  double = new PlaidGatewayDouble();
  provider = new PlaidBankProvider({
    gateway: double,
    config: { environment: "sandbox", webhookUrl: "https://example.test/api/bank-connections/webhooks/plaid", redirectUri: null },
    verifier: createPlaidWebhookVerifier({ fetchKey: (keyId) => double.getWebhookVerificationKey(keyId) }),
  });
});

describe("identity", () => {
  it("names the provider and the environment it is pointed at", () => {
    expect(provider.id).toBe("plaid");
    expect(provider.environment).toBe("sandbox");
    expect(provider.version).toBe("2020-09-14+sandbox");
    expect(provider.capabilities).toEqual({ webhooks: true, pendingTransactions: true, balances: true });
  });

  it("is the only part of the codebase that imports the Plaid SDK", () => {
    const root = path.resolve(process.cwd(), "src");
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry) && /from "plaid"|require\("plaid"\)/.test(readFileSync(full, "utf8"))) importers.push(path.relative(root, full).replace(/\\/g, "/"));
      }
    };
    walk(root);
    expect(importers).toEqual(["server/bank-connections/providers/plaid/gateway.ts"]);
  });
});

describe("the Link token", () => {
  it("is created server-side and carries no credential", async () => {
    const session = unwrap(await linkSession());
    expect(session.linkToken).toMatch(/^link-sandbox-/);
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(double.linkTokenRequests[0]).toMatchObject({ clientUserId: "user-1", accessToken: null, webhookUrl: "https://example.test/api/bank-connections/webhooks/plaid" });
    expect(JSON.stringify(session)).not.toContain("access-");
  });

  it("passes the stored credential to Plaid for a repair, and never back to the caller", async () => {
    const session = unwrap(await linkSession({ reauthSecret: new ProviderSecret("access-sandbox-existing-token") }));
    expect(double.linkTokenRequests[0].accessToken).toBe("access-sandbox-existing-token");
    expect(JSON.stringify(session)).not.toContain("access-sandbox-existing-token");
  });

  it("refuses a response Plaid would never send", async () => {
    for (const response of [{ link_token: "", expiration: "2026-09-16T12:00:00Z" }, { link_token: "link-sandbox-1", expiration: "not-a-date" }, { nothing: true }]) {
      const broken = new PlaidBankProvider({
        gateway: gatewayWith({ createLinkToken: async () => response }),
        config: { environment: "sandbox", webhookUrl: null, redirectUri: null },
        verifier: createPlaidWebhookVerifier({ fetchKey: (keyId) => double.getWebhookVerificationKey(keyId) }),
      });
      const outcome = await runBankProviderCall((signal) => broken.createLinkSession({ organizationId: "org-1", userId: "user-1", signal }), providerLinkSessionSchema);
      expect(outcome, JSON.stringify(response)).toMatchObject({ ok: false, category: "MALFORMED_PROVIDER_RESPONSE" });
    }
  });
});

describe("completing a link", () => {
  it("exchanges the public token and takes the institution from Plaid, not the browser", async () => {
    const link = unwrap(await completeLink("public-abc"));
    expect(link).toMatchObject({ providerConnectionId: "item-public-abc", institutionId: "ins_109508", institutionName: "First Platypus Bank", providerEnvironment: "sandbox" });
    expect(link.secret).toBeInstanceOf(ProviderSecret);
    expect(link.secret.reveal()).toMatch(/^access-sandbox-/);
    // The credential cannot leak through a log line or a serialised result.
    expect(JSON.stringify(link)).toContain("[provider secret]");
    expect(JSON.stringify(link)).not.toContain(link.secret.reveal());
    expect(double.calls).toMatchObject({ exchange: 1, item: 1, institution: 1 });
  });

  it("still connects when the institution's name cannot be read", async () => {
    double.failNext({ errorCode: "INSTITUTION_NOT_RESPONDING", errorType: "INSTITUTION_ERROR", status: 503, operation: "institution" });
    const link = unwrap(await completeLink());
    expect(link.institutionName).toBeNull();
    expect(link.providerConnectionId).toBe("item-public-1");
  });

  it("reports a refused exchange as a category, never as Plaid's message", async () => {
    double.failNext({ errorCode: "INVALID_PUBLIC_TOKEN", errorType: "INVALID_INPUT", operation: "exchange" });
    const outcome = await completeLink();
    expect(outcome).toMatchObject({ ok: false, category: "INTERNAL_ERROR" });
    expect(JSON.stringify(outcome)).not.toContain("Developer-facing sentence");
  });

  it("carries Plaid's error code and request id, so INTERNAL_ERROR can be diagnosed", async () => {
    /**
     * A category is a DECISION, not a cause. Several unrelated mistakes all
     * classify as INTERNAL_ERROR — this exact ambiguity cost a production
     * debugging session where "Something went wrong on our side." was all the
     * log said, and the real answer (a field Plaid rejected) was only visible
     * in Plaid's own dashboard.
     *
     * The code is enum-like and the request id identifies the CALL, not the
     * customer, so both are safe to keep. Plaid's message text is not, and
     * still must not appear.
     */
    double.failNext({ errorCode: "INVALID_FIELD", errorType: "INVALID_REQUEST", operation: "exchange" });
    const outcome = await completeLink();

    expect(outcome).toMatchObject({ ok: false, category: "INTERNAL_ERROR" });
    if (outcome.ok) throw new Error("expected a failure");
    expect(outcome.diagnostics).toEqual({ code: "INVALID_FIELD", requestId: "req_double" });
    // The sentence written for a developer can name an institution or an item.
    expect(JSON.stringify(outcome)).not.toContain("Developer-facing sentence");
  });

  it("leaves the diagnostics empty rather than inventing them", async () => {
    // A network fault has no body and no request id. The fields are absent,
    // not filled with a guess.
    double.failNext({ errorCode: null as unknown as string, errorType: undefined, operation: "exchange" });
    const outcome = await completeLink();
    if (outcome.ok) throw new Error("expected a failure");
    expect(outcome.diagnostics?.code ?? null).toBeNull();
  });
});

describe("transaction sync", () => {
  it("returns accounts with the first page only, and follows the cursor", async () => {
    const secret = await connectedSecret();
    double.add(double.transaction({ transaction_id: "t1" }), double.transaction({ transaction_id: "t2" }), double.transaction({ transaction_id: "t3" }));

    const first = unwrap(await page(secret, null, 2));
    expect(first.accounts).toHaveLength(1);
    expect(first.accounts[0]).toMatchObject({ providerAccountId: "plaid-acct-checking", type: "DEPOSITORY", currency: "USD", currentBalance: "110" });
    expect(first.added.map((transaction) => transaction.providerTransactionId)).toEqual(["t1", "t2"]);
    expect(first).toMatchObject({ hasMore: true, nextCursor: "cursor-2" });

    const second = unwrap(await page(secret, first.nextCursor, 2));
    expect(second.accounts).toEqual([]);
    expect(second.added.map((transaction) => transaction.providerTransactionId)).toEqual(["t3"]);
    expect(second.hasMore).toBe(false);
  });

  it("reports a transaction Plaid has already sent as modified, and a deletion as removed", async () => {
    const secret = await connectedSecret();
    const original = double.transaction({ transaction_id: "t1", amount: 10 });
    double.add(original);
    unwrap(await page(secret, null));

    double.modify({ ...original, amount: 12.5 });
    double.remove("t-gone");
    const next = unwrap(await page(secret, "cursor-1"));
    expect(next.added).toEqual([]);
    expect(next.modified[0]).toMatchObject({ providerTransactionId: "t1", amount: "12.5" });
    expect(next.removed).toEqual([{ providerTransactionId: "t-gone" }]);
  });

  it("never asks Plaid for more than its maximum page", async () => {
    const secret = await connectedSecret();
    await page(secret, null, 5000);
    expect(double.calls.sync).toBe(1);
  });

  it("maps every failure to the category that decides whether a retry can help", async () => {
    const secret = await connectedSecret();
    const cases: [string, string, string][] = [
      ["ITEM_LOGIN_REQUIRED", "ITEM_ERROR", "REAUTH_REQUIRED"],
      ["ITEM_NOT_FOUND", "ITEM_ERROR", "CONNECTION_REVOKED"],
      ["RATE_LIMIT", "RATE_LIMIT_EXCEEDED", "PROVIDER_RATE_LIMITED"],
      ["INTERNAL_SERVER_ERROR", "API_ERROR", "PROVIDER_UNAVAILABLE"],
      ["TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "INVALID_REQUEST", "CURSOR_RESET_REQUIRED"],
      ["INVALID_API_KEYS", "INVALID_INPUT", "PROVIDER_NOT_CONFIGURED"],
    ];
    for (const [errorCode, errorType, category] of cases) {
      double.failNext({ errorCode, errorType, status: errorType === "RATE_LIMIT_EXCEEDED" ? 429 : errorType === "API_ERROR" ? 500 : 400, operation: "sync" });
      expect(await page(secret, null), errorCode).toMatchObject({ ok: false, category });
    }
  });

  it("refuses a malformed page rather than importing part of it", async () => {
    const secret = await connectedSecret();
    double.malformedNext = true;
    expect(await page(secret, null)).toMatchObject({ ok: false, category: "MALFORMED_PROVIDER_RESPONSE" });
  });
});

describe("the provider's own view of a connection", () => {
  const inspect = (secret: ProviderSecret) => runBankProviderCall((signal) => provider.inspectConnection({ secret, signal }), providerConnectionStateSchema);

  it("reports health, and the code behind it", async () => {
    const secret = await connectedSecret();
    expect(unwrap(await inspect(secret))).toEqual({ health: "HEALTHY", errorCode: null, institutionId: "ins_109508" });

    double.itemError = "ITEM_LOGIN_REQUIRED";
    expect(unwrap(await inspect(secret))).toMatchObject({ health: "REQUIRES_REAUTH", errorCode: "ITEM_LOGIN_REQUIRED" });
    double.itemError = "USER_PERMISSION_REVOKED";
    expect(unwrap(await inspect(secret))).toMatchObject({ health: "REVOKED" });
    double.itemError = "INSTITUTION_DOWN";
    expect(unwrap(await inspect(secret))).toMatchObject({ health: "ERROR" });
  });
});

describe("revoking", () => {
  it("removes the item at Plaid", async () => {
    const secret = await connectedSecret();
    await provider.revoke({ secret, signal: new AbortController().signal });
    expect(double.removedTokens).toEqual([secret.reveal()]);
    expect(double.calls.remove).toBe(1);
  });

  it("reports a refusal it cannot interpret as revoked, so a disconnect is not silently claimed", async () => {
    const secret = await connectedSecret();
    double.failNext({ errorCode: "INTERNAL_SERVER_ERROR", errorType: "API_ERROR", status: 500, operation: "remove" });
    await expect(provider.revoke({ secret, signal: new AbortController().signal })).rejects.toMatchObject({ category: "PROVIDER_UNAVAILABLE" });
  });

  it("treats an item Plaid has already forgotten as revoked", async () => {
    const outcome = await provider.revoke({ secret: new ProviderSecret("access-sandbox-unknown"), signal: new AbortController().signal });
    expect(outcome).toEqual({ removed: true });
  });
});

describe("webhooks", () => {
  const verify = (rawBody: string, header: string) =>
    runBankProviderCall(() => provider.verifyWebhook({ rawBody, headers: { "plaid-verification": header }, receivedAt: new Date() }), providerWebhookEventSchema);

  it("accepts a delivery Plaid signed, and classifies it", async () => {
    const rawBody = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-public-1", environment: "sandbox" });
    const event = unwrap(await verify(rawBody, double.signWebhook(rawBody)));
    expect(event).toMatchObject({ type: "TRANSACTIONS_UPDATED", providerEventType: "TRANSACTIONS:SYNC_UPDATES_AVAILABLE", providerConnectionId: "item-public-1" });
    // Identity is the body Plaid signed, so a redelivery is the same event.
    expect(event.providerEventId).toMatch(/^[0-9a-f]{64}$/);
    expect(unwrap(await verify(rawBody, double.signWebhook(rawBody))).providerEventId).toBe(event.providerEventId);
    expect(event.occurredAt).toBeTruthy();
  });

  it("refuses a forged delivery", async () => {
    const rawBody = JSON.stringify({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "item-public-1" });
    expect(await verify(rawBody, "forged.header.value")).toMatchObject({ ok: false, category: "MALFORMED_PROVIDER_RESPONSE" });
    // A signature over a different body is no better.
    expect(await verify(rawBody, double.signWebhook("{}"))).toMatchObject({ ok: false, category: "MALFORMED_PROVIDER_RESPONSE" });
  });

  it("acknowledges an event type Countorra does not act on", async () => {
    const rawBody = JSON.stringify({ webhook_type: "ASSETS", webhook_code: "PRODUCT_READY", asset_report_id: "x" });
    expect(unwrap(await verify(rawBody, double.signWebhook(rawBody))).type).toBe("UNSUPPORTED");
  });
});
