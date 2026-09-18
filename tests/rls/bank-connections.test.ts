import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * 0047 — bank connections, against real Postgres with every migration applied.
 *
 * Tenant isolation, column-level member access, anonymous access, provider-id
 * substitution, the lifecycle and job state machines, idempotent ingestion,
 * pending → posted, reconciliation into the ledger, webhook idempotency and
 * deletion. Server writes run as `service_role`, exactly the role the Supabase
 * admin client uses, so grants are exercised as deployed.
 *
 * PGlite is a single connection: "concurrent" here means interleaved requests
 * racing on the same rows. What makes them safe is asserted directly — unique
 * indexes, conditional transitions, cursor checks and revision checks — rather
 * than a lock timing that this engine cannot reproduce.
 */

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EMPLOYEE_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let db: TestDatabase;
let orgA: string;
let orgB: string;
let usdA: string;
let eurA: string;
let usdA2: string;
let usdB: string;

const one = <T>(result: { rows: unknown[] }) => result.rows[0] as T;
type Query = TestDatabase["query"];

async function service<T>(fn: (query: Query) => Promise<T>): Promise<T> {
  return db.asAdmin(async (query) => {
    await query("set role service_role");
    try {
      return await fn(query);
    } finally {
      await query("reset role");
    }
  });
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  return db.asAdmin(async (query) => Object.values(one<Record<string, T>>(await query(sql, params)))[0]);
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function tx(overrides: Record<string, unknown> = {}) {
  const item: Record<string, unknown> = {
    provider_transaction_id: "t-1",
    provider_account_id: "acct-1",
    pending_provider_transaction_id: null,
    status: "POSTED",
    direction: "DEBIT",
    amount_decimal: "42.5",
    amount_minor: 4250,
    currency: "USD",
    transaction_date: "2026-09-10",
    posted_date: "2026-09-11",
    authorized_date: null,
    merchant_name: "Corner Coffee",
    description: "CORNER COFFEE 0042",
    category_hint: null,
    ...overrides,
  };
  item.content_hash = sha(JSON.stringify(Object.entries(item).sort()));
  return item;
}

const externalAccount = (overrides: Record<string, unknown> = {}) => ({
  provider_account_id: "acct-1",
  account_type: "DEPOSITORY",
  account_subtype: "checking",
  display_name: "Everyday Checking",
  mask: "1234",
  currency: "USD",
  current_balance_minor: 100_000,
  available_balance_minor: 90_000,
  provider_state: "OPEN",
  ...overrides,
});

async function connection(orgId: string, providerConnectionId = `item-${orgId.slice(0, 8)}`): Promise<string> {
  return service(async (query) => {
    const id = one<{ id: string }>(
      await query(`insert into bank_connections (organization_id, provider, provider_connection_id, institution_name, created_by) values ($1, 'fixture', $2, 'Synthetic Bank', null) returning id`, [
        orgId,
        providerConnectionId,
      ]),
    ).id;
    await query(`select bank_transition_connection($1, $2, 'PENDING', 'ACTIVE', 'LINK_COMPLETED', null)`, [orgId, id]);
    return id;
  });
}

async function startRun(orgId: string, connectionId: string, key = `k-${crypto.randomUUID()}`): Promise<{ jobId: string; runId: string }> {
  return service(async (query) => {
    const job = one<{ job_id: string; outcome: string }>(await query(`select * from bank_enqueue_sync_job($1, $2, 'MANUAL', $3, null, null)`, [orgId, connectionId, key]));
    expect(job.outcome).toBe("CREATED");
    const run = one<{ run: string }>(await query(`select bank_claim_sync_job($1, $2, 600) as run`, [orgId, job.job_id])).run;
    expect(run).toBeTruthy();
    return { jobId: job.job_id, runId: run };
  });
}

async function ingest(
  orgId: string,
  runId: string,
  page: { before: string | null; after: string; hasMore?: boolean; accounts?: unknown[]; transactions?: unknown[]; removed?: string[]; rejected?: number },
): Promise<Record<string, unknown>> {
  return service(async (query) =>
    one<{ result: Record<string, unknown> }>(
      await query(`select bank_ingest_sync_page($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, 600) as result`, [
        orgId,
        runId,
        page.before,
        page.after,
        page.hasMore ?? false,
        JSON.stringify(page.accounts ?? []),
        JSON.stringify(page.transactions ?? []),
        JSON.stringify(page.removed ?? []),
        page.rejected ?? 0,
      ]),
    ).result,
  );
}

async function completeRun(orgId: string, runId: string, outcome = "SUCCEEDED", category: string | null = null, nextAttemptAt: string | null = null) {
  return service(async (query) =>
    one<{ result: string }>(await query(`select bank_complete_sync_run($1, $2, $3, $4, $5, true, 10) as result`, [orgId, runId, outcome, category, nextAttemptAt])).result,
  );
}

async function linkedAccountId(connectionId: string, providerAccountId = "acct-1"): Promise<string> {
  return scalar<string>(`select id from bank_linked_accounts where connection_id = $1 and provider_account_id = $2`, [connectionId, providerAccountId]);
}

async function link(orgId: string, linkedId: string, accountId: string | null, mode = "IMPORT"): Promise<string> {
  return service(async (query) => one<{ result: string }>(await query(`select bank_link_account($1, $2, $3, $4, $5) as result`, [orgId, linkedId, accountId, mode, OWNER_A])).result);
}

async function external(connectionId: string, providerTransactionId: string) {
  return db.asAdmin(async (query) =>
    one<Record<string, unknown> & { id: string; revision: number; status: string; ledger_transaction_id: string | null; reconciliation_state: string }>(
      await query(`select * from bank_external_transactions where connection_id = $1 and provider_transaction_id = $2`, [connectionId, providerTransactionId]),
    ),
  );
}

const importFields = (accountId: string, overrides: Record<string, unknown> = {}) => ({
  account_id: accountId,
  kind: "expense",
  amount_minor: 4250,
  currency: "USD",
  occurred_on: "2026-09-10",
  description: "Corner Coffee",
  ...overrides,
});

async function reconcile(orgId: string, externalId: string, revision: number, decision: Record<string, unknown>, runId: string | null = null, resolution = false): Promise<string> {
  return service(async (query) =>
    one<{ result: string }>(
      await query(`select bank_reconcile_transaction($1, $2, $3, $4::jsonb, $5, $6, $7) as result`, [orgId, externalId, revision, JSON.stringify(decision), runId, null, resolution]),
    ).result,
  );
}

/** A connection with one linked USD account and one ingested posted transaction. */
async function importReady(providerTransaction: Record<string, unknown> = {}) {
  const connectionId = await connection(orgA);
  const { runId } = await startRun(orgA, connectionId);
  await ingest(orgA, runId, { before: null, after: "c1", accounts: [externalAccount()], transactions: [tx(providerTransaction)] });
  const linkedId = await linkedAccountId(connectionId);
  expect(await link(orgA, linkedId, usdA)).toBe("APPLIED");
  return { connectionId, runId, linkedId };
}

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin(async (query) => {
    await query(`insert into auth.users (id, email) values ($1, 'a@example.test'), ($2, 'v@example.test'), ($3, 'e@example.test'), ($4, 'b@example.test')`, [
      OWNER_A,
      VIEWER_A,
      EMPLOYEE_A,
      OWNER_B,
    ]);
  });
  await db.asUser(OWNER_A);
  orgA = one<{ id: string }>(await db.query(`insert into organizations (name, entity_type, created_by) values ('Org A', 'business', $1) returning id`, [OWNER_A])).id;
  await db.asUser(OWNER_B);
  orgB = one<{ id: string }>(await db.query(`insert into organizations (name, entity_type, created_by) values ('Org B', 'business', $1) returning id`, [OWNER_B])).id;

  await db.asAdmin(async (query) => {
    await query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'viewer'), ($1, $3, 'employee')`, [orgA, VIEWER_A, EMPLOYEE_A]);
    usdA = one<{ id: string }>(await query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'Checking', 'bank', 'USD') returning id`, [orgA])).id;
    eurA = one<{ id: string }>(await query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'Euro account', 'bank', 'EUR') returning id`, [orgA])).id;
    usdA2 = one<{ id: string }>(await query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'Savings', 'bank', 'USD') returning id`, [orgA])).id;
    usdB = one<{ id: string }>(await query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'B checking', 'bank', 'USD') returning id`, [orgB])).id;
  });
});

afterEach(async () => {
  await db?.close();
});

describe("tenant isolation and member access", () => {
  it("members read their own organization's connections and nothing of another's", async () => {
    const a = await connection(orgA, "item-a");
    const b = await connection(orgB, "item-b");

    await db.asUser(VIEWER_A);
    expect((await db.query(`select id from bank_connections`)).rows).toEqual([{ id: a }]);
    await db.asUser(OWNER_B);
    expect((await db.query(`select id from bank_connections`)).rows).toEqual([{ id: b }]);
    // Naming the other tenant's id changes nothing.
    expect((await db.query(`select id from bank_connections where id = $1`, [a])).rows).toEqual([]);
  });

  it("hides provider identifiers, cursors, idempotency keys, credentials and webhook deliveries from members", async () => {
    const connectionId = await connection(orgA);
    const { runId } = await startRun(orgA, connectionId);
    await ingest(orgA, runId, { before: null, after: "c1", accounts: [externalAccount()], transactions: [tx()] });
    await service((query) => query(`insert into bank_connection_credentials (connection_id, organization_id, secret_ref) values ($1, $2, 'vault:5f0c7a52-9a57-4a55-9d0e-6a8c7a1f7d21')`, [connectionId, orgA]));

    await db.asUser(OWNER_A);
    // What members may read works…
    expect((await db.query(`select status, institution_name from bank_connections`)).rows).toHaveLength(1);
    expect((await db.query(`select display_name, mask from bank_linked_accounts`)).rows).toEqual([{ display_name: "Everyday Checking", mask: "1234" }]);
    expect((await db.query(`select amount_minor, merchant_name from bank_external_transactions`)).rows).toHaveLength(1);
    // …and the provider internals do not.
    for (const sql of [
      `select provider_connection_id from bank_connections`,
      `select page_cursor from bank_connections`,
      `select committed_cursor from bank_connections`,
      `select * from bank_connections`,
      `select provider_account_id from bank_linked_accounts`,
      `select provider_transaction_id from bank_external_transactions`,
      `select content_hash from bank_external_transactions`,
      `select idempotency_key from bank_sync_jobs`,
      `select * from bank_connection_credentials`,
      `select * from bank_webhook_events`,
    ]) {
      await expect(db.query(sql), sql).rejects.toThrow(/permission denied/);
    }
  });

  it("gives anonymous sessions nothing at all", async () => {
    await connection(orgA);
    await db.asAdmin(async () => {});
    await db.query(`set role anon`);
    for (const table of ["bank_connections", "bank_connection_credentials", "bank_linked_accounts", "bank_webhook_events", "bank_sync_jobs", "bank_sync_runs", "bank_external_transactions", "bank_transaction_revisions"]) {
      await expect(db.query(`select count(*) from ${table}`), table).rejects.toThrow(/permission denied/);
    }
    await expect(db.query(`select bank_finalize_disconnect(gen_random_uuid(), gen_random_uuid(), null)`)).rejects.toThrow(/permission denied/);
  });

  it("lets no member — owners included — write any bank table", async () => {
    const connectionId = await connection(orgA);
    const { runId } = await startRun(orgA, connectionId);
    await ingest(orgA, runId, { before: null, after: "c1", accounts: [externalAccount()], transactions: [tx()] });
    const linkedId = await linkedAccountId(connectionId);

    await db.asUser(OWNER_A);
    for (const [sql, params] of [
      [`insert into bank_connections (organization_id, provider, provider_connection_id) values ($1, 'fixture', 'forged')`, [orgA]],
      [`update bank_connections set status = 'ACTIVE' where id = $1`, [connectionId]],
      [`delete from bank_connections where id = $1`, [connectionId]],
      [`update bank_linked_accounts set account_id = $1, import_mode = 'IMPORT' where id = $2`, [usdA, linkedId]],
      [`insert into bank_external_transactions (organization_id, connection_id, linked_account_id, provider, provider_transaction_id, status, direction, amount_decimal, amount_minor, currency, transaction_date, content_hash) values ($1, $2, $3, 'fixture', 'forged', 'POSTED', 'CREDIT', '1000000', 100000000, 'USD', '2026-09-01', $4)`, [orgA, connectionId, linkedId, "a".repeat(64)]],
      [`update bank_external_transactions set reconciliation_state = 'IGNORED'`, []],
      [`update bank_sync_jobs set status = 'CANCELLED'`, []],
      [`insert into bank_connection_credentials (connection_id, organization_id, secret_ref) values ($1, $2, 'vault:aaaaaaaaaaaa')`, [connectionId, orgA]],
      [`insert into bank_webhook_events (provider, provider_event_id, event_type, provider_event_type, payload_sha256) values ('fixture', 'e', 'UNSUPPORTED', 'x', $1)`, ["a".repeat(64)]],
    ] as [string, unknown[]][]) {
      await expect(db.query(sql, params), sql).rejects.toThrow(/permission denied/);
    }
  });

  it("lets no member call a bank function", async () => {
    const connectionId = await connection(orgA);
    await db.asUser(OWNER_A);
    for (const sql of [
      `select * from bank_enqueue_sync_job('${orgA}', '${connectionId}', 'MANUAL', 'k', null, null)`,
      `select bank_claim_sync_job('${orgA}', gen_random_uuid(), 600)`,
      `select bank_finalize_disconnect('${orgA}', '${connectionId}', null)`,
      `select bank_transition_connection('${orgA}', '${connectionId}', 'ACTIVE', 'ERROR', 'PROVIDER_REPORTED_ERROR', null)`,
      `select bank_link_account('${orgA}', gen_random_uuid(), '${usdA}', 'IMPORT', null)`,
      `select bank_reconcile_transaction('${orgA}', gen_random_uuid(), 1, '{}'::jsonb, null, null, false)`,
      `select * from bank_match_candidates('${orgA}', '${usdA}', 'expense', 1, 'USD', '2026-01-01', '2026-12-31')`,
      `select * from bank_claim_webhook_event('fixture', 'e', 'UNSUPPORTED', 'x', null, null, '${"a".repeat(64)}', 120)`,
    ]) {
      await expect(db.query(sql), sql).rejects.toThrow(/permission denied for function/);
    }
  });

  it("refuses to register one provider connection into a second organization", async () => {
    await connection(orgA, "item-shared");
    await expect(service((query) => query(`insert into bank_connections (organization_id, provider, provider_connection_id) values ($1, 'fixture', 'item-shared')`, [orgB]))).rejects.toThrow(
      /bank_connections_provider_identity_unique/,
    );
  });

  it("refuses every cross-organization reference, whatever ids are supplied", async () => {
    const connectionId = await connection(orgA);
    const { runId } = await startRun(orgA, connectionId);
    await ingest(orgA, runId, { before: null, after: "c1", accounts: [externalAccount()], transactions: [tx()] });
    const linkedId = await linkedAccountId(connectionId);
    const ext = await external(connectionId, "t-1");

    // Org A's external account cannot feed org B's account.
    expect(await link(orgA, linkedId, usdB)).toBe("NOT_FOUND");
    await expect(service((query) => query(`update bank_linked_accounts set account_id = $1, import_mode = 'IMPORT', linked_at = now() where id = $2`, [usdB, linkedId]))).rejects.toThrow();
    // Naming org B with org A's objects finds nothing.
    expect(await link(orgB, linkedId, usdB)).toBe("NOT_FOUND");
    expect(await reconcile(orgB, ext.id, ext.revision, { kind: "SET_STATE", state: "IGNORED" })).toBe("NOT_FOUND");
    await expect(ingest(orgB, runId, { before: "c1", after: "c2" })).rejects.toThrow(/run not found/);
    const enqueued = await service(async (query) => one<{ outcome: string }>(await query(`select * from bank_enqueue_sync_job($1, $2, 'MANUAL', 'x', null, null)`, [orgB, connectionId])));
    expect(enqueued.outcome).toBe("NOT_FOUND");
    expect(await service(async (query) => one<{ r: string }>(await query(`select bank_finalize_disconnect($1, $2, null) as r`, [orgB, connectionId])).r)).toBe("NOT_FOUND");
  });
});

describe("the origin of a ledger transaction", () => {
  it("cannot be forged or laundered by a member, and stays editable otherwise", async () => {
    const { connectionId } = await importReady();
    const ext = await external(connectionId, "t-1");
    expect(await reconcile(orgA, ext.id, ext.revision, { kind: "IMPORT", ledger: importFields(usdA) })).toBe("APPLIED");
    const imported = (await external(connectionId, "t-1")).ledger_transaction_id!;

    await db.asUser(OWNER_A);
    await expect(
      db.query(`insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, source) values ($1, $2, 'income', 500, 'USD', '2026-09-01', 'bank_sync')`, [orgA, usdA]),
    ).rejects.toThrow(/bank_sync/);
    const manual = one<{ id: string }>(
      await db.query(`insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, source) values ($1, $2, 'income', 500, 'USD', '2026-09-01', 'manual') returning id`, [orgA, usdA]),
    ).id;
    await expect(db.query(`update transactions set source = 'bank_sync' where id = $1`, [manual])).rejects.toThrow(/bank_sync/);
    await expect(db.query(`update transactions set source = 'manual' where id = $1`, [imported])).rejects.toThrow(/bank_sync/);
    // A person may still correct the imported transaction itself.
    await db.query(`update transactions set description = 'Team coffee', is_reviewed = true where id = $1`, [imported]);
    expect(await scalar(`select description from transactions where id = $1`, [imported])).toBe("Team coffee");
  });
});

describe("connection lifecycle", () => {
  it("starts PENDING, moves only along legal transitions, and discards stale provider events", async () => {
    await expect(service((query) => query(`insert into bank_connections (organization_id, provider, provider_connection_id, status) values ($1, 'fixture', 'x', 'ACTIVE')`, [orgA]))).rejects.toThrow(/starts PENDING/);

    const id = await service(async (query) => one<{ id: string }>(await query(`insert into bank_connections (organization_id, provider, provider_connection_id) values ($1, 'fixture', 'x') returning id`, [orgA])).id);
    await expect(service((query) => query(`update bank_connections set status = 'REQUIRES_REAUTH' where id = $1`, [id]))).rejects.toThrow(/cannot move from PENDING to REQUIRES_REAUTH/);
    const transition = (expected: string, to: string, at: string | null) =>
      service(async (query) => one<{ r: string }>(await query(`select bank_transition_connection($1, $2, $3, $4, 'PROVIDER_REPORTED_REAUTH', $5) as r`, [orgA, id, expected, to, at])).r);

    expect(await transition("PENDING", "REQUIRES_REAUTH", null)).toBe("ILLEGAL");
    expect(await transition("PENDING", "ACTIVE", "2026-09-15T10:00:00Z")).toBe("APPLIED");
    expect(await transition("ACTIVE", "REQUIRES_REAUTH", "2026-09-15T12:00:00Z")).toBe("APPLIED");
    // An older event delivered late does not roll the status back.
    expect(await transition("REQUIRES_REAUTH", "ACTIVE", "2026-09-15T11:00:00Z")).toBe("STALE");
    // Neither does a caller that read an old status.
    expect(await transition("ACTIVE", "ERROR", "2026-09-15T13:00:00Z")).toBe("STATUS_CHANGED");
    expect(await scalar(`select status from bank_connections where id = $1`, [id])).toBe("REQUIRES_REAUTH");
    await expect(service((query) => query(`delete from bank_connections where id = $1`, [id]))).rejects.toThrow(/disconnect a connection instead/);
  });

  it("refuses to disconnect while a credential exists, then disconnects without touching history", async () => {
    const { connectionId, runId } = await importReady();
    const ext = await external(connectionId, "t-1");
    expect(await reconcile(orgA, ext.id, ext.revision, { kind: "IMPORT", ledger: importFields(usdA) })).toBe("APPLIED");
    await service((query) => query(`insert into bank_connection_credentials (connection_id, organization_id, secret_ref) values ($1, $2, 'vault:5f0c7a52-9a57-4a55-9d0e-6a8c7a1f7d21')`, [connectionId, orgA]));
    const ledgerBefore = await scalar<string>(`select md5(string_agg(t::text, '|' order by t.id)) from transactions t where organization_id = $1`, [orgA]);

    await expect(service((query) => query(`update bank_connections set status = 'DISCONNECTED', disconnected_at = now() where id = $1`, [connectionId]))).rejects.toThrow(/credential must be destroyed/);

    const previous = await service(async (query) => one<{ r: string }>(await query(`select bank_finalize_disconnect($1, $2, $3) as r`, [orgA, connectionId, OWNER_A])).r);
    expect(previous).toBe("ACTIVE");
    expect(await scalar(`select count(*)::int from bank_connection_credentials where connection_id = $1`, [connectionId])).toBe(0);
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("DISCONNECTED");
    expect(await scalar(`select count(*)::int from bank_connections where id = $1 and page_cursor is null and committed_cursor is null`, [connectionId])).toBe(1);
    expect(await scalar(`select status from bank_sync_runs where id = $1`, [runId])).toBe("CANCELLED");
    expect(await scalar(`select count(*)::int from bank_sync_jobs where connection_id = $1 and status in ('QUEUED','RUNNING','RETRYABLE')`, [connectionId])).toBe(0);
    expect(await scalar(`select count(*)::int from bank_linked_accounts where connection_id = $1 and detached_at is not null`, [connectionId])).toBe(1);
    // History and the books are untouched.
    expect(await scalar(`select count(*)::int from bank_external_transactions where connection_id = $1`, [connectionId])).toBe(1);
    expect(await scalar<string>(`select md5(string_agg(t::text, '|' order by t.id)) from transactions t where organization_id = $1`, [orgA])).toBe(ledgerBefore);

    // Terminal.
    expect(await service(async (query) => one<{ r: string }>(await query(`select bank_finalize_disconnect($1, $2, $3) as r`, [orgA, connectionId, OWNER_A])).r)).toBe("ALREADY_DISCONNECTED");
    await expect(service((query) => query(`update bank_connections set institution_name = 'Renamed' where id = $1`, [connectionId]))).rejects.toThrow(/disconnected bank connection cannot change/);
    await expect(service((query) => query(`insert into bank_connection_credentials (connection_id, organization_id, secret_ref) values ($1, $2, 'vault:5f0c7a52-9a57-4a55-9d0e-6a8c7a1f7d22')`, [connectionId, orgA]))).rejects.toThrow(/holds no credential/);
    const enqueued = await service(async (query) => one<{ outcome: string }>(await query(`select * from bank_enqueue_sync_job($1, $2, 'MANUAL', 'after', null, null)`, [orgA, connectionId])));
    expect(enqueued.outcome).toBe("CONNECTION_DISCONNECTED");
    // The released account can be fed by a future connection.
    const next = await connection(orgA, "item-next");
    const { runId: nextRun } = await startRun(orgA, next);
    await ingest(orgA, nextRun, { before: null, after: "n1", accounts: [externalAccount({ provider_account_id: "acct-new" })] });
    expect(await link(orgA, await linkedAccountId(next, "acct-new"), usdA)).toBe("APPLIED");
  });

  it("stores credential references and refuses anything shaped like a raw token", async () => {
    const connectionId = await connection(orgA);
    for (const ref of ["access-sandbox-12345678-aaaa-bbbb", "vault:access-production-12345678", "plain-token-without-store"]) {
      await expect(service((query) => query(`insert into bank_connection_credentials (connection_id, organization_id, secret_ref) values ($1, $2, $3)`, [connectionId, orgA, ref])), ref).rejects.toThrow(/check constraint/);
    }
    await service((query) => query(`insert into bank_connection_credentials (connection_id, organization_id, secret_ref) values ($1, $2, 'vault:5f0c7a52-9a57-4a55-9d0e-6a8c7a1f7d21')`, [connectionId, orgA]));
  });
});

describe("linked accounts", () => {
  it("are recorded unlinked, link only within one currency, and feed one account at most", async () => {
    const connectionId = await connection(orgA);
    const { runId } = await startRun(orgA, connectionId);
    await ingest(orgA, runId, { before: null, after: "c1", accounts: [externalAccount(), externalAccount({ provider_account_id: "acct-2", display_name: "Second" })] });
    const first = await linkedAccountId(connectionId);
    const second = await linkedAccountId(connectionId, "acct-2");

    expect(await scalar(`select import_mode from bank_linked_accounts where id = $1`, [first])).toBe("AWAITING_DECISION");
    await expect(service((query) => query(`insert into bank_linked_accounts (organization_id, connection_id, provider_account_id, account_type, display_name, import_mode) values ($1, $2, 'forged', 'DEPOSITORY', 'x', 'IMPORT')`, [orgA, connectionId]))).rejects.toThrow(/recorded unlinked/);

    expect(await link(orgA, first, eurA)).toBe("CURRENCY_MISMATCH");
    expect(await link(orgA, first, usdA)).toBe("APPLIED");
    expect(await link(orgA, second, usdA)).toBe("ACCOUNT_ALREADY_LINKED");
    await expect(service((query) => query(`update bank_linked_accounts set account_id = $1, import_mode = 'IMPORT', linked_at = now() where id = $2`, [usdA, second]))).rejects.toThrow(/one_feed_per_account/);
    await expect(service((query) => query(`update bank_linked_accounts set account_id = $1, import_mode = 'IMPORT', linked_at = now() where id = $2`, [eurA, second]))).rejects.toThrow(/cannot feed an account in EUR/);
  });

  it("stay with their account once transactions are in the ledger", async () => {
    const { connectionId, linkedId } = await importReady();
    const ext = await external(connectionId, "t-1");
    expect(await reconcile(orgA, ext.id, ext.revision, { kind: "IMPORT", ledger: importFields(usdA) })).toBe("APPLIED");
    expect(await link(orgA, linkedId, usdA2)).toBe("HAS_IMPORTED_HISTORY");
  });

  it("lose their link, not their history, when a Countorra account with no transactions is deleted", async () => {
    const connectionId = await connection(orgA);
    const { runId } = await startRun(orgA, connectionId);
    await ingest(orgA, runId, { before: null, after: "c1", accounts: [externalAccount()] });
    const linkedId = await linkedAccountId(connectionId);
    expect(await link(orgA, linkedId, usdA2)).toBe("APPLIED");
    await db.asUser(OWNER_A);
    await db.query(`delete from accounts where id = $1`, [usdA2]);
    expect(await scalar(`select account_id from bank_linked_accounts where id = $1`, [linkedId])).toBeNull();
  });
});

describe("sync jobs", () => {
  it("allow one active job per connection, and one job per idempotency key", async () => {
    const connectionId = await connection(orgA);
    const enqueue = (key: string) => service(async (query) => one<{ job_id: string; outcome: string }>(await query(`select * from bank_enqueue_sync_job($1, $2, 'MANUAL', $3, null, null)`, [orgA, connectionId, key])));

    const first = await enqueue("k1");
    expect(first.outcome).toBe("CREATED");
    expect(await enqueue("k1")).toEqual({ job_id: first.job_id, outcome: "DUPLICATE" });
    expect(await enqueue("k2")).toEqual({ job_id: first.job_id, outcome: "ALREADY_ACTIVE" });
    // Interleaved direct inserts are stopped by the index, not by the function.
    await expect(service((query) => query(`insert into bank_sync_jobs (organization_id, connection_id, trigger, idempotency_key) values ($1, $2, 'WEBHOOK', 'k3')`, [orgA, connectionId]))).rejects.toThrow(/bank_sync_jobs_one_active_idx/);
    expect(await scalar(`select count(*)::int from bank_sync_jobs where connection_id = $1`, [connectionId])).toBe(1);
  });

  it("are claimed once, and never skip RUNNING", async () => {
    const connectionId = await connection(orgA);
    const { jobId, runId } = await startRun(orgA, connectionId);
    expect(await service(async (query) => one<{ r: string | null }>(await query(`select bank_claim_sync_job($1, $2, 600) as r`, [orgA, jobId])).r)).toBeNull();
    expect(await scalar(`select attempts from bank_sync_jobs where id = $1`, [jobId])).toBe(1);
    expect(await scalar(`select count(*)::int from bank_sync_runs where job_id = $1`, [jobId])).toBe(1);

    const other = await service(async (query) =>
      one<{ id: string }>(await query(`insert into bank_sync_jobs (organization_id, connection_id, trigger, idempotency_key) values ($1, $2, 'MANUAL', 'direct') returning id`, [orgA, await connection(orgA, "item-2")])).id,
    );
    await expect(service((query) => query(`update bank_sync_jobs set status = 'SUCCEEDED', completed_at = now() where id = $1`, [other]))).rejects.toThrow(/cannot move from QUEUED to SUCCEEDED/);
    expect(runId).toBeTruthy();
  });

  it("stop retrying when attempts run out", async () => {
    const connectionId = await connection(orgA);
    const jobId = await service(async (query) =>
      one<{ id: string }>(await query(`insert into bank_sync_jobs (organization_id, connection_id, trigger, idempotency_key, max_attempts) values ($1, $2, 'MANUAL', 'bounded', 2) returning id`, [orgA, connectionId])).id,
    );
    const claim = () => service(async (query) => one<{ r: string | null }>(await query(`select bank_claim_sync_job($1, $2, 600) as r`, [orgA, jobId])).r);

    const run1 = (await claim())!;
    expect(await completeRun(orgA, run1, "FAILED", "PROVIDER_TIMEOUT", "2026-01-01T00:00:00Z")).toBe("RETRYABLE");
    const run2 = (await claim())!;
    expect(run2).not.toBe(run1);
    expect(await completeRun(orgA, run2, "FAILED", "PROVIDER_TIMEOUT", "2026-01-01T00:00:00Z")).toBe("FAILED");
    expect(await claim()).toBeNull();
    expect(await scalar(`select attempts from bank_sync_jobs where id = $1`, [jobId])).toBe(2);
    expect(await scalar(`select consecutive_failed_runs from bank_connections where id = $1`, [connectionId])).toBe(2);
  });

  it("recover a run whose lease expired, and refuse its late pages", async () => {
    const connectionId = await connection(orgA);
    const { jobId, runId } = await startRun(orgA, connectionId);
    await service((query) => query(`update bank_sync_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`, [jobId]));

    const next = await service(async (query) => one<{ r: string | null }>(await query(`select bank_claim_sync_job($1, $2, 600) as r`, [orgA, jobId])).r);
    expect(next).toBeTruthy();
    expect(await scalar(`select failure_category from bank_sync_runs where id = $1`, [runId])).toBe("LEASE_EXPIRED");
    expect(await scalar(`select attempts from bank_sync_jobs where id = $1`, [jobId])).toBe(2);
    // The zombie worker's page is refused.
    expect(await ingest(orgA, runId, { before: null, after: "late", transactions: [tx()] })).toEqual({ outcome: "RUN_NOT_ACTIVE" });
  });
});

describe("ingestion", () => {
  it("is idempotent, and refuses a page that does not continue from the current cursor", async () => {
    const connectionId = await connection(orgA);
    const { runId } = await startRun(orgA, connectionId);
    const page = { accounts: [externalAccount()], transactions: [tx({ provider_transaction_id: "a" }), tx({ provider_transaction_id: "b" }), tx({ provider_transaction_id: "c" })] };

    expect(await ingest(orgA, runId, { before: null, after: "c1", ...page })).toMatchObject({ outcome: "APPLIED", added: 3 });
    // Replaying from a cursor that is no longer current is refused outright.
    expect(await ingest(orgA, runId, { before: null, after: "c1", ...page })).toEqual({ outcome: "CURSOR_CONFLICT" });
    // Replaying the same content from the current cursor changes nothing.
    expect(await ingest(orgA, runId, { before: "c1", after: "c2", ...page })).toMatchObject({ outcome: "APPLIED", added: 0, modified: 0, unchanged: 3 });
    expect(await scalar(`select count(*)::int from bank_external_transactions where connection_id = $1`, [connectionId])).toBe(3);
    expect(await scalar(`select count(*)::int from bank_linked_accounts where connection_id = $1`, [connectionId])).toBe(1);
    expect(await scalar(`select count(*)::int from bank_transaction_revisions r join bank_external_transactions e on e.id = r.external_transaction_id where e.connection_id = $1`, [connectionId])).toBe(3);
    expect(await scalar(`select committed_cursor from bank_connections where id = $1`, [connectionId])).toBe("c2");
    expect(await scalar(`select transactions_unchanged from bank_sync_runs where id = $1`, [runId])).toBe(3);
  });

  it("keeps the committed cursor until pagination completes, and can restart from it", async () => {
    const connectionId = await connection(orgA);
    const { runId } = await startRun(orgA, connectionId);
    await ingest(orgA, runId, { before: null, after: "p1", hasMore: true, accounts: [externalAccount()], transactions: [tx({ provider_transaction_id: "a" })] });
    expect(await scalar(`select committed_cursor from bank_connections where id = $1`, [connectionId])).toBeNull();
    await service((query) => query(`select bank_reset_page_cursor($1, $2)`, [orgA, connectionId]));
    expect(await scalar(`select page_cursor from bank_connections where id = $1`, [connectionId])).toBeNull();
    // Replaying from the start re-applies the first page harmlessly.
    expect(await ingest(orgA, runId, { before: null, after: "p1", hasMore: true, transactions: [tx({ provider_transaction_id: "a" })] })).toMatchObject({ added: 0, unchanged: 1 });
    expect(await ingest(orgA, runId, { before: "p1", after: "p2", hasMore: false, transactions: [tx({ provider_transaction_id: "b" })] })).toMatchObject({ added: 1 });
    expect(await scalar(`select committed_cursor from bank_connections where id = $1`, [connectionId])).toBe("p2");
  });

  it("updates a pending transaction in place when it posts under the same id", async () => {
    const connectionId = await connection(orgA);
    const { runId } = await startRun(orgA, connectionId);
    await ingest(orgA, runId, { before: null, after: "c1", accounts: [externalAccount()], transactions: [tx({ provider_transaction_id: "p", status: "PENDING", posted_date: null, amount_decimal: "40", amount_minor: 4000 })] });
    await ingest(orgA, runId, { before: "c1", after: "c2", transactions: [tx({ provider_transaction_id: "p", status: "POSTED" })] });

    const row = await external(connectionId, "p");
    expect(row).toMatchObject({ status: "POSTED", revision: 2, amount_minor: 4250, needs_reconciliation: true });
    expect(await scalar(`select count(*)::int from bank_external_transactions where connection_id = $1`, [connectionId])).toBe(1);
    expect((await db.asAdmin((query) => query(`select change_kind from bank_transaction_revisions where external_transaction_id = $1 order by created_at, revision`, [row.id]))).rows).toEqual([
      { change_kind: "CREATED" },
      { change_kind: "POSTED" },
    ]);
  });

  it("supersedes a pending transaction replaced by a posted one with a new id — across pages or within one", async () => {
    const connectionId = await connection(orgA);
    const { runId } = await startRun(orgA, connectionId);
    await ingest(orgA, runId, { before: null, after: "c1", accounts: [externalAccount()], transactions: [tx({ provider_transaction_id: "pending-1", status: "PENDING", posted_date: null })] });
    await ingest(orgA, runId, { before: "c1", after: "c2", transactions: [tx({ provider_transaction_id: "posted-1", pending_provider_transaction_id: "pending-1" })], removed: ["pending-1"] });

    const pending = await external(connectionId, "pending-1");
    const posted = await external(connectionId, "posted-1");
    expect(pending).toMatchObject({ status: "SUPERSEDED", superseded_by_id: posted.id, revision: 2 });
    expect(posted.status).toBe("POSTED");

    await ingest(orgA, runId, {
      before: "c2",
      after: "c3",
      transactions: [tx({ provider_transaction_id: "pending-2", status: "PENDING", posted_date: null }), tx({ provider_transaction_id: "posted-2", pending_provider_transaction_id: "pending-2" })],
    });
    expect((await external(connectionId, "pending-2")).status).toBe("SUPERSEDED");
    // A superseded row never becomes posted again.
    expect(await ingest(orgA, runId, { before: "c3", after: "c4", transactions: [tx({ provider_transaction_id: "pending-1", status: "POSTED" })] })).toMatchObject({ unchanged: 1, modified: 0 });
  });

  it("marks removals, counts rejections, and refuses a posted transaction going back to pending", async () => {
    const connectionId = await connection(orgA);
    const { runId } = await startRun(orgA, connectionId);
    await ingest(orgA, runId, { before: null, after: "c1", accounts: [externalAccount()], transactions: [tx({ provider_transaction_id: "gone", status: "PENDING", posted_date: null }), tx({ provider_transaction_id: "kept" })] });
    const result = await ingest(orgA, runId, {
      before: "c1",
      after: "c2",
      transactions: [tx({ provider_transaction_id: "orphan", provider_account_id: "unknown-account" }), tx({ provider_transaction_id: "kept", status: "PENDING", posted_date: null })],
      removed: ["gone", "never-seen"],
      rejected: 2,
    });
    expect(result).toMatchObject({ outcome: "APPLIED", removed: 1, rejected: 4, added: 0 });
    expect((await external(connectionId, "gone")).status).toBe("REMOVED");
    expect((await external(connectionId, "kept")).status).toBe("POSTED");
    expect(await external(connectionId, "orphan")).toBeUndefined();
  });
});

describe("reconciliation into the ledger", () => {
  const ledgerCount = () => scalar<number>(`select count(*)::int from transactions where organization_id = $1`, [orgA]);

  it("imports exactly one ledger transaction, unattributed, and never a second", async () => {
    const { connectionId, runId } = await importReady();
    const ext = await external(connectionId, "t-1");
    const before = await ledgerCount();

    expect(await reconcile(orgA, ext.id, ext.revision, { kind: "IMPORT", ledger: importFields(usdA) }, runId)).toBe("APPLIED");
    expect(await reconcile(orgA, ext.id, ext.revision, { kind: "IMPORT", ledger: importFields(usdA) }, runId)).toBe("INVALID");
    expect(await ledgerCount()).toBe(before + 1);

    const row = await external(connectionId, "t-1");
    expect(row).toMatchObject({ reconciliation_state: "IMPORTED", ledger_link_kind: "IMPORTED", needs_reconciliation: false });
    const ledger = await db.asAdmin(async (query) => one<Record<string, unknown>>(await query(`select * from transactions where id = $1`, [row.ledger_transaction_id])));
    expect(ledger).toMatchObject({ source: "bank_sync", created_by: null, amount_minor: 4250, currency: "USD", kind: "expense", account_id: usdA, description: "Corner Coffee" });
    expect(await scalar(`select ledger_imported from bank_sync_runs where id = $1`, [runId])).toBe(1);
  });

  it("refuses a decision that does not describe the transaction, a pending one, or the wrong currency", async () => {
    const { connectionId, runId } = await importReady();
    const ext = await external(connectionId, "t-1");
    const before = await ledgerCount();
    for (const tampered of [{ amount_minor: 1 }, { account_id: usdA2 }, { kind: "income" }, { occurred_on: "2026-01-01" }, { currency: "EUR" }]) {
      expect(await reconcile(orgA, ext.id, ext.revision, { kind: "IMPORT", ledger: importFields(usdA, tampered) }), JSON.stringify(tampered)).toBe("INVALID");
    }

    await ingest(orgA, runId, { before: "c1", after: "c2", transactions: [tx({ provider_transaction_id: "pending", status: "PENDING", posted_date: null }), tx({ provider_transaction_id: "euro", currency: "EUR" })] });
    const pending = await external(connectionId, "pending");
    const euro = await external(connectionId, "euro");
    expect(await reconcile(orgA, pending.id, pending.revision, { kind: "IMPORT", ledger: importFields(usdA) })).toBe("INVALID");
    expect(await reconcile(orgA, euro.id, euro.revision, { kind: "IMPORT", ledger: importFields(usdA, { currency: "EUR" }) })).toBe("INVALID");
    await expect(service((query) => query(`update bank_external_transactions set ledger_transaction_id = (select id from transactions limit 1), ledger_link_kind = 'IMPORTED', ledger_linked_at = now() where id = $1`, [pending.id]))).rejects.toThrow();
    expect(await ledgerCount()).toBe(before);
  });

  it("matches a hand-entered transaction without changing it, and only once", async () => {
    const { connectionId, runId } = await importReady();
    const manual = await db.asAdmin(async (query) =>
      one<{ id: string }>(await query(`insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, description, source, created_by) values ($1, $2, 'expense', 4250, 'USD', '2026-09-08', 'Coffee with Sam', 'manual', $3) returning id`, [orgA, usdA, OWNER_A])).id,
    );
    const manualBefore = await scalar<string>(`select md5(t::text) from transactions t where id = $1`, [manual]);
    const candidates = (await service((query) => query(`select * from bank_match_candidates($1, $2, 'expense', 4250, 'USD', '2026-09-07', '2026-09-13')`, [orgA, usdA]))).rows;
    expect(candidates).toHaveLength(1);

    const ext = await external(connectionId, "t-1");
    expect(await reconcile(orgA, ext.id, ext.revision, { kind: "MATCH", ledger_transaction_id: manual }, runId)).toBe("APPLIED");
    expect(await scalar<string>(`select md5(t::text) from transactions t where id = $1`, [manual])).toBe(manualBefore);
    expect((await external(connectionId, "t-1")).reconciliation_state).toBe("MATCHED");

    await ingest(orgA, runId, { before: "c1", after: "c2", transactions: [tx({ provider_transaction_id: "t-dup" })] });
    const duplicate = await external(connectionId, "t-dup");
    expect(await reconcile(orgA, duplicate.id, duplicate.revision, { kind: "MATCH", ledger_transaction_id: manual })).toBe("CONFLICT");
    expect((await service((query) => query(`select * from bank_match_candidates($1, $2, 'expense', 4250, 'USD', '2026-09-07', '2026-09-13')`, [orgA, usdA]))).rows).toHaveLength(0);
  });

  it("follows the bank only while the ledger row is untouched, and never overwrites a person's edit", async () => {
    const { connectionId, runId } = await importReady();
    let ext = await external(connectionId, "t-1");
    expect(await reconcile(orgA, ext.id, ext.revision, { kind: "IMPORT", ledger: importFields(usdA) }, runId)).toBe("APPLIED");
    const ledgerId = (await external(connectionId, "t-1")).ledger_transaction_id!;

    await ingest(orgA, runId, { before: "c1", after: "c2", transactions: [tx({ amount_decimal: "45", amount_minor: 4500 })] });
    ext = await external(connectionId, "t-1");
    expect(ext.revision).toBe(2);
    // A decision made on the old revision is refused.
    expect(await reconcile(orgA, ext.id, 1, { kind: "UPDATE_LEDGER", ledger: importFields(usdA, { amount_minor: 4500 }) })).toBe("STALE");
    expect(await reconcile(orgA, ext.id, 2, { kind: "UPDATE_LEDGER", ledger: importFields(usdA, { amount_minor: 4500 }) }, runId)).toBe("APPLIED");
    expect(await scalar(`select amount_minor from transactions where id = $1`, [ledgerId])).toBe(4500);

    await db.asUser(OWNER_A);
    await db.query(`update transactions set description = 'Team coffee' where id = $1`, [ledgerId]);
    await ingest(orgA, runId, { before: "c2", after: "c3", transactions: [tx({ amount_decimal: "46", amount_minor: 4600 })] });
    ext = await external(connectionId, "t-1");
    expect(await reconcile(orgA, ext.id, ext.revision, { kind: "UPDATE_LEDGER", ledger: importFields(usdA, { amount_minor: 4600 }) })).toBe("LEDGER_EDITED");
    expect(await db.asAdmin(async (query) => one<Record<string, unknown>>(await query(`select amount_minor, description from transactions where id = $1`, [ledgerId])))).toEqual({
      amount_minor: 4500,
      description: "Team coffee",
    });
    expect(await reconcile(orgA, ext.id, ext.revision, { kind: "SET_STATE", state: "NEEDS_REVIEW", review_reason: "PROVIDER_CHANGED_AFTER_EDIT" }, runId)).toBe("APPLIED");
    expect(await scalar(`select flagged_for_review from bank_sync_runs where id = $1`, [runId])).toBe(1);
  });

  it("keeps the bank's record when a person deletes the imported transaction, and does not import it again", async () => {
    const { connectionId } = await importReady();
    const ext = await external(connectionId, "t-1");
    expect(await reconcile(orgA, ext.id, ext.revision, { kind: "IMPORT", ledger: importFields(usdA) })).toBe("APPLIED");
    const ledgerId = (await external(connectionId, "t-1")).ledger_transaction_id!;

    await db.asUser(OWNER_A);
    await db.query(`delete from transactions where id = $1`, [ledgerId]);
    const after = await external(connectionId, "t-1");
    expect(after.ledger_transaction_id).toBeNull();
    expect(after.ledger_linked_at).not.toBeNull();
    expect(await reconcile(orgA, after.id, after.revision, { kind: "IMPORT", ledger: importFields(usdA) })).toBe("INVALID");
    expect(await reconcile(orgA, after.id, after.revision, { kind: "SET_STATE", state: "REMOVED_FROM_BOOKS" })).toBe("APPLIED");
  });

  it("keeps state values consistent", async () => {
    const { connectionId } = await importReady();
    const ext = await external(connectionId, "t-1");
    expect(await reconcile(orgA, ext.id, ext.revision, { kind: "SET_STATE", state: "IMPORTED" })).toBe("INVALID");
    expect(await reconcile(orgA, ext.id, ext.revision, { kind: "SET_STATE", state: "NEEDS_REVIEW" })).toBe("INVALID");
    expect(await reconcile(orgA, ext.id, ext.revision, { kind: "SET_STATE", state: "PENDING_SETTLEMENT" })).toBe("INVALID");
    expect(await reconcile(orgA, ext.id, ext.revision, { kind: "DELETE_EVERYTHING" })).toBe("INVALID");
  });
});

describe("webhook events", () => {
  const claim = (eventId: string, hash = "a".repeat(64)) =>
    service(async (query) =>
      one<{ event_id: string; claimed: boolean; status: string; payload_matches: boolean }>(
        await query(`select * from bank_claim_webhook_event('fixture', $1, 'TRANSACTIONS_UPDATED', 'TRANSACTIONS:SYNC_UPDATES_AVAILABLE', 'item-x', now(), $2, 120)`, [eventId, hash]),
      ),
    );
  const complete = (id: string, status: string, outcome: string | null) =>
    service(async (query) => one<{ r: string }>(await query(`select bank_complete_webhook_event($1, $2, $3, null, null, null) as r`, [id, status, outcome])).r);

  it("are claimed once however often they are delivered", async () => {
    const first = await claim("evt-1");
    expect(first).toMatchObject({ claimed: true, status: "PROCESSING" });
    const [second, third] = await Promise.all([claim("evt-1"), claim("evt-1")]);
    expect(second.claimed || third.claimed).toBe(false);
    expect(await complete(first.event_id, "PROCESSED", "SYNC_ENQUEUED")).toBe("APPLIED");
    expect(await claim("evt-1")).toMatchObject({ claimed: false, status: "PROCESSED" });
    expect(await scalar(`select count(*)::int from bank_webhook_events where provider_event_id = 'evt-1'`)).toBe(1);
    await expect(service((query) => query(`delete from bank_webhook_events`))).rejects.toThrow(/cannot be deleted/);
  });

  it("are retried after a failure only while attempts remain, and never with a different body", async () => {
    const first = await claim("evt-2");
    expect(await complete(first.event_id, "FAILED", null)).toBe("APPLIED");
    expect(await claim("evt-2", "b".repeat(64))).toMatchObject({ claimed: false, payload_matches: false });
    for (let attempt = 2; attempt <= 5; attempt++) {
      expect(await claim("evt-2")).toMatchObject({ claimed: true });
      await complete(first.event_id, "FAILED", null);
    }
    expect(await claim("evt-2")).toMatchObject({ claimed: false, status: "FAILED" });
    expect(await scalar(`select attempts from bank_webhook_events where id = $1`, [first.event_id])).toBe(5);
  });
});

describe("deletion", () => {
  it("removes every bank row with the organization, credentials included, and keeps webhook idempotency", async () => {
    const { connectionId } = await importReady();
    const ext = await external(connectionId, "t-1");
    expect(await reconcile(orgA, ext.id, ext.revision, { kind: "IMPORT", ledger: importFields(usdA) })).toBe("APPLIED");
    await service((query) => query(`insert into bank_connection_credentials (connection_id, organization_id, secret_ref) values ($1, $2, 'vault:5f0c7a52-9a57-4a55-9d0e-6a8c7a1f7d21')`, [connectionId, orgA]));
    const event = await service(async (query) =>
      one<{ event_id: string }>(await query(`select * from bank_claim_webhook_event('fixture', 'evt-org', 'CONNECTION_ERROR', 'ITEM:ERROR', 'item-x', now(), $1, 120)`, ["c".repeat(64)])),
    );
    await service((query) => query(`select bank_complete_webhook_event($1, 'IGNORED', 'NO_CHANGE', null, $2, $3)`, [event.event_id, orgA, connectionId]));

    await db.asAdmin((query) => query(`delete from organizations where id = $1`, [orgA]));

    for (const table of ["bank_connections", "bank_connection_credentials", "bank_linked_accounts", "bank_sync_jobs", "bank_sync_runs", "bank_external_transactions", "bank_transaction_revisions"]) {
      expect(await scalar(`select count(*)::int from ${table} where organization_id = $1`, [orgA]), table).toBe(0);
    }
    expect(await scalar(`select count(*)::int from bank_connection_credentials`)).toBe(0);
    expect(await db.asAdmin(async (query) => one(await query(`select organization_id, connection_id, status from bank_webhook_events where id = $1`, [event.event_id])))).toEqual({
      organization_id: null,
      connection_id: null,
      status: "IGNORED",
    });
    // Org B is untouched.
    expect(await scalar(`select count(*)::int from accounts where organization_id = $1`, [orgB])).toBe(1);
  });

  it("detaches a deleted user's attribution without deleting anything", async () => {
    const connectionId = await connection(orgA);
    const job = await service(async (query) => one<{ job_id: string }>(await query(`select * from bank_enqueue_sync_job($1, $2, 'MANUAL', 'by-employee', $3, null)`, [orgA, connectionId, EMPLOYEE_A])));
    const runId = await service(async (query) => one<{ r: string }>(await query(`select bank_claim_sync_job($1, $2, 600) as r`, [orgA, job.job_id])).r);
    await ingest(orgA, runId, { before: null, after: "c1", accounts: [externalAccount()], transactions: [tx()] });
    const linkedId = await linkedAccountId(connectionId);
    expect(await service(async (query) => one<{ r: string }>(await query(`select bank_link_account($1, $2, $3, 'IMPORT', $4) as r`, [orgA, linkedId, usdA, EMPLOYEE_A])).r)).toBe("APPLIED");
    const ext = await external(connectionId, "t-1");
    await service((query) => query(`select bank_reconcile_transaction($1, $2, $3, $4::jsonb, $5, $6, false)`, [orgA, ext.id, ext.revision, JSON.stringify({ kind: "IMPORT", ledger: importFields(usdA) }), runId, EMPLOYEE_A]));

    await db.asAdmin((query) => query(`delete from auth.users where id = $1`, [EMPLOYEE_A]));

    expect(await scalar(`select requested_by from bank_sync_jobs where id = $1`, [job.job_id])).toBeNull();
    expect(await scalar(`select linked_by from bank_linked_accounts where id = $1`, [linkedId])).toBeNull();
    expect(await scalar(`select count(*)::int from bank_transaction_revisions where actor_id is not null`)).toBe(0);
    expect(await scalar(`select count(*)::int from bank_external_transactions where connection_id = $1`, [connectionId])).toBe(1);
    expect(await scalar(`select account_id from bank_linked_accounts where id = $1`, [linkedId])).toBe(usdA);
  });
});
