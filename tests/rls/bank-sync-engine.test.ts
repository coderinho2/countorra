import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";
import { FixtureBankProvider, MemorySecretStore } from "../fixtures/bank-provider-fixture";
import { createPgliteBankStore } from "../fixtures/bank-store-pglite";
import type { BankStore } from "@/server/bank-connections/store";
import { completeBankLink, disconnectBankConnection, linkExternalAccount, releaseOrganizationBankCredentials, requestBankSync, resolveBankReview, type ServiceDependencies } from "@/server/bank-connections/service";
import { runBankSyncJob, type SystemAuditEvent } from "@/server/bank-connections/sync";
import { ingestBankWebhook } from "@/server/bank-connections/webhooks";

/**
 * The sync engine, reconciliation, services and webhook ingestion — the real
 * production modules — against real Postgres with every migration, through the
 * same SQL functions production calls, with a deterministic TEST-ONLY provider.
 *
 * Covers: link completion, initial and incremental sync, cursor pagination with
 * continuation jobs, repeated-sync idempotency, pending → posted (same id and
 * new id), cancellation, manual-entry matching, edits that must not be
 * overwritten, removals, currencies, failures and retries, concurrency,
 * disconnect, deletion, webhook verification/replay/order, log redaction, and
 * the untouched tax facts. Volumes: hundreds and thousands of transactions.
 */

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

let db: TestDatabase;
let org: string;
let usd: string;
let eur: string;
let provider: FixtureBankProvider;
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

async function connect(publicToken = "public-1") {
  const outcome = await completeBankLink(deps(), { organizationId: org, userId: OWNER, providerId: "fixture", publicToken });
  if (outcome.kind !== "connected") throw new Error(`link failed: ${outcome.kind}`);
  return { connectionId: outcome.connectionId, initialJobId: outcome.jobId! };
}

let keyCounter = 0;
/** Runs the connection's active job if it has one (a connection starts with its
 *  INITIAL job queued — and the database allows only one active job), or a new
 *  one otherwise. */
async function sync(connectionId: string, overrides: Partial<ServiceDependencies> = {}) {
  const active = await store.getActiveJob(org, connectionId);
  if (active) return runBankSyncJob(deps(overrides), { organizationId: org, jobId: active.id });
  const job = await store.enqueueJob({ organizationId: org, connectionId, trigger: "SCHEDULED", idempotencyKey: `test-${keyCounter++}`, requestedBy: null, webhookEventId: null });
  expect(job.outcome).toBe("CREATED");
  return runBankSyncJob(deps(overrides), { organizationId: org, jobId: job.jobId! });
}

async function linkChecking(connectionId: string, accountId = usd, providerAccountId = "acct-checking") {
  const linkedAccountId = await scalar<string>(`select id from bank_linked_accounts where connection_id = $1 and provider_account_id = $2`, [connectionId, providerAccountId]);
  return linkExternalAccount(deps(), { organizationId: org, linkedAccountId, accountId, importMode: "IMPORT", actorId: OWNER });
}

const bankLedgerCount = () => scalar<number>(`select count(*)::int from transactions where organization_id = $1 and source = 'bank_sync'`, [org]);
const ledgerCount = () => scalar<number>(`select count(*)::int from transactions where organization_id = $1`, [org]);
const external = (providerTransactionId: string) =>
  db.asAdmin(async (query) => (await query(`select * from bank_external_transactions where provider_transaction_id = $1`, [providerTransactionId])).rows[0] as Record<string, unknown>);

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin((query) => query(`insert into auth.users (id, email) values ($1, 'owner@example.test')`, [OWNER]));
  await db.asUser(OWNER);
  org = ((await db.query(`insert into organizations (name, entity_type, created_by) values ('Synthetic', 'personal', $1) returning id`, [OWNER])).rows[0] as { id: string }).id;
  await db.asAdmin(async (query) => {
    usd = ((await query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'Checking', 'bank', 'USD') returning id`, [org])).rows[0] as { id: string }).id;
    eur = ((await query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'Euro', 'bank', 'EUR') returning id`, [org])).rows[0] as { id: string }).id;
  });
  provider = new FixtureBankProvider();
  provider.account();
  secrets = new MemorySecretStore();
  store = createPgliteBankStore(db);
  audits = [];
  clock = new Date();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db?.close();
});

describe("connecting a bank", () => {
  it("creates an ACTIVE connection whose credential exists only in the secret store", async () => {
    const { connectionId, initialJobId } = await connect();
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("ACTIVE");
    expect(await scalar(`select trigger from bank_sync_jobs where id = $1`, [initialJobId])).toBe("INITIAL");
    const ref = await scalar<string>(`select secret_ref from bank_connection_credentials where connection_id = $1`, [connectionId]);
    expect(ref).toMatch(/^memory:/);
    expect(secrets.secrets.get(ref)).toBe("fixture-access-token-public-1");

    // Nowhere in any bank table.
    const everything = await scalar<string>(
      `select concat_ws('|', (select string_agg(b::text, '|') from bank_connections b), (select string_agg(c::text, '|') from bank_connection_credentials c), (select string_agg(j::text, '|') from bank_sync_jobs j), (select string_agg(a::text, '|') from audit_logs a))`,
    );
    expect(everything).not.toContain("fixture-access-token");
    expect(audits.map((event) => event.action)).toEqual(["bank_connection.status_changed"]);
  });

  it("tells a workspace re-linking its OWN disconnected connection what actually happened", async () => {
    // `bank_connections_provider_identity_unique` is global, so the row a
    // disconnect leaves behind still reserves the provider's handle and the
    // link must be refused. What it must NOT say is that the connection
    // belongs to another workspace: it is this one's own history, and that
    // message sends somebody looking for a problem that does not exist.
    const { connectionId } = await connect("shared");
    const disconnected = await disconnectBankConnection(deps(), { organizationId: org, connectionId, actorId: OWNER });
    expect(disconnected.kind).toBe("disconnected");

    const outcome = await completeBankLink(deps(), { organizationId: org, userId: OWNER, providerId: "fixture", publicToken: "shared" });
    expect(outcome).toEqual({ kind: "previously_disconnected", connectionId });
    // And nothing was created: one row, still disconnected.
    expect(await scalar(`select count(*)::int from bank_connections`)).toBe(1);
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("DISCONNECTED");
  });

  it("refuses to register the same provider connection into a second workspace", async () => {
    await connect("shared");
    await db.asUser(OWNER);
    const otherOrg = ((await db.query(`insert into organizations (name, entity_type, created_by) values ('Other', 'personal', $1) returning id`, [OWNER])).rows[0] as { id: string }).id;
    const outcome = await completeBankLink(deps(), { organizationId: otherOrg, userId: OWNER, providerId: "fixture", publicToken: "shared" });
    expect(outcome).toEqual({ kind: "belongs_elsewhere" });
    expect(provider.calls.revoke).toBe(1);
  });
});

