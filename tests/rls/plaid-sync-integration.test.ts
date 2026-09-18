import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The adapter's module graph reaches src/lib/env.ts, which validates the
// public environment at import time. None of these is a real credential, and
// PLAID_* is deliberately absent: this suite reaches no Plaid environment.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
});

import { createTestDatabase, type TestDatabase } from "./harness";
import { MemorySecretStore } from "../fixtures/bank-provider-fixture";
import { PlaidGatewayDouble } from "../fixtures/plaid-gateway-double";
import { createPgliteBankStore } from "../fixtures/bank-store-pglite";
import type { BankStore } from "@/server/bank-connections/store";
import { PlaidBankProvider } from "@/server/bank-connections/providers/plaid/adapter";
import { createPlaidWebhookVerifier } from "@/server/bank-connections/providers/plaid/webhook-verification";
import { completeBankLink, completeBankReauth, disconnectBankConnection, linkExternalAccount, requestBankSync, type ServiceDependencies } from "@/server/bank-connections/service";
import { runBankSyncJob, type SystemAuditEvent } from "@/server/bank-connections/sync";
import { ingestBankWebhook } from "@/server/bank-connections/webhooks";

/**
 * PLAID, END TO END, AGAINST REAL POSTGRES.
 *
 * The production adapter, sync engine, reconciliation, services and webhook
 * boundary — with every migration applied and only the HTTP transport
 * replaced by a deterministic double that answers in Plaid's own shapes
 * (snake_case, JSON-number amounts, `/transactions/sync` cursors).
 *
 * This is where "Plaid connects to the existing architecture" is actually
 * demonstrated: a Plaid item becomes a connection, Plaid accounts become
 * linked accounts, Plaid transactions become ordinary `transactions` rows via
 * the same reconciliation rules, and nothing about the ledger changed.
 *
 * ENVIRONMENT: none. No Plaid credentials are used or needed here; the double
 * reports itself as "sandbox" so the environment plumbing is exercised.
 */

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

let db: TestDatabase;
let org: string;
let usd: string;
let double: PlaidGatewayDouble;
let provider: PlaidBankProvider;
let secrets: MemorySecretStore;
let store: BankStore;
let audits: SystemAuditEvent[];
let clock: Date;

const deps = (overrides: Partial<ServiceDependencies> = {}): ServiceDependencies => ({
  store,
  providers: [provider],
  secrets,
  now: () => clock,
  hash,
  audit: async (event) => void audits.push(event),
  ...overrides,
});

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  return db.asAdmin(async (query) => Object.values((await query(sql, params)).rows[0] as Record<string, T>)[0]);
}

const bankLedgerCount = () => scalar<number>(`select count(*)::int from transactions where organization_id = $1 and source = 'bank_sync'`, [org]);
const external = (providerTransactionId: string) =>
  db.asAdmin(async (query) => (await query(`select * from bank_external_transactions where provider_transaction_id = $1`, [providerTransactionId])).rows[0] as Record<string, unknown>);

async function connect(publicToken = "public-1") {
  const outcome = await completeBankLink(deps(), { organizationId: org, userId: OWNER, providerId: "plaid", publicToken });
  if (outcome.kind !== "connected") throw new Error(`link failed: ${outcome.kind}`);
  return { connectionId: outcome.connectionId, initialJobId: outcome.jobId! };
}

let keyCounter = 0;
async function sync(connectionId: string, overrides: Partial<ServiceDependencies> = {}) {
  const active = await store.getActiveJob(org, connectionId);
  if (active) return runBankSyncJob(deps(overrides), { organizationId: org, jobId: active.id });
  const job = await store.enqueueJob({ organizationId: org, connectionId, trigger: "SCHEDULED", idempotencyKey: `plaid-test-${keyCounter++}`, requestedBy: null, webhookEventId: null });
  return runBankSyncJob(deps(overrides), { organizationId: org, jobId: job.jobId! });
}