describe("sync into the ledger", () => {
  it("imports nothing until a person links the bank account, then imports each posted transaction once", async () => {
    const { connectionId, initialJobId } = await connect();
    provider.add(provider.transaction({ providerTransactionId: "coffee" }), provider.transaction({ providerTransactionId: "rent", amount: "1500.00", merchantName: "Landlord" }));
    provider.add(provider.transaction({ providerTransactionId: "salary", direction: "CREDIT", amount: "4200.00", merchantName: "Employer" }));
    provider.add(provider.transaction({ providerTransactionId: "hold", status: "PENDING", postedDate: null }));

    const before = await ledgerCount();
    const first = await runBankSyncJob(deps(), { organizationId: org, jobId: initialJobId });
    expect(first).toMatchObject({ kind: "succeeded", counts: { pages: 1, added: 4 } });
    expect(await ledgerCount()).toBe(before);
    expect(await scalar(`select count(*)::int from bank_external_transactions where reconciliation_state = 'AWAITING_ACCOUNT_LINK'`)).toBe(3);
    expect(await scalar(`select reconciliation_state from bank_external_transactions where provider_transaction_id = 'hold'`)).toBe("PENDING_SETTLEMENT");
    // What the bank reported as a mask is reduced to four characters.
    expect(await scalar(`select mask from bank_linked_accounts where connection_id = $1`, [connectionId])).toBe("3333");

    // The three posted transactions; the pending one is still waiting at the bank.
    expect(await linkChecking(connectionId)).toEqual({ kind: "applied", reconciled: 3 });
    expect(await bankLedgerCount()).toBe(3);
    const salary = await external("salary");
    expect(await db.asAdmin(async (query) => (await query(`select kind, amount_minor, currency, source, created_by, account_id from transactions where id = $1`, [salary.ledger_transaction_id])).rows[0])).toEqual({
      kind: "income",
      amount_minor: 420_000,
      currency: "USD",
      source: "bank_sync",
      created_by: null,
      account_id: usd,
    });

    // Repeated syncs change nothing.
    for (let i = 0; i < 3; i++) expect(await sync(connectionId)).toMatchObject({ kind: "succeeded", counts: { added: 0, imported: 0 } });
    expect(await bankLedgerCount()).toBe(3);
    expect(await scalar(`select count(*)::int from bank_external_transactions`)).toBe(4);
  });

  it("settles a pending transaction that posts under the same id into exactly one ledger transaction", async () => {
    const { connectionId } = await connect();
    const pending = provider.transaction({ providerTransactionId: "card-1", status: "PENDING", postedDate: null, amount: "18.00" });
    provider.add(pending);
    await sync(connectionId);
    await linkChecking(connectionId);
    expect(await bankLedgerCount()).toBe(0);

    provider.modify({ ...pending, status: "POSTED", postedDate: "2026-09-12", amount: "18.40" });
    expect(await sync(connectionId)).toMatchObject({ counts: { modified: 1, imported: 1 } });
    expect(await sync(connectionId)).toMatchObject({ counts: { imported: 0 } });
    expect(await bankLedgerCount()).toBe(1);
    expect(await scalar(`select amount_minor from transactions where source = 'bank_sync'`)).toBe(1840);
  });

  it("supersedes a pending transaction replaced by a posted one with a new id, and imports once", async () => {
    const { connectionId } = await connect();
    provider.add(provider.transaction({ providerTransactionId: "auth-9", status: "PENDING", postedDate: null }));
    await sync(connectionId);
    await linkChecking(connectionId);

    provider.add(provider.transaction({ providerTransactionId: "settled-9", pendingProviderTransactionId: "auth-9" }));
    provider.remove("auth-9");
    await sync(connectionId);
    expect((await external("auth-9")).status).toBe("SUPERSEDED");
    expect((await external("auth-9")).reconciliation_state).toBe("NOT_POSTED");
    expect((await external("settled-9")).reconciliation_state).toBe("IMPORTED");
    expect(await bankLedgerCount()).toBe(1);
  });

  it("never touches the ledger for a pending transaction that disappears", async () => {
    const { connectionId } = await connect();
    await sync(connectionId);
    await linkChecking(connectionId);
    provider.add(provider.transaction({ providerTransactionId: "declined", status: "PENDING", postedDate: null }));
    await sync(connectionId);
    provider.remove("declined");
    await sync(connectionId);
    expect(await external("declined")).toMatchObject({ status: "REMOVED", reconciliation_state: "NOT_POSTED", ledger_transaction_id: null });
    expect(await bankLedgerCount()).toBe(0);
  });

  it("matches a transaction a person already entered instead of importing a duplicate, and leaves it unchanged", async () => {
    const manual = await db.asAdmin(async (query) =>
      ((await query(`insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, description, source, created_by) values ($1, $2, 'expense', 4250, 'USD', '2026-09-09', 'Coffee with Sam', 'manual', $3) returning id`, [org, usd, OWNER])).rows[0] as { id: string }).id,
    );
    const manualBefore = await scalar<string>(`select md5(t::text) from transactions t where id = $1`, [manual]);
    const { connectionId } = await connect();
    provider.add(provider.transaction({ providerTransactionId: "coffee" }));
    await sync(connectionId);
    await linkChecking(connectionId);

    expect(await external("coffee")).toMatchObject({ reconciliation_state: "MATCHED", ledger_transaction_id: manual, ledger_link_kind: "MATCHED" });
    expect(await scalar<string>(`select md5(t::text) from transactions t where id = $1`, [manual])).toBe(manualBefore);
    expect(await bankLedgerCount()).toBe(0);

    // A second, identical coffee is a new transaction, not the same one twice.
    provider.add(provider.transaction({ providerTransactionId: "coffee-2" }));
    await sync(connectionId);
    expect((await external("coffee-2")).reconciliation_state).toBe("IMPORTED");
    expect(await bankLedgerCount()).toBe(1);
  });

  it("waits for a person when two hand-entered transactions could match, then imports on their decision", async () => {
    await db.asAdmin(async (query) => {
      for (const date of ["2026-09-09", "2026-09-11"]) {
        await query(`insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, source) values ($1, $2, 'expense', 4250, 'USD', $3, 'manual')`, [org, usd, date]);
      }
    });
    const { connectionId } = await connect();
    provider.add(provider.transaction({ providerTransactionId: "which-one" }));
    await sync(connectionId);
    await linkChecking(connectionId);
    expect(await external("which-one")).toMatchObject({ reconciliation_state: "NEEDS_REVIEW", review_reason: "AMBIGUOUS_MANUAL_MATCH" });
    expect(await sync(connectionId)).toMatchObject({ counts: { imported: 0 } });

    const id = String((await external("which-one")).id);
    expect(await resolveBankReview(deps(), { organizationId: org, externalId: id, resolution: { kind: "IMPORT_AS_NEW" }, actorId: OWNER })).toEqual({ kind: "applied" });
    expect(await external("which-one")).toMatchObject({ reconciliation_state: "IMPORTED", review_resolved_revision: 1 });
    expect(await scalar(`select actor_id from bank_transaction_revisions where external_transaction_id = $1 and change_kind = 'LEDGER_IMPORTED'`, [id])).toBe(OWNER);
    expect(await bankLedgerCount()).toBe(1);
  });

  it("follows the bank's corrections only while the imported row is untouched, and keeps a person's edit", async () => {
    const { connectionId } = await connect();
    const original = provider.transaction({ providerTransactionId: "fixable", amount: "10.00" });
    provider.add(original);
    await sync(connectionId);
    await linkChecking(connectionId);
    const ledgerId = String((await external("fixable")).ledger_transaction_id);

    provider.modify({ ...original, amount: "12.00", merchantName: "Corner Coffee Co" });
    expect(await sync(connectionId)).toMatchObject({ counts: { updated: 1 } });
    expect(await db.asAdmin(async (query) => (await query(`select amount_minor, description from transactions where id = $1`, [ledgerId])).rows[0])).toEqual({ amount_minor: 1200, description: "Corner Coffee Co" });

    await db.asUser(OWNER);
    await db.query(`update transactions set description = 'Client coffee (billable)' where id = $1`, [ledgerId]);
    provider.modify({ ...original, amount: "13.00", merchantName: "Corner Coffee Co" });
    expect(await sync(connectionId)).toMatchObject({ counts: { updated: 0, flagged: 1 } });
    expect(await db.asAdmin(async (query) => (await query(`select amount_minor, description from transactions where id = $1`, [ledgerId])).rows[0])).toEqual({ amount_minor: 1200, description: "Client coffee (billable)" });
    expect(await external("fixable")).toMatchObject({ reconciliation_state: "NEEDS_REVIEW", review_reason: "PROVIDER_CHANGED_AFTER_EDIT" });

    const id = String((await external("fixable")).id);
    expect(await resolveBankReview(deps(), { organizationId: org, externalId: id, resolution: { kind: "KEEP_BOOKS" }, actorId: OWNER })).toEqual({ kind: "applied" });
    expect(await sync(connectionId)).toMatchObject({ counts: { updated: 0, flagged: 0 } });
    expect((await external("fixable")).reconciliation_state).toBe("IMPORTED");
    expect(await scalar(`select description from transactions where id = $1`, [ledgerId])).toBe("Client coffee (billable)");
  });

  it("flags a posted transaction the bank removes, and never deletes it from the books", async () => {
    const { connectionId } = await connect();
    provider.add(provider.transaction({ providerTransactionId: "reversed" }));
    await sync(connectionId);
    await linkChecking(connectionId);
    provider.remove("reversed");
    await sync(connectionId);
    const row = await external("reversed");
    expect(row).toMatchObject({ status: "REMOVED", reconciliation_state: "NEEDS_REVIEW", review_reason: "REMOVED_BY_PROVIDER" });
    expect(await scalar(`select count(*)::int from transactions where id = $1`, [row.ledger_transaction_id])).toBe(1);
  });

  it("keeps other currencies out of the ledger, and never converts", async () => {
    const { connectionId } = await connect();
    provider.add(provider.transaction({ providerTransactionId: "euro", currency: "EUR" }), provider.transaction({ providerTransactionId: "yen", currency: "JPY", amount: "1500" }));
    provider.add(provider.transaction({ providerTransactionId: "no-currency", currency: null }));
    const outcome = await sync(connectionId);
    expect(outcome).toMatchObject({ counts: { added: 2, rejected: 1 } });
    await linkChecking(connectionId);
    expect((await external("euro")).reconciliation_state).toBe("CURRENCY_MISMATCH");
    expect(await external("yen")).toMatchObject({ reconciliation_state: "UNSUPPORTED_CURRENCY", amount_minor: null, amount_decimal: "1500" });
    expect(await bankLedgerCount()).toBe(0);
    // A USD bank account cannot feed the EUR ledger account either.
    expect(await linkChecking(connectionId, eur)).toEqual({ kind: "refused", reason: "CURRENCY_MISMATCH" });
  });
});

describe("volume and pagination", () => {
  it("syncs thousands of transactions in bounded pages across continuation jobs, then repeats without duplicates", { timeout: 300_000 }, async () => {
    const { connectionId, initialJobId } = await connect();
    const total = 2_600;
    for (let i = 0; i < total; i++) {
      provider.add(provider.transaction({ providerTransactionId: `bulk-${i}`, amount: `${(i % 97) + 1}.${String(i % 100).padStart(2, "0")}`, transactionDate: `2026-0${(i % 8) + 1}-1${i % 9}` }));
    }
    const started = Date.now();

    const first = await runBankSyncJob(deps({ maxPages: 2 }), { organizationId: org, jobId: initialJobId });
    expect(first).toMatchObject({ kind: "succeeded", hasMore: true, counts: { pages: 2, added: 1_000 } });
    expect(await linkChecking(connectionId)).toMatchObject({ kind: "applied", reconciled: 1_000 });

    let jobId = first.kind === "succeeded" ? first.continuationJobId : null;
    let runs = 1;
    while (jobId) {
      const next = await runBankSyncJob(deps({ maxPages: 2 }), { organizationId: org, jobId });
      expect(next.kind).toBe("succeeded");
      jobId = next.kind === "succeeded" ? next.continuationJobId : null;
      runs += 1;
      expect(runs).toBeLessThan(10);
    }
    expect(runs).toBe(3);
    expect(await scalar(`select count(*)::int from bank_external_transactions`)).toBe(total);
    expect(await bankLedgerCount()).toBe(total);
    const expectedMinor = Array.from({ length: total }, (_, i) => ((i % 97) + 1) * 100 + (i % 100)).reduce((sum, value) => sum + value, 0);
    expect(Number(await scalar(`select sum(amount_minor)::bigint from transactions where source = 'bank_sync'`))).toBe(expectedMinor);
    // No run ever took more than two pages.
    expect(await scalar(`select max(pages_fetched)::int from bank_sync_runs`)).toBe(2);

    const repeat = await sync(connectionId);
    expect(repeat).toMatchObject({ kind: "succeeded", counts: { added: 0, imported: 0 } });
    expect(await bankLedgerCount()).toBe(total);
    expect(await scalar(`select count(*)::int from bank_external_transactions`)).toBe(total);
    console.info(`[perf] ${total} transactions: ${runs} runs, ${Date.now() - started} ms`);
  });

  it("settles a thousand pending transactions into exactly a thousand ledger rows", { timeout: 300_000 }, async () => {
    const { connectionId } = await connect();
    await sync(connectionId);
    await linkChecking(connectionId);
    for (let i = 0; i < 1_000; i++) provider.add(provider.transaction({ providerTransactionId: `p-${i}`, status: "PENDING", postedDate: null, amount: "9.99" }));
    await sync(connectionId);
    expect(await scalar(`select count(*)::int from bank_external_transactions where reconciliation_state = 'PENDING_SETTLEMENT'`)).toBe(1_000);
    expect(await bankLedgerCount()).toBe(0);

    for (let i = 0; i < 1_000; i++) {
      provider.add(provider.transaction({ providerTransactionId: `s-${i}`, pendingProviderTransactionId: `p-${i}`, amount: "9.99" }));
      provider.remove(`p-${i}`);
    }
    const settled = await sync(connectionId);
    expect(settled.kind).toBe("succeeded");
    expect(await scalar(`select count(*)::int from bank_external_transactions where status = 'SUPERSEDED'`)).toBe(1_000);
    expect(await bankLedgerCount()).toBe(1_000);
    expect(await sync(connectionId)).toMatchObject({ counts: { imported: 0 } });
    expect(await bankLedgerCount()).toBe(1_000);
  });
});