async function linkAccount(connectionId: string, providerAccountId = "plaid-acct-checking", accountId = usd) {
  const linkedAccountId = await scalar<string>(`select id from bank_linked_accounts where connection_id = $1 and provider_account_id = $2`, [connectionId, providerAccountId]);
  return linkExternalAccount(deps(), { organizationId: org, linkedAccountId, accountId, importMode: "IMPORT", actorId: OWNER });
}

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin((query) => query(`insert into auth.users (id, email) values ($1, 'owner@example.test')`, [OWNER]));
  await db.asUser(OWNER);
  org = ((await db.query(`insert into organizations (name, entity_type, created_by) values ('Synthetic', 'personal', $1) returning id`, [OWNER])).rows[0] as { id: string }).id;
  usd = await db.asAdmin(async (query) => ((await query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'Checking', 'bank', 'USD') returning id`, [org])).rows[0] as { id: string }).id);

  double = new PlaidGatewayDouble({ environment: "sandbox" });
  provider = new PlaidBankProvider({
    gateway: double,
    config: { environment: "sandbox", webhookUrl: "https://example.test/api/bank-connections/webhooks/plaid", redirectUri: null },
    verifier: createPlaidWebhookVerifier({ fetchKey: (keyId) => double.getWebhookVerificationKey(keyId) }),
  });
  secrets = new MemorySecretStore();
  store = createPgliteBankStore(db);
  audits = [];
  clock = new Date();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db?.close();
});

describe("connecting a Plaid item", () => {
  it("records the connection, its environment and an encrypted credential — and no token anywhere in the database", async () => {
    const { connectionId, initialJobId } = await connect();

    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("ACTIVE");
    expect(await scalar(`select provider from bank_connections where id = $1`, [connectionId])).toBe("plaid");
    expect(await scalar(`select provider_environment from bank_connections where id = $1`, [connectionId])).toBe("sandbox");
    expect(await scalar(`select institution_name from bank_connections where id = $1`, [connectionId])).toBe("First Platypus Bank");
    expect(await scalar(`select provider_connection_id from bank_connections where id = $1`, [connectionId])).toBe("item-public-1");
    expect(await scalar(`select trigger from bank_sync_jobs where id = $1`, [initialJobId])).toBe("INITIAL");

    const reference = await scalar<string>(`select secret_ref from bank_connection_credentials where connection_id = $1`, [connectionId]);
    expect(reference).toMatch(/^memory:/);
    expect(secrets.secrets.get(reference)).toMatch(/^access-sandbox-/);

    const everything = await scalar<string>(
      `select concat_ws('|', (select string_agg(c::text, '|') from bank_connections c), (select string_agg(c::text, '|') from bank_connection_credentials c), (select string_agg(j::text, '|') from bank_sync_jobs j), (select string_agg(a::text, '|') from audit_logs a))`,
    );
    expect(everything).not.toContain("access-sandbox");
  });

  it("refuses to attach an item that already belongs to another workspace", async () => {
    await connect("shared");
    await db.asUser(OWNER);
    const otherOrg = ((await db.query(`insert into organizations (name, entity_type, created_by) values ('Other', 'personal', $1) returning id`, [OWNER])).rows[0] as { id: string }).id;
    expect(await completeBankLink(deps(), { organizationId: otherOrg, userId: OWNER, providerId: "plaid", publicToken: "shared" })).toEqual({ kind: "belongs_elsewhere" });
    // And the token it was handed is revoked rather than kept.
    expect(double.calls.remove).toBe(1);
  });

  it("leaves no active connection when the credential cannot be stored", async () => {
    const failing = deps({ secrets: { id: "broken", put: async () => { throw new Error("store unavailable"); }, get: async () => null, destroy: async () => {} } });
    const outcome = await completeBankLink(failing, { organizationId: org, userId: OWNER, providerId: "plaid", publicToken: "public-x" });
    expect(outcome.kind).toBe("failed");
    expect(await scalar(`select status from bank_connections where provider_connection_id = 'item-public-x'`)).toBe("ERROR");
    expect(await scalar(`select count(*)::int from bank_connection_credentials`)).toBe(0);
  });
});

describe("importing Plaid transactions into the ledger", () => {
  it("imports nothing until the account is mapped, then each posted transaction exactly once", async () => {
    const { connectionId, initialJobId } = await connect();
    double.add(
      double.transaction({ transaction_id: "coffee", amount: 4.25 }),
      double.transaction({ transaction_id: "rent", amount: 1500, merchant_name: "Landlord" }),
      double.transaction({ transaction_id: "salary", amount: -4200, merchant_name: "Employer" }),
      double.transaction({ transaction_id: "hold", pending: true, authorized_date: null }),
    );

    const first = await runBankSyncJob(deps(), { organizationId: org, jobId: initialJobId });
    expect(first).toMatchObject({ kind: "succeeded", counts: { added: 4 } });
    expect(await bankLedgerCount()).toBe(0);
    expect(await scalar(`select count(*)::int from bank_external_transactions where reconciliation_state = 'AWAITING_ACCOUNT_LINK'`)).toBe(3);
    expect(await scalar(`select reconciliation_state from bank_external_transactions where provider_transaction_id = 'hold'`)).toBe("PENDING_SETTLEMENT");
    // Plaid's mask is reduced to four characters.
    expect(await scalar(`select mask from bank_linked_accounts where connection_id = $1`, [connectionId])).toBe("0000");

    expect(await linkAccount(connectionId)).toEqual({ kind: "applied", reconciled: 3 });
    expect(await bankLedgerCount()).toBe(3);

    // Plaid's sign convention, translated: positive leaves the account.
    const salary = await external("salary");
    expect(await db.asAdmin(async (query) => (await query(`select kind, amount_minor, currency, source, created_by from transactions where id = $1`, [salary.ledger_transaction_id])).rows[0])).toEqual({
      kind: "income",
      amount_minor: 420_000,
      currency: "USD",
      source: "bank_sync",
      created_by: null,
    });
    const coffee = await external("coffee");
    expect(await scalar(`select kind || ':' || amount_minor from transactions where id = $1`, [coffee.ledger_transaction_id])).toBe("expense:425");

    for (let i = 0; i < 3; i++) expect(await sync(connectionId)).toMatchObject({ kind: "succeeded", counts: { added: 0, imported: 0 } });
    expect(await bankLedgerCount()).toBe(3);
  });

  it("settles a pending transaction that posts under the same id into one ledger row", async () => {
    const { connectionId } = await connect();
    const pending = double.transaction({ transaction_id: "card-1", pending: true, amount: 18, authorized_date: null });
    double.add(pending);
    await sync(connectionId);
    await linkAccount(connectionId);
    expect(await bankLedgerCount()).toBe(0);

    double.modify({ ...pending, pending: false, amount: 18.4, authorized_date: "2026-09-10" });
    expect(await sync(connectionId)).toMatchObject({ counts: { modified: 1, imported: 1 } });
    expect(await bankLedgerCount()).toBe(1);
    expect(await scalar(`select amount_minor from transactions where source = 'bank_sync'`)).toBe(1840);
    expect(await sync(connectionId)).toMatchObject({ counts: { imported: 0 } });
    expect(await bankLedgerCount()).toBe(1);
  });

  it("settles a pending transaction that Plaid replaces with a new id, and removes the old one", async () => {
    const { connectionId } = await connect();
    double.add(double.transaction({ transaction_id: "auth-9", pending: true, authorized_date: null }));
    await sync(connectionId);
    await linkAccount(connectionId);

    double.add(double.transaction({ transaction_id: "settled-9", pending_transaction_id: "auth-9" }));
    double.remove("auth-9");
    await sync(connectionId);

    expect(await external("auth-9")).toMatchObject({ status: "SUPERSEDED", reconciliation_state: "NOT_POSTED", ledger_transaction_id: null });
    expect(await external("settled-9")).toMatchObject({ reconciliation_state: "IMPORTED" });
    expect(await bankLedgerCount()).toBe(1);
  });

  it("follows a correction from Plaid, unless a person has edited the row", async () => {
    const { connectionId } = await connect();
    const original = double.transaction({ transaction_id: "fixable", amount: 10 });
    double.add(original);
    await sync(connectionId);
    await linkAccount(connectionId);
    const ledgerId = String((await external("fixable")).ledger_transaction_id);

    double.modify({ ...original, amount: 12, merchant_name: "Corner Coffee Co" });
    expect(await sync(connectionId)).toMatchObject({ counts: { updated: 1 } });
    expect(await db.asAdmin(async (query) => (await query(`select amount_minor, description from transactions where id = $1`, [ledgerId])).rows[0])).toEqual({ amount_minor: 1200, description: "Corner Coffee Co" });

    await db.asUser(OWNER);
    await db.query(`update transactions set description = 'Client coffee' where id = $1`, [ledgerId]);
    double.modify({ ...original, amount: 13, merchant_name: "Corner Coffee Co" });
    expect(await sync(connectionId)).toMatchObject({ counts: { updated: 0, flagged: 1 } });
    expect(await db.asAdmin(async (query) => (await query(`select amount_minor, description from transactions where id = $1`, [ledgerId])).rows[0])).toEqual({ amount_minor: 1200, description: "Client coffee" });
    expect(await external("fixable")).toMatchObject({ reconciliation_state: "NEEDS_REVIEW", review_reason: "PROVIDER_CHANGED_AFTER_EDIT" });
  });

  it("flags a posted transaction Plaid removes, and never deletes it from the books", async () => {
    const { connectionId } = await connect();
    double.add(double.transaction({ transaction_id: "reversed" }));
    await sync(connectionId);
    await linkAccount(connectionId);
    double.remove("reversed");
    await sync(connectionId);

    const row = await external("reversed");
    expect(row).toMatchObject({ status: "REMOVED", reconciliation_state: "NEEDS_REVIEW", review_reason: "REMOVED_BY_PROVIDER" });
    expect(await scalar(`select count(*)::int from transactions where id = $1`, [row.ledger_transaction_id])).toBe(1);
  });

  it("matches a transaction the person already entered instead of importing it twice", async () => {
    const manual = await db.asAdmin(async (query) =>
      ((await query(`insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, description, source, created_by) values ($1, $2, 'expense', 425, 'USD', '2026-09-09', 'Coffee with Sam', 'manual', $3) returning id`, [org, usd, OWNER])).rows[0] as { id: string }).id,
    );
    const before = await scalar<string>(`select md5(t::text) from transactions t where id = $1`, [manual]);

    const { connectionId } = await connect();
    double.add(double.transaction({ transaction_id: "coffee", amount: 4.25 }));
    await sync(connectionId);
    await linkAccount(connectionId);

    expect(await external("coffee")).toMatchObject({ reconciliation_state: "MATCHED", ledger_transaction_id: manual });
    expect(await scalar<string>(`select md5(t::text) from transactions t where id = $1`, [manual])).toBe(before);
    expect(await bankLedgerCount()).toBe(0);
  });

  it("keeps a currency it cannot hold, and a currency that differs from the account, out of the ledger", async () => {
    const { connectionId } = await connect();
    double.add(
      double.transaction({ transaction_id: "euro", iso_currency_code: "EUR" }),
      double.transaction({ transaction_id: "crypto", iso_currency_code: null, unofficial_currency_code: "ETH" }),
      double.transaction({ transaction_id: "nocurrency", iso_currency_code: null, unofficial_currency_code: null }),
    );
    expect(await sync(connectionId)).toMatchObject({ counts: { added: 2, rejected: 1 } });
    await linkAccount(connectionId);
    expect(await scalar(`select reconciliation_state from bank_external_transactions where provider_transaction_id = 'euro'`)).toBe("CURRENCY_MISMATCH");
    expect(await scalar(`select reconciliation_state from bank_external_transactions where provider_transaction_id = 'crypto'`)).toBe("UNSUPPORTED_CURRENCY");
    expect(await bankLedgerCount()).toBe(0);
  });

  it("imports several linked accounts into the accounts a person chose", async () => {
    const savings = await db.asAdmin(async (query) => ((await query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'Savings', 'bank', 'USD') returning id`, [org])).rows[0] as { id: string }).id);
    double.accounts = [double.account(), double.account({ account_id: "plaid-acct-savings", name: "Plaid Saving", subtype: "savings", mask: "1111", balances: { available: 200, current: 210, iso_currency_code: "USD" } })];

    const { connectionId } = await connect();
    double.add(double.transaction({ transaction_id: "c1", amount: 5 }), double.transaction({ transaction_id: "s1", account_id: "plaid-acct-savings", amount: -100 }));
    await sync(connectionId);
    expect(await linkAccount(connectionId, "plaid-acct-checking", usd)).toMatchObject({ kind: "applied" });
    expect(await linkAccount(connectionId, "plaid-acct-savings", savings)).toMatchObject({ kind: "applied" });

    expect(await bankLedgerCount()).toBe(2);
    expect(await scalar(`select account_id from transactions where amount_minor = 10000`)).toBe(savings);
    expect(await scalar(`select kind from transactions where amount_minor = 10000`)).toBe("income");
  });
});