describe("concurrency", () => {
  it("turns simultaneous refresh requests into one job, and one worker per job", async () => {
    const { connectionId, initialJobId } = await connect();
    provider.add(provider.transaction({ providerTransactionId: "once" }));
    await runBankSyncJob(deps(), { organizationId: org, jobId: initialJobId });
    await linkChecking(connectionId);
    clock = new Date(Date.now() + 60 * 60_000);
    await db.asAdmin((query) => query(`update bank_connections set last_successful_sync_at = now() - interval '2 hours' where id = $1`, [connectionId]));

    const requests = await Promise.all(Array.from({ length: 5 }, () => requestBankSync(deps(), { organizationId: org, connectionId, userId: OWNER, runInline: false })));
    expect(requests.filter((request) => request.kind === "queued")).toHaveLength(1);
    expect(requests.filter((request) => request.kind === "already_active")).toHaveLength(4);
    expect(await scalar(`select count(*)::int from bank_sync_jobs where trigger = 'MANUAL'`)).toBe(1);

    const jobId = await scalar<string>(`select id from bank_sync_jobs where trigger = 'MANUAL'`);
    provider.add(provider.transaction({ providerTransactionId: "twice?" }));
    const [a, b] = await Promise.all([runBankSyncJob(deps(), { organizationId: org, jobId }), runBankSyncJob(deps(), { organizationId: org, jobId })]);
    // One worker runs it; the other is refused at the claim or sees it running.
    expect([a.kind, b.kind].filter((kind) => kind === "succeeded")).toHaveLength(1);
    expect([a.kind, b.kind].filter((kind) => kind === "not_claimed" || kind === "not_runnable")).toHaveLength(1);
    expect(await scalar(`select count(*)::int from bank_sync_runs where job_id = $1`, [jobId])).toBe(1);
    expect(await bankLedgerCount()).toBe(2);
  });
});