describe("broken connections", () => {
  it("asks the person to sign in again, stops syncing, and only records a repair Plaid confirms", async () => {
    const { connectionId } = await connect();
    double.add(double.transaction({ transaction_id: "before-break" }));
    await sync(connectionId);
    await linkAccount(connectionId);

    double.failNext({ errorCode: "ITEM_LOGIN_REQUIRED", errorType: "ITEM_ERROR", operation: "sync" });
    double.itemError = "ITEM_LOGIN_REQUIRED";
    expect(await sync(connectionId)).toMatchObject({ kind: "failed", category: "REAUTH_REQUIRED", jobStatus: "FAILED" });
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("REQUIRES_REAUTH");
    expect(await requestBankSync(deps(), { organizationId: org, connectionId, userId: OWNER, runInline: false })).toEqual({ kind: "not_syncable", status: "REQUIRES_REAUTH" });

    // The browser claiming success is not evidence: Plaid still reports the problem.
    expect(await completeBankReauth(deps(), { organizationId: org, connectionId, userId: OWNER })).toEqual({ kind: "still_requires_reauth" });
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("REQUIRES_REAUTH");

    double.itemError = null;
    const repaired = await completeBankReauth(deps(), { organizationId: org, connectionId, userId: OWNER });
    expect(repaired.kind).toBe("reconnected");
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("ACTIVE");

    double.add(double.transaction({ transaction_id: "after-repair" }));
    expect(await sync(connectionId)).toMatchObject({ kind: "succeeded" });
    expect(await bankLedgerCount()).toBe(2);
    expect(await scalar(`select count(*)::int from transactions where organization_id = $1`, [org])).toBe(2);
  });

  it("records a revoked item as an error the person can see, and keeps the history", async () => {
    const { connectionId } = await connect();
    double.add(double.transaction({ transaction_id: "kept" }));
    await sync(connectionId);
    await linkAccount(connectionId);

    double.failNext({ errorCode: "USER_PERMISSION_REVOKED", errorType: "ITEM_ERROR", operation: "sync" });
    expect(await sync(connectionId)).toMatchObject({ kind: "failed", category: "CONNECTION_REVOKED", jobStatus: "FAILED" });
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("ERROR");
    expect(await scalar(`select status_reason from bank_connections where id = $1`, [connectionId])).toBe("PROVIDER_REVOKED");
    expect(await bankLedgerCount()).toBe(1);
  });

  it("retries Plaid's transient failures with backoff, and stops at the attempt limit", async () => {
    const { connectionId } = await connect();
    clock = new Date(Date.now() - 5 * 60 * 60_000);
    const job = await store.enqueueJob({ organizationId: org, connectionId, trigger: "MANUAL", idempotencyKey: "flaky", requestedBy: OWNER, webhookEventId: null });
    double.failNext(
      { errorCode: "RATE_LIMIT", errorType: "RATE_LIMIT_EXCEEDED", status: 429, operation: "sync" },
      { errorCode: "INTERNAL_SERVER_ERROR", errorType: "API_ERROR", status: 500, operation: "sync" },
      { errorCode: "INSTITUTION_NOT_RESPONDING", errorType: "INSTITUTION_ERROR", status: 503, operation: "sync" },
      { errorCode: "PLANNED_MAINTENANCE", errorType: "API_ERROR", status: 503, operation: "sync" },
      { errorCode: "INTERNAL_SERVER_ERROR", errorType: "API_ERROR", status: 500, operation: "sync" },
    );

    const statuses: string[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const outcome = await runBankSyncJob(deps(), { organizationId: org, jobId: job.jobId! });
      statuses.push(outcome.kind === "failed" ? outcome.jobStatus : outcome.kind);
      clock = new Date(clock.getTime() + 31 * 60_000);
    }
    expect(statuses).toEqual(["RETRYABLE", "RETRYABLE", "RETRYABLE", "RETRYABLE", "FAILED", "not_runnable"]);
    expect(double.calls.sync).toBe(5);
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("ERROR");
  });

  it("restarts pagination when Plaid says its data moved underneath the cursor", async () => {
    const { connectionId } = await connect();
    for (let i = 0; i < 700; i++) double.add(double.transaction({ transaction_id: `r-${i}` }));
    expect(await sync(connectionId, { maxPages: 1 })).toMatchObject({ kind: "succeeded", hasMore: true });
    expect(await scalar(`select page_cursor from bank_connections where id = $1`, [connectionId])).toBe("cursor-500");
    expect(await scalar(`select committed_cursor from bank_connections where id = $1`, [connectionId])).toBeNull();

    await db.asAdmin((query) => query(`update bank_sync_jobs set status = 'CANCELLED', completed_at = now() where status = 'QUEUED'`));
    double.failNext({ errorCode: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", errorType: "INVALID_REQUEST", operation: "sync" });
    expect(await sync(connectionId)).toMatchObject({ kind: "failed", category: "CURSOR_RESET_REQUIRED" });
    expect(await scalar(`select page_cursor from bank_connections where id = $1`, [connectionId])).toBeNull();

    await db.asAdmin((query) => query(`update bank_sync_jobs set status = 'CANCELLED', failure_category = null, next_attempt_at = null, completed_at = now() where status = 'RETRYABLE'`));
    // Replaying from the committed cursor re-sends the first page. Ingestion is
    // idempotent, so those 500 change nothing and only the remaining 200 are new.
    expect(await sync(connectionId)).toMatchObject({ kind: "succeeded", counts: { added: 200, unchanged: 500 } });
    expect(await scalar(`select count(*)::int from bank_external_transactions`)).toBe(700);
  });
});

describe("Plaid webhooks", () => {
  const deliver = async (body: Record<string, unknown>, options: { header?: string; at?: Date } = {}) => {
    const rawBody = JSON.stringify(body);
    return ingestBankWebhook(deps(), {
      providerId: "plaid",
      rawBody,
      headers: { "plaid-verification": options.header ?? double.signWebhook(rawBody, options.at ?? clock), "content-type": "application/json" },
    });
  };

  it("enqueues exactly one sync for a signed delivery, however often it arrives", async () => {
    const { connectionId, initialJobId } = await connect();
    await runBankSyncJob(deps(), { organizationId: org, jobId: initialJobId });
    const body = { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-public-1", environment: "sandbox" };

    const responses = await Promise.all([deliver(body), deliver(body), deliver(body)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await scalar(`select count(*)::int from bank_webhook_events`)).toBe(1);
    expect(await scalar(`select outcome from bank_webhook_events`)).toBe("SYNC_ENQUEUED");
    expect(await scalar(`select count(*)::int from bank_sync_jobs where trigger = 'WEBHOOK' and connection_id = $1`, [connectionId])).toBe(1);
  });

  it("refuses a forged or tampered delivery without recording anything", async () => {
    await connect();
    const body = { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-public-1" };
    expect(await deliver(body, { header: "forged.token.value" })).toMatchObject({ status: 400 });
    expect(await deliver(body, { header: double.signWebhook(JSON.stringify({ different: true })) })).toMatchObject({ status: 400 });
    expect(await deliver(body, { at: new Date(clock.getTime() - 10 * 60_000) })).toMatchObject({ status: 400 });
    expect(await scalar(`select count(*)::int from bank_webhook_events`)).toBe(0);
    expect(await scalar(`select count(*)::int from bank_sync_jobs where trigger = 'WEBHOOK'`)).toBe(0);
  });

  it("moves a connection Plaid reports as broken, and ignores an item it does not know", async () => {
    const { connectionId } = await connect();
    expect(await deliver({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "item-public-1", error: { error_code: "ITEM_LOGIN_REQUIRED" } })).toMatchObject({ status: 200 });
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("REQUIRES_REAUTH");
    expect(audits.filter((audit) => audit.action === "bank_connection.status_changed").map((audit) => audit.metadata.to)).toEqual(["ACTIVE", "REQUIRES_REAUTH"]);

    expect(await deliver({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-someone-else" })).toMatchObject({ status: 200 });
    expect(await scalar(`select outcome from bank_webhook_events where provider_connection_id = 'item-someone-else'`)).toBe("UNKNOWN_CONNECTION");
  });

  it("acknowledges an event type it does not act on, and one for a disconnected connection", async () => {
    const { connectionId } = await connect();
    expect(await deliver({ webhook_type: "ASSETS", webhook_code: "PRODUCT_READY", item_id: "item-public-1", asset_report_id: "x" })).toMatchObject({ status: 200 });
    expect(await scalar(`select outcome from bank_webhook_events where event_type = 'UNSUPPORTED'`)).toBe("UNSUPPORTED_EVENT");

    await disconnectBankConnection(deps(), { organizationId: org, connectionId, actorId: OWNER });
    expect(await deliver({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-public-1" })).toMatchObject({ status: 200 });
    expect(await scalar(`select count(*)::int from bank_sync_jobs where trigger = 'WEBHOOK'`)).toBe(0);
  });
});

describe("disconnecting", () => {
  it("removes the item at Plaid, destroys the credential, and keeps every imported transaction", async () => {
    const { connectionId } = await connect();
    double.add(double.transaction({ transaction_id: "kept" }));
    await sync(connectionId);
    await linkAccount(connectionId);
    const reference = await scalar<string>(`select secret_ref from bank_connection_credentials where connection_id = $1`, [connectionId]);
    const ledgerBefore = await scalar<string>(`select md5(string_agg(t::text, '|' order by t.id)) from transactions t where organization_id = $1`, [org]);

    expect(await disconnectBankConnection(deps(), { organizationId: org, connectionId, actorId: OWNER })).toEqual({ kind: "disconnected", previousStatus: "ACTIVE", providerRevoked: true });
    expect(double.removedTokens).toHaveLength(1);
    expect(secrets.destroyed).toEqual([reference]);
    expect(await scalar(`select count(*)::int from bank_connection_credentials`)).toBe(0);
    expect(await scalar<string>(`select md5(string_agg(t::text, '|' order by t.id)) from transactions t where organization_id = $1`, [org])).toBe(ledgerBefore);
    expect(await scalar(`select count(*)::int from bank_external_transactions`)).toBe(1);
  });
});

describe("volume", () => {
  it("imports a thousand Plaid transactions in bounded pages, and a repeat sync adds nothing", { timeout: 300_000 }, async () => {
    const { connectionId, initialJobId } = await connect();
    for (let i = 0; i < 1000; i++) double.add(double.transaction({ transaction_id: `bulk-${i}`, amount: ((i % 97) + 1) / 4, date: `2026-0${(i % 8) + 1}-1${i % 9}`, authorized_date: null }));

    const started = Date.now();
    const run = await runBankSyncJob(deps(), { organizationId: org, jobId: initialJobId });
    expect(run).toMatchObject({ kind: "succeeded", counts: { pages: 2, added: 1000 } });
    expect(await linkAccount(connectionId)).toMatchObject({ kind: "applied", reconciled: 1000 });
    expect(await bankLedgerCount()).toBe(1000);
    // Never more than Plaid's page maximum in one request.
    expect(await scalar(`select max(pages_fetched)::int from bank_sync_runs`)).toBe(2);

    expect(await sync(connectionId)).toMatchObject({ kind: "succeeded", counts: { added: 0, imported: 0 } });
    expect(await bankLedgerCount()).toBe(1000);
    console.info(`[perf] 1,000 Plaid transactions end to end: ${Date.now() - started} ms`);
  });

  it("handles five thousand transactions and their settlement without duplicating a ledger row", { timeout: 600_000 }, async () => {
    const { connectionId, initialJobId } = await connect();
    for (let i = 0; i < 5000; i++) double.add(double.transaction({ transaction_id: `v-${i}`, amount: 1 + (i % 50), pending: i % 10 === 0, authorized_date: null }));

    const started = Date.now();
    let jobId: string | null = initialJobId;
    let runs = 0;
    while (jobId) {
      const outcome = await runBankSyncJob(deps({ maxPages: 20 }), { organizationId: org, jobId });
      expect(outcome.kind).toBe("succeeded");
      jobId = outcome.kind === "succeeded" ? outcome.continuationJobId : null;
      runs += 1;
      expect(runs).toBeLessThan(5);
    }
    expect(await scalar(`select count(*)::int from bank_external_transactions`)).toBe(5000);

    // Linking reconciles a bounded batch at once (1,000) so the request cannot
    // run away; the rest follow on the next sync, which reconciles in batches
    // of its own. Both bounds are deliberate, and this walks them to the end.
    expect(await linkAccount(connectionId)).toEqual({ kind: "applied", reconciled: 1000 });
    for (let pass = 0; pass < 6 && (await scalar<number>(`select count(*)::int from bank_external_transactions where needs_reconciliation`)) > 0; pass++) {
      await sync(connectionId);
    }
    expect(await scalar(`select count(*)::int from bank_external_transactions where needs_reconciliation`)).toBe(0);
    // 500 of them are pending, so they wait at the bank.
    expect(await bankLedgerCount()).toBe(4500);
    expect(await scalar(`select count(*)::int from bank_external_transactions where reconciliation_state = 'PENDING_SETTLEMENT'`)).toBe(500);

    // Every pending one settles under a new id, the way Plaid reports it.
    for (let i = 0; i < 5000; i += 10) {
      double.add(double.transaction({ transaction_id: `s-${i}`, pending_transaction_id: `v-${i}`, amount: 1 + (i % 50), authorized_date: null }));
      double.remove(`v-${i}`);
    }
    await sync(connectionId);
    expect(await scalar(`select count(*)::int from bank_external_transactions where status = 'SUPERSEDED'`)).toBe(500);
    expect(await bankLedgerCount()).toBe(5000);
    expect(await sync(connectionId)).toMatchObject({ counts: { imported: 0 } });
    expect(await bankLedgerCount()).toBe(5000);
    console.info(`[perf] 5,000 Plaid transactions with settlement: ${Date.now() - started} ms`);
  });
});

describe("what Plaid must never touch or reveal", () => {
  it("leaves confirmed tax facts and manually entered accounts exactly as they were", async () => {
    await db.asAdmin(async (query) => {
      const caseId = ((await query(`insert into tax_preparation_cases (organization_id, tax_year, status, filing_status, legal_first_name, legal_last_name, primary_state_region, created_by) values ($1, 2026, 'COLLECTING', 'single', 'Dana', 'Okafor', 'CA', $2) returning id`, [org, OWNER])).rows[0] as { id: string }).id;
      await query(`insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, currency, source, state, created_by) values ($1, $2, 1, 'W2_WAGES', 8500000, 'USD', 'USER_ENTERED', 'CONFIRMED', $3)`, [org, caseId, OWNER]);
    });
    const fingerprint = () =>
      scalar<string>(
        `select md5(concat_ws('|', (select string_agg(f::text, '|' order by f.id) from tax_preparation_facts f), (select string_agg(c::text, '|' order by c.id) from tax_preparation_cases c)))`,
      );
    const before = await fingerprint();

    const { connectionId } = await connect();
    double.add(double.transaction({ transaction_id: "wages", amount: -7083.33, merchant_name: "Employer Payroll" }));
    await sync(connectionId);
    await linkAccount(connectionId);
    await sync(connectionId);

    expect(await bankLedgerCount()).toBe(1);
    expect(await fingerprint()).toBe(before);
  });

  it("logs ids, statuses and counts — never a token, a cursor, an amount or a merchant", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")));
    }

    const { connectionId } = await connect();
    double.add(double.transaction({ transaction_id: "private", merchant_name: "Discreet Clinic", amount: 613.27 }));
    await sync(connectionId);
    await linkAccount(connectionId);
    double.failNext({ errorCode: "ITEM_LOGIN_REQUIRED", errorType: "ITEM_ERROR", operation: "sync" });
    await sync(connectionId);
    const rawBody = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-public-1" });
    await ingestBankWebhook(deps(), { providerId: "plaid", rawBody, headers: { "plaid-verification": "forged" } });
    await disconnectBankConnection(deps(), { organizationId: org, connectionId, actorId: OWNER });

    const output = lines.join("\n");
    expect(lines.length).toBeGreaterThan(3);
    for (const forbidden of ["access-sandbox", "cursor-", "Discreet Clinic", "613.27", "61327", "item-public-1", "memory:", "Developer-facing sentence", "plaid-verification"]) {
      expect(output, forbidden).not.toContain(forbidden);
    }
    expect(output).toContain(connectionId);
    expect(output).toContain("plaid");
  });
});