describe("failures", () => {
  it("retries transient failures with backoff, degrades the connection, and stops at the attempt limit", async () => {
    const { connectionId } = await connect();
    // The engine's clock stays behind the database's, and moves past each
    // backoff between runs, so every retry is due on both clocks.
    clock = new Date(Date.now() - 5 * 60 * 60_000);
    const job = await store.enqueueJob({ organizationId: org, connectionId, trigger: "MANUAL", idempotencyKey: "flaky", requestedBy: OWNER, webhookEventId: null });
    provider.failNext = ["PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMITED", "PROVIDER_TIMEOUT", "PROVIDER_TIMEOUT"];

    const outcomes = [];
    for (let i = 0; i < 6; i++) {
      outcomes.push(await runBankSyncJob(deps(), { organizationId: org, jobId: job.jobId! }));
      clock = new Date(clock.getTime() + 31 * 60_000);
    }
    expect(outcomes.slice(0, 4).map((outcome) => (outcome.kind === "failed" ? outcome.jobStatus : outcome.kind))).toEqual(["RETRYABLE", "RETRYABLE", "RETRYABLE", "RETRYABLE"]);
    expect(outcomes[4]).toMatchObject({ kind: "failed", jobStatus: "FAILED" });
    expect(outcomes[5]).toMatchObject({ kind: "not_runnable", reason: "finished" });
    expect(provider.calls.fetch).toBe(5);
    expect(await scalar(`select attempts from bank_sync_jobs where id = $1`, [job.jobId])).toBe(5);
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("ERROR");
    expect(await scalar(`select status_reason from bank_connections where id = $1`, [connectionId])).toBe("REPEATED_SYNC_FAILURE");
  });

  it("fails without retrying when a person must act, or the provider sent nonsense", async () => {
    const { connectionId } = await connect();
    provider.failNext = ["REAUTH_REQUIRED"];
    expect(await sync(connectionId)).toMatchObject({ kind: "failed", category: "REAUTH_REQUIRED", jobStatus: "FAILED" });
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("REQUIRES_REAUTH");
    expect(await requestBankSync(deps(), { organizationId: org, connectionId, userId: OWNER, runInline: false })).toEqual({ kind: "not_syncable", status: "REQUIRES_REAUTH" });

    const other = await connect("public-2");
    provider.malformedNext = true;
    expect(await sync(other.connectionId)).toMatchObject({ kind: "failed", category: "MALFORMED_PROVIDER_RESPONSE", jobStatus: "FAILED" });
    expect(await scalar(`select count(*)::int from bank_external_transactions where connection_id = $1`, [other.connectionId])).toBe(0);
  });

  it("restarts pagination from the last complete cursor when the provider asks", async () => {
    const { connectionId } = await connect();
    for (let i = 0; i < 700; i++) provider.add(provider.transaction({ providerTransactionId: `r-${i}` }));
    expect(await sync(connectionId, { maxPages: 1 })).toMatchObject({ kind: "succeeded", hasMore: true });
    expect(await scalar(`select page_cursor from bank_connections where id = $1`, [connectionId])).toBe("cursor-500");
    expect(await scalar(`select committed_cursor from bank_connections where id = $1`, [connectionId])).toBeNull();
    await db.asAdmin((query) => query(`update bank_sync_jobs set status = 'CANCELLED', completed_at = now() where status = 'QUEUED'`));

    provider.failNext = ["CURSOR_RESET_REQUIRED"];
    expect(await sync(connectionId)).toMatchObject({ kind: "failed", category: "CURSOR_RESET_REQUIRED" });
    expect(await scalar(`select page_cursor from bank_connections where id = $1`, [connectionId])).toBeNull();
    await db.asAdmin((query) => query(`update bank_sync_jobs set status = 'CANCELLED', failure_category = null, next_attempt_at = null, completed_at = now() where status = 'RETRYABLE'`));
    expect(await sync(connectionId)).toMatchObject({ kind: "succeeded", counts: { added: 200, unchanged: 500 } });
    expect(await scalar(`select count(*)::int from bank_external_transactions`)).toBe(700);
  });

  it("reports a missing credential and an unconfigured provider as failures, not as imports", async () => {
    const { connectionId } = await connect();
    secrets.secrets.clear();
    expect(await sync(connectionId)).toMatchObject({ kind: "failed", category: "CREDENTIAL_UNAVAILABLE" });
    const other = await connect("public-2");
    expect(await sync(other.connectionId, { providers: [] })).toMatchObject({ kind: "failed", category: "PROVIDER_NOT_CONFIGURED" });
    expect(await requestBankSync(deps({ providers: [] }), { organizationId: org, connectionId: other.connectionId, userId: OWNER, runInline: true })).toMatchObject({ kind: "not_configured" });
  });
});

describe("disconnecting and deleting", () => {
  it("revokes and destroys the credential, cancels work, and keeps every imported transaction", async () => {
    const { connectionId } = await connect();
    provider.add(provider.transaction({ providerTransactionId: "kept" }));
    await sync(connectionId);
    await linkChecking(connectionId);
    const ref = await scalar<string>(`select secret_ref from bank_connection_credentials where connection_id = $1`, [connectionId]);
    await store.enqueueJob({ organizationId: org, connectionId, trigger: "MANUAL", idempotencyKey: "queued-before-disconnect", requestedBy: OWNER, webhookEventId: null });
    const ledgerBefore = await scalar<string>(`select md5(string_agg(t::text, '|' order by t.id)) from transactions t where organization_id = $1`, [org]);

    expect(await disconnectBankConnection(deps(), { organizationId: org, connectionId, actorId: OWNER })).toEqual({ kind: "disconnected", previousStatus: "ACTIVE", providerRevoked: true });
    expect(secrets.destroyed).toEqual([ref]);
    expect(secrets.secrets.has(ref)).toBe(false);
    expect(provider.revokedSecrets).toEqual(["fixture-access-token-public-1"]);
    expect(await scalar(`select count(*)::int from bank_connection_credentials`)).toBe(0);
    expect(await scalar(`select status from bank_sync_jobs where idempotency_key = 'queued-before-disconnect'`)).toBe("CANCELLED");
    expect(await scalar<string>(`select md5(string_agg(t::text, '|' order by t.id)) from transactions t where organization_id = $1`, [org])).toBe(ledgerBefore);
    expect(await disconnectBankConnection(deps(), { organizationId: org, connectionId, actorId: OWNER })).toEqual({ kind: "already_disconnected" });
    expect(await store.enqueueJob({ organizationId: org, connectionId, trigger: "MANUAL", idempotencyKey: "after-disconnect", requestedBy: OWNER, webhookEventId: null })).toEqual({
      jobId: null,
      outcome: "CONNECTION_DISCONNECTED",
    });
    expect(await scalar(`select count(*)::int from bank_external_transactions where provider_transaction_id = 'kept'`)).toBe(1);
  });

  it("does not claim to disconnect when the credential cannot be destroyed", async () => {
    const { connectionId } = await connect();
    secrets.failDestroy = true;
    expect(await disconnectBankConnection(deps(), { organizationId: org, connectionId, actorId: OWNER })).toEqual({ kind: "credential_destroy_failed" });
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("ACTIVE");
    expect(await disconnectBankConnection(deps({ secrets: null }), { organizationId: org, connectionId, actorId: OWNER })).toEqual({ kind: "secret_store_unavailable" });
  });

  it("releases every credential before an organization is deleted, and refuses when it cannot", async () => {
    await connect("one");
    await connect("two");
    expect(await releaseOrganizationBankCredentials(deps({ secrets: null }), org)).toEqual({ ok: false, reason: "SECRET_STORE_UNAVAILABLE" });
    expect(await releaseOrganizationBankCredentials(deps(), org)).toEqual({ ok: true, released: 2 });
    expect(secrets.secrets.size).toBe(0);
    await db.asAdmin((query) => query(`delete from organizations where id = $1`, [org]));
    expect(await scalar(`select count(*)::int from bank_connection_credentials`)).toBe(0);
    expect(await scalar(`select count(*)::int from bank_connections`)).toBe(0);
  });
});

describe("webhooks", () => {
  const deliver = async (event: Record<string, unknown>, options: { signature?: string; providers?: FixtureBankProvider[]; providerId?: string } = {}) => {
    const rawBody = JSON.stringify(event);
    const timestamp = Math.floor(clock.getTime() / 1000);
    return ingestBankWebhook(deps({ providers: options.providers ?? [provider] }), {
      providerId: options.providerId ?? "fixture",
      rawBody,
      headers: { "x-fixture-timestamp": String(timestamp), "x-fixture-signature": options.signature ?? provider.sign(rawBody, timestamp) },
    });
  };
  const event = (overrides: Record<string, unknown> = {}) => ({
    providerEventId: `evt-${Math.random()}`,
    providerEventType: "TRANSACTIONS:SYNC_UPDATES_AVAILABLE",
    type: "TRANSACTIONS_UPDATED",
    providerConnectionId: "item-public-1",
    occurredAt: new Date().toISOString(),
    ...overrides,
  });

  it("refuses unsigned and unconfigured deliveries without writing anything", async () => {
    await connect();
    expect(await deliver(event(), { signature: "00".repeat(32) })).toMatchObject({ status: 400 });
    expect(await deliver(event(), { providers: [] })).toMatchObject({ status: 404 });
    expect(await deliver(event(), { providerId: "plaid" })).toMatchObject({ status: 404 });
    expect(await scalar(`select count(*)::int from bank_webhook_events`)).toBe(0);
  });

  it("enqueues one sync however often, and however concurrently, the same event arrives", async () => {
    const { connectionId, initialJobId } = await connect();
    await runBankSyncJob(deps(), { organizationId: org, jobId: initialJobId });
    const delivery = event({ providerEventId: "evt-dup" });
    const responses = await Promise.all([deliver(delivery), deliver(delivery), deliver(delivery)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await deliver(delivery)).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(await scalar(`select count(*)::int from bank_webhook_events`)).toBe(1);
    expect(await scalar(`select count(*)::int from bank_sync_jobs where trigger = 'WEBHOOK' and connection_id = $1`, [connectionId])).toBe(1);
    expect(await scalar(`select outcome from bank_webhook_events`)).toBe("SYNC_ENQUEUED");
  });

  it("applies lifecycle events in provider order, discarding a late older one", async () => {
    const { connectionId } = await connect();
    expect(await deliver(event({ type: "CONNECTION_REQUIRES_REAUTH", providerEventType: "ITEM:LOGIN_REQUIRED", occurredAt: "2026-09-15T12:00:00Z" }))).toMatchObject({ status: 200 });
    expect(await deliver(event({ type: "CONNECTION_RECOVERED", providerEventType: "ITEM:RECOVERED", occurredAt: "2026-09-15T11:00:00Z" }))).toMatchObject({ status: 200 });
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("REQUIRES_REAUTH");
    expect((await db.asAdmin((query) => query(`select outcome from bank_webhook_events order by received_at, outcome`))).rows).toEqual(expect.arrayContaining([{ outcome: "STATUS_UPDATED" }, { outcome: "STALE_EVENT" }]));
    expect(audits.filter((audit) => audit.action === "bank_connection.status_changed").map((audit) => audit.metadata.to)).toEqual(["ACTIVE", "REQUIRES_REAUTH"]);
  });

  it("ignores events for unknown and disconnected connections — a provider id authorizes nothing", async () => {
    const { connectionId } = await connect();
    expect(await deliver(event({ providerConnectionId: "item-someone-else" }))).toMatchObject({ status: 200 });
    await disconnectBankConnection(deps(), { organizationId: org, connectionId, actorId: OWNER });
    const jobsBefore = await scalar<number>(`select count(*)::int from bank_sync_jobs`);
    expect(await deliver(event())).toMatchObject({ status: 200 });
    expect(await scalar(`select count(*)::int from bank_sync_jobs`)).toBe(jobsBefore);
    expect((await db.asAdmin((query) => query(`select outcome, status from bank_webhook_events order by outcome`))).rows).toEqual([
      { outcome: "CONNECTION_DISCONNECTED", status: "IGNORED" },
      { outcome: "UNKNOWN_CONNECTION", status: "IGNORED" },
    ]);
  });
});

describe("what a sync must never touch or say", () => {
  it("leaves confirmed tax facts, tax cases and other accounts exactly as they were", async () => {
    await db.asAdmin(async (query) => {
      const caseId = ((await query(`insert into tax_preparation_cases (organization_id, tax_year, status, filing_status, legal_first_name, legal_last_name, primary_state_region, created_by) values ($1, 2026, 'COLLECTING', 'single', 'Dana', 'Okafor', 'CA', $2) returning id`, [org, OWNER])).rows[0] as { id: string }).id;
      await query(`insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, currency, source, state, created_by) values ($1, $2, 1, 'W2_WAGES', 8500000, 'USD', 'USER_ENTERED', 'CONFIRMED', $3)`, [org, caseId, OWNER]);
      await query(`insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, source) values ($1, $2, 'income', 99900, 'EUR', '2026-09-01', 'manual')`, [org, eur]);
    });
    const fingerprint = () =>
      scalar<string>(
        `select md5(concat_ws('|', (select string_agg(f::text, '|' order by f.id) from tax_preparation_facts f), (select string_agg(c::text, '|' order by c.id) from tax_preparation_cases c), (select string_agg(t::text, '|' order by t.id) from transactions t where account_id = $1)))`,
        [eur],
      );
    const before = await fingerprint();

    const { connectionId } = await connect();
    provider.add(provider.transaction({ providerTransactionId: "wages", direction: "CREDIT", amount: "7083.33", merchantName: "Employer Payroll" }));
    await sync(connectionId);
    await linkChecking(connectionId);
    await sync(connectionId);
    expect(await bankLedgerCount()).toBe(1);
    expect(await fingerprint()).toBe(before);
  });

  it("logs ids, statuses and counts — never credentials, cursors, merchants, amounts or account numbers", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")));
    }
    const { connectionId } = await connect();
    provider.add(provider.transaction({ providerTransactionId: "secretive", merchantName: "Discreet Clinic", amount: "613.27" }));
    await sync(connectionId);
    await linkChecking(connectionId);
    provider.failNext = ["PROVIDER_TIMEOUT"];
    await sync(connectionId);
    const rawBody = JSON.stringify({ providerEventId: "evt-log", providerEventType: "X", type: "TRANSACTIONS_UPDATED", providerConnectionId: "item-public-1", occurredAt: null });
    await ingestBankWebhook(deps(), { providerId: "fixture", rawBody, headers: { "x-fixture-timestamp": "1", "x-fixture-signature": "bad" } });
    await disconnectBankConnection(deps(), { organizationId: org, connectionId, actorId: OWNER });

    const output = lines.join("\n");
    expect(lines.length).toBeGreaterThan(3);
    for (const forbidden of ["fixture-access-token", "cursor-", "Discreet Clinic", "613.27", "61327", "0000111122223333", "item-public-1", "memory:", "evt-log", "x-fixture-signature"]) {
      expect(output, forbidden).not.toContain(forbidden);
    }
    expect(output).toContain(connectionId);
  });
});

describe("the provider environment boundary", () => {
  /**
   * What this protects. A connection's access token is issued by ONE of a
   * provider's environments and is meaningless — and dangerous — in the other.
   * `provider_environment` records which, immutably (0048). Flipping the
   * deployment's environment, as moving Plaid from Sandbox to Production does,
   * must not make the old connections eligible for a sync.
   *
   * These tests flip `provider.environment` after linking, which is exactly
   * what that switch looks like from the sync engine's side: connections in the
   * database stamped with one environment, a runtime pointed at another.
   */

  /** The provider and secret-store counters, so "zero calls" is measurable. */
  const activity = () => ({ fetch: provider.calls.fetch, revoke: provider.calls.revoke, completeLink: provider.calls.completeLink, secretReads: secrets.reads.length });

  async function connected() {
    const { connectionId } = await connect();
    await sync(connectionId);
    await linkChecking(connectionId);
    return connectionId;
  }

  it("refuses a sandbox connection on a production runtime, before any provider call", async () => {
    provider.environment = "sandbox";
    const connectionId = await connected();
    expect(await scalar<string>(`select provider_environment from bank_connections where id = $1`, [connectionId])).toBe("sandbox");

    // The deployment is re-pointed. The connection cannot follow: its
    // environment is immutable.
    provider.environment = "production";
    provider.add(provider.transaction({ providerTransactionId: "after-switch", amount: "10.00" }));
    const before = activity();

    const outcome = await sync(connectionId);

    expect(outcome).toMatchObject({ kind: "failed", category: "PROVIDER_NOT_CONFIGURED" });
    // The whole point: nothing was fetched and no credential was decrypted.
    expect(activity()).toEqual(before);
  });

  it("refuses a production connection on a sandbox runtime", async () => {
    // The direction that matters most — a real bank's token must never be sent
    // to a sandbox host.
    provider.environment = "production";
    const connectionId = await connected();
    provider.environment = "sandbox";
    const before = activity();

    expect(await sync(connectionId)).toMatchObject({ kind: "failed", category: "PROVIDER_NOT_CONFIGURED" });
    expect(activity()).toEqual(before);
  });

  it("never reads the credential reference of a mismatched connection", async () => {
    provider.environment = "sandbox";
    const connectionId = await connected();
    provider.environment = "production";

    const getCredentialRef = vi.spyOn(store, "getCredentialRef");
    const reads = secrets.reads.length;
    await sync(connectionId);

    // Both halves of "before credential retrieval": the reference is not read
    // from the database, and the ciphertext is never handed to the store.
    expect(getCredentialRef).not.toHaveBeenCalled();
    expect(secrets.reads.length).toBe(reads);
    getCredentialRef.mockRestore();
  });

  it("leaves the encrypted credential in place, so a switch back recovers", async () => {
    provider.environment = "sandbox";
    const connectionId = await connected();
    const secretsHeld = secrets.secrets.size;

    provider.environment = "production";
    await sync(connectionId);
    // A refusal is not a revocation: nothing was destroyed.
    expect(secrets.secrets.size).toBe(secretsHeld);
    expect(secrets.destroyed).toHaveLength(0);

    provider.environment = "sandbox";
    provider.add(provider.transaction({ providerTransactionId: "back-again", amount: "12.34" }));
    expect(await sync(connectionId)).toMatchObject({ kind: "succeeded" });
    expect(await scalar<number>(`select count(*)::int from bank_external_transactions where provider_transaction_id = $1`, ["back-again"])).toBe(1);
  });

  it("fails closed for a connection with no recorded environment", async () => {
    // Rows predating 0048 have `provider_environment` null. Inserted directly
    // because the immutability trigger refuses to change it afterwards — which
    // is also why this case cannot be repaired in place and must fail closed.
    const connectionId = await db.asAdmin(async (query) => {
      await query("set role service_role");
      try {
        const row = (
          await query(
            `insert into bank_connections (organization_id, provider, provider_connection_id, institution_name, provider_environment, created_by)
             values ($1, 'fixture', 'item-legacy', 'Legacy Credit Union', null, $2) returning id`,
            [org, OWNER],
          )
        ).rows[0] as { id: string };
        return row.id;
      } finally {
        await query("reset role");
      }
    });
    expect(await scalar<string | null>(`select provider_environment from bank_connections where id = $1`, [connectionId])).toBeNull();

    const before = activity();
    const job = await store.enqueueJob({ organizationId: org, connectionId, trigger: "SCHEDULED", idempotencyKey: "legacy-1", requestedBy: null, webhookEventId: null });
    expect(job.outcome).toBe("CREATED");
    const outcome = await runBankSyncJob(deps(), { organizationId: org, jobId: job.jobId! });

    expect(outcome).toMatchObject({ kind: "failed", category: "PROVIDER_NOT_CONFIGURED" });
    expect(activity()).toEqual(before);
  });

  it("does not count the refusal against the connection's health", async () => {
    provider.environment = "sandbox";
    const connectionId = await connected();
    provider.environment = "production";
    await sync(connectionId);
    await sync(connectionId);
    await sync(connectionId);

    // PROVIDER_NOT_CONFIGURED is excluded from failureCountsAgainstConnection:
    // a deployment's configuration must not march a workspace's connection to
    // ERROR for something nobody using the product can fix.
    const row = await db.asAdmin(
      async (query) =>
        (await query(`select status, consecutive_failed_runs from bank_connections where id = $1`, [connectionId])).rows[0] as { status: string; consecutive_failed_runs: number },
    );
    expect(row.consecutive_failed_runs).toBe(0);
    expect(row.status).not.toBe("ERROR");
  });

  it("imports nothing and moves no cursor while refusing", async () => {
    provider.environment = "sandbox";
    const connectionId = await connected();
    const externals = await scalar<number>(`select count(*)::int from bank_external_transactions where connection_id = $1`, [connectionId]);
    const ledger = await bankLedgerCount();
    const cursor = await scalar<string | null>(`select committed_cursor from bank_connections where id = $1`, [connectionId]);

    provider.environment = "production";
    provider.add(provider.transaction({ providerTransactionId: "must-not-arrive", amount: "999.99" }));
    await sync(connectionId);

    expect(await scalar<number>(`select count(*)::int from bank_external_transactions where connection_id = $1`, [connectionId])).toBe(externals);
    expect(await bankLedgerCount()).toBe(ledger);
    expect(await scalar<string | null>(`select committed_cursor from bank_connections where id = $1`, [connectionId])).toBe(cursor);
    expect(await scalar<number>(`select count(*)::int from bank_external_transactions where provider_transaction_id = $1`, ["must-not-arrive"])).toBe(0);
  });

  it("syncs completely normally when the environments agree", async () => {
    // The regression guard. Every other test in this file relies on this
    // remaining true, but it is worth asserting head-on.
    provider.environment = "production";
    const connectionId = await connected();
    provider.add(provider.transaction({ providerTransactionId: "normal-1", amount: "40.00" }));
    provider.add(provider.transaction({ providerTransactionId: "normal-2", amount: "41.00" }));

    const outcome = await sync(connectionId);

    expect(outcome).toMatchObject({ kind: "succeeded" });
    expect(await scalar<number>(`select count(*)::int from bank_external_transactions where provider_transaction_id in ('normal-1', 'normal-2')`)).toBe(2);
    expect(await scalar<number>(`select consecutive_failed_runs from bank_connections where id = $1`, [connectionId])).toBe(0);
  });

  it("reports the mismatch with environment names and nothing else", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")));
    }
    provider.environment = "sandbox";
    const connectionId = await connected();
    provider.environment = "production";
    lines.length = 0;
    await sync(connectionId);

    const output = lines.join("\n");
    expect(output).toContain("bank.sync_environment_mismatch");
    expect(output).toContain("sandbox");
    expect(output).toContain("production");
    // The event describes a configuration, not a customer.
    for (const forbidden of ["fixture-access-token", "memory:", "Fixture Credit Union", "0000111122223333", "item-public-1"]) {
      expect(output, forbidden).not.toContain(forbidden);
    }
  });
});
