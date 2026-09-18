import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";
import { FixtureBankProvider, MemorySecretStore } from "../fixtures/bank-provider-fixture";
import { createPgliteBankStore } from "../fixtures/bank-store-pglite";
import type { BankStore } from "@/server/bank-connections/store";
import { completeBankLink, type ServiceDependencies } from "@/server/bank-connections/service";
import { runBankSyncJob, type SystemAuditEvent } from "@/server/bank-connections/sync";
import { ingestBankWebhook } from "@/server/bank-connections/webhooks";
import { runBankSyncScheduler, runBankSyncWorker } from "@/server/bank-connections/worker";
import { SCHEDULER_SYNC_INTERVAL_SECONDS, scheduledSyncReference } from "@/domain/bank-connections/worker";

/**
 * THE SCHEDULER, AND THE WHOLE PATH IT FEEDS, AGAINST REAL POSTGRES.
 *
 * Which connections a periodic sync is due for, what running the scheduler
 * twice does, a backlog that needs several continuation jobs drained by the
 * worker alone, and the webhook → job → worker → ledger path end to end.
 *
 * The provider is the TEST-ONLY fixture. Nothing here contacts a network, and
 * no Plaid code is involved.
 */

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKER = "workers-1111111111111111";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

let db: TestDatabase;
let org: string;
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

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return db.asAdmin(async (query) => (await query(sql, params)).rows as T[]);
}

async function newOrganization(name: string): Promise<{ organizationId: string; accountId: string }> {
  await db.asUser(OWNER);
  const organizationId = ((await db.query(`insert into organizations (name, entity_type, created_by) values ($1, 'personal', $2) returning id`, [name, OWNER])).rows[0] as { id: string }).id;
  const accountId = await scalar<string>(`insert into accounts (organization_id, name, kind, currency) values ($1, 'Checking', 'bank', 'USD') returning id`, [organizationId]);
  return { organizationId, accountId };
}

async function connect(organizationId = org, publicToken = "public-1"): Promise<{ connectionId: string; initialJobId: string }> {
  const outcome = await completeBankLink(deps(), { organizationId, userId: OWNER, providerId: "fixture", publicToken });
  if (outcome.kind !== "connected") throw new Error(`link failed: ${outcome.kind}`);
  return { connectionId: outcome.connectionId, initialJobId: outcome.jobId! };
}

/**
 * Runs the INITIAL job — which is how the provider's accounts reach
 * `bank_linked_accounts` — and links the bank account to a Countorra account
 * of its own, so later imports reach the ledger.
 */
let accountCounter = 0;
async function syncAndLink(connectionId: string, jobId: string, organizationId = org, accountId?: string): Promise<void> {
  expect((await runBankSyncJob(deps(), { organizationId, jobId })).kind).toBe("succeeded");
  const target = accountId ?? (await scalar<string>(`insert into accounts (organization_id, name, kind, currency) values ($1, $2, 'bank', 'USD') returning id`, [organizationId, `Checking ${accountCounter++}`]));
  const linkedAccountId = await scalar<string>(`select id from bank_linked_accounts where connection_id = $1`, [connectionId]);
  expect(await store.linkAccount({ organizationId, linkedAccountId, accountId: target, importMode: "IMPORT", actorId: OWNER })).toBe("APPLIED");
}

/** Makes a connection look untouched for longer than the sync interval. */
const lastAttemptedHoursAgo = (connectionId: string, hours: number) =>
  scalar(`update bank_connections set last_sync_attempt_at = now() - make_interval(hours => $2) where id = $1 returning id`, [connectionId, hours]);

const setStatus = (connectionId: string, status: string, reason: string) =>
  scalar(`update bank_connections set status = $2, status_reason = $3 where id = $1 returning id`, [connectionId, status, reason]);

const jobsFor = (connectionId: string) => rows<{ trigger: string; status: string; idempotency_key: string }>(`select trigger, status, idempotency_key from bank_sync_jobs where connection_id = $1 order by created_at`, [connectionId]);

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin((query) => query(`insert into auth.users (id, email) values ($1, 'owner@example.test')`, [OWNER]));
  org = (await newOrganization("Synthetic")).organizationId;
  provider = new FixtureBankProvider();
  provider.account();
  secrets = new MemorySecretStore();
  store = createPgliteBankStore(db);
  audits = [];
  clock = new Date();
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await db?.close();
});

describe("what the scheduler queues", () => {
  it("queues one scheduled sync for a working connection that has not been synced lately", async () => {
    const { connectionId, initialJobId } = await connect();
    await syncAndLink(connectionId, initialJobId);
    await lastAttemptedHoursAgo(connectionId, 7);

    const summary = await runBankSyncScheduler(deps());

    expect(summary).toMatchObject({ connectionsConsidered: 1, jobsCreated: 1, alreadyActive: 0, duplicates: 0, skipped: 0, reclaimedLeases: 0 });
    const jobs = await jobsFor(connectionId);
    expect(jobs.map((job) => job.trigger)).toEqual(["INITIAL", "SCHEDULED"]);
    expect(jobs[1].status).toBe("QUEUED");
    expect(jobs[1].idempotency_key).toBe(`${connectionId}|SCHEDULED|${scheduledSyncReference(clock)}`);
  });

  it("creates nothing extra when it runs again in the same window", async () => {
    const { connectionId, initialJobId } = await connect();
    await syncAndLink(connectionId, initialJobId);
    await lastAttemptedHoursAgo(connectionId, 7);

    const first = await runBankSyncScheduler(deps());
    const second = await runBankSyncScheduler(deps());
    const third = await runBankSyncScheduler(deps());

    expect(first.jobsCreated).toBe(1);
    // The job it created is still active, so the connection is not even
    // considered again — the one-active-job rule, doing its job.
    expect(second).toMatchObject({ connectionsConsidered: 0, jobsCreated: 0 });
    expect(third).toMatchObject({ connectionsConsidered: 0, jobsCreated: 0 });
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where trigger = 'SCHEDULED'`)).toBe(1);
  });

  it("refuses a second scheduled job in the same window even after the first has finished", async () => {
    const { connectionId, initialJobId } = await connect();
    await syncAndLink(connectionId, initialJobId);
    await lastAttemptedHoursAgo(connectionId, 7);

    expect((await runBankSyncScheduler(deps())).jobsCreated).toBe(1);
    await runBankSyncWorker(deps(), { workerId: WORKER, maxJobs: 5 });
    expect(await scalar(`select status from bank_sync_jobs where trigger = 'SCHEDULED'`)).toBe("SUCCEEDED");

    // Its window key is taken, so the same window cannot queue a second sync
    // however often the scheduler is invoked.
    await lastAttemptedHoursAgo(connectionId, 7);
    const again = await runBankSyncScheduler(deps());
    expect(again).toMatchObject({ connectionsConsidered: 1, jobsCreated: 0, duplicates: 1 });
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where trigger = 'SCHEDULED'`)).toBe(1);

    // The next window is a different key, so imports carry on.
    clock = new Date(clock.getTime() + SCHEDULER_SYNC_INTERVAL_SECONDS * 1000);
    const nextWindow = await runBankSyncScheduler(deps());
    expect(nextWindow.jobsCreated).toBe(1);
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where trigger = 'SCHEDULED'`)).toBe(2);
  }, 60_000);

  it("leaves alone every connection a scheduled sync would be wrong for", async () => {
    const cases: { status: string; reason: string; connectionId: string }[] = [];
    for (const [index, [status, reason]] of [
      ["ACTIVE", "SYNC_SUCCEEDED"],
      ["DEGRADED", "SYNC_FAILED"],
      ["REQUIRES_REAUTH", "PROVIDER_REPORTED_REAUTH"],
      ["ERROR", "PROVIDER_REPORTED_ERROR"],
    ].entries()) {
      const { connectionId, initialJobId } = await connect(org, `public-status-${index}`);
      await syncAndLink(connectionId, initialJobId);
      await setStatus(connectionId, status, reason);
      await lastAttemptedHoursAgo(connectionId, 9);
      cases.push({ status, reason, connectionId });
    }
    // One still being set up — a link that was started and never finished, so
    // it never became ACTIVE — and one already gone.
    await scalar(
      `insert into bank_connections (organization_id, provider, provider_connection_id, created_at) values ($1, 'fixture', 'item-half-linked', now() - interval '9 hours') returning id`,
      [org],
    );
    const gone = await connect(org, "public-gone");
    await syncAndLink(gone.connectionId, gone.initialJobId);
    await scalar(`select bank_finalize_disconnect($1, $2, null)`, [org, gone.connectionId]);

    const summary = await runBankSyncScheduler(deps());

    // ACTIVE and DEGRADED only. A connection waiting for a person, stopped,
    // still being linked, or disconnected is never queued by a schedule.
    expect(summary).toMatchObject({ connectionsConsidered: 2, jobsCreated: 2 });
    const scheduled = await rows<{ connection_id: string }>(`select connection_id from bank_sync_jobs where trigger = 'SCHEDULED'`);
    expect(new Set(scheduled.map((job) => job.connection_id))).toEqual(new Set([cases[0].connectionId, cases[1].connectionId]));
  }, 120_000);

  it("waits out the interval instead of asking a bank again straight away", async () => {
    const { connectionId, initialJobId } = await connect();
    await syncAndLink(connectionId, initialJobId);
    // The link's own sync attempt was moments ago.
    expect((await runBankSyncScheduler(deps())).jobsCreated).toBe(0);

    await lastAttemptedHoursAgo(connectionId, 5);
    expect((await runBankSyncScheduler(deps())).jobsCreated).toBe(0);

    await lastAttemptedHoursAgo(connectionId, 7);
    expect((await runBankSyncScheduler(deps())).jobsCreated).toBe(1);
  });

  it("stays within the connections it was told to consider", async () => {
    for (let index = 0; index < 6; index++) {
      const { connectionId, initialJobId } = await connect(org, `public-bounded-${index}`);
      await syncAndLink(connectionId, initialJobId);
      await lastAttemptedHoursAgo(connectionId, 10 + index);
    }

    const summary = await runBankSyncScheduler(deps(), { maxConnections: 2 });

    expect(summary).toMatchObject({ connectionsConsidered: 2, jobsCreated: 2 });
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where trigger = 'SCHEDULED'`)).toBe(2);
    // Oldest attempt first, so nothing is starved by a busier connection.
    const queued = await rows<{ id: string }>(
      `select c.id from bank_connections c join bank_sync_jobs j on j.connection_id = c.id and j.trigger = 'SCHEDULED' order by c.last_sync_attempt_at`,
    );
    const oldest = await rows<{ id: string }>(`select id from bank_connections order by last_sync_attempt_at limit 2`);
    expect(queued.map((row) => row.id)).toEqual(oldest.map((row) => row.id));
  }, 120_000);

  it("puts an abandoned job back in line before it queues anything new", async () => {
    const { connectionId, initialJobId } = await connect();
    await syncAndLink(connectionId, initialJobId);
    const other = await connect(org, "public-second");
    await syncAndLink(other.connectionId, other.initialJobId);
    await lastAttemptedHoursAgo(connectionId, 8);
    await lastAttemptedHoursAgo(other.connectionId, 8);

    // One connection's job is claimed and abandoned with an expired lease.
    const scheduled = await runBankSyncScheduler(deps());
    expect(scheduled.jobsCreated).toBe(2);
    const [claimed] = await store.claimNextJobs({ limit: 1, leaseSeconds: 600, workerId: WORKER });
    await scalar(`update bank_sync_jobs set lease_expires_at = now() - interval '1 minute' where id = $1 returning id`, [claimed.jobId]);

    const recovery = await runBankSyncScheduler(deps());

    expect(recovery.reclaimedLeases).toBe(1);
    expect(await scalar(`select status from bank_sync_jobs where id = $1`, [claimed.jobId])).toBe("RETRYABLE");
    // And the recovered job is picked up and finished by the next worker.
    const worked = await runBankSyncWorker(deps(), { workerId: "workerz-9999999999999999", maxJobs: 5 });
    expect(worked.executed).toBe(2);
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where status in ('QUEUED', 'RUNNING', 'RETRYABLE')`)).toBe(0);
  }, 120_000);

  it("queues nothing, but still recovers abandoned work, when no provider is configured", async () => {
    const { connectionId, initialJobId } = await connect();
    await syncAndLink(connectionId, initialJobId);
    await lastAttemptedHoursAgo(connectionId, 8);
    const jobId = (await store.enqueueJob({ organizationId: org, connectionId, trigger: "MANUAL", idempotencyKey: "abandoned", requestedBy: null, webhookEventId: null })).jobId!;
    await store.claimNextJobs({ limit: 1, leaseSeconds: 600, workerId: WORKER });
    await scalar(`update bank_sync_jobs set lease_expires_at = now() - interval '1 minute' where id = $1 returning id`, [jobId]);

    const summary = await runBankSyncScheduler(deps({ providers: [] }));

    expect(summary).toMatchObject({ reclaimedLeases: 1, connectionsConsidered: 0, jobsCreated: 0 });
    expect(await scalar(`select status from bank_sync_jobs where id = $1`, [jobId])).toBe("RETRYABLE");
  });

  it("keeps each workspace's scheduled work in its own organization", async () => {
    const other = await newOrganization("Second workspace");
    const mine = await connect(org, "public-mine");
    const theirs = await connect(other.organizationId, "public-theirs");
    await syncAndLink(mine.connectionId, mine.initialJobId);
    await syncAndLink(theirs.connectionId, theirs.initialJobId, other.organizationId, other.accountId);
    await lastAttemptedHoursAgo(mine.connectionId, 8);
    await lastAttemptedHoursAgo(theirs.connectionId, 8);

    const summary = await runBankSyncScheduler(deps());

    expect(summary).toMatchObject({ connectionsConsidered: 2, jobsCreated: 2 });
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs j join bank_connections c on c.id = j.connection_id where j.organization_id <> c.organization_id`)).toBe(0);
    for (const organizationId of [org, other.organizationId]) {
      expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where organization_id = $1 and trigger = 'SCHEDULED'`, [organizationId])).toBe(1);
    }
  }, 90_000);
});

describe("the worker finishes a backlog by itself", () => {
  it("drains a multi-page backlog through continuation jobs, with every page applied exactly once", async () => {
    const { connectionId, initialJobId } = await connect();
    // Link first, so everything imported afterwards reaches the ledger.
    provider.add(provider.transaction({ providerTransactionId: "first" }));
    await syncAndLink(connectionId, initialJobId);

    const total = 1_600;
    for (let index = 0; index < total; index++) {
      provider.add(provider.transaction({ providerTransactionId: `bulk-${index}`, amount: `${(index % 89) + 1}.00`, transactionDate: `2026-0${(index % 8) + 1}-1${index % 9}` }));
    }
    // The scheduler starts it; one page per run, so only continuation jobs can
    // finish the backlog.
    await lastAttemptedHoursAgo(connectionId, 8);
    expect((await runBankSyncScheduler(deps())).jobsCreated).toBe(1);

    const worked = await runBankSyncWorker(deps({ maxPages: 1 }), { workerId: WORKER, maxJobs: 25 });

    expect(worked.stoppedBecause).toBe("queue_empty");
    expect(worked.executed).toBeGreaterThanOrEqual(3);
    expect(worked.succeeded).toBe(worked.executed);
    expect(worked.continuations).toBe(worked.executed - 1);
    expect(await scalar<number>(`select count(*)::int from bank_external_transactions`)).toBe(total + 1);
    expect(await scalar<number>(`select count(*)::int from transactions where organization_id = $1 and source = 'bank_sync'`, [org])).toBe(total + 1);
    // No page was applied twice: one ledger row per external transaction.
    expect(await scalar<number>(`select count(*)::int from (select ledger_transaction_id from bank_external_transactions where ledger_transaction_id is not null group by 1 having count(*) > 1) d`)).toBe(0);
    // No run exceeded its page bound, and nothing is left queued.
    expect(await scalar<number>(`select max(pages_fetched)::int from bank_sync_runs`)).toBe(1);
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where status in ('QUEUED', 'RUNNING', 'RETRYABLE')`)).toBe(0);

    // Running the worker again imports nothing: the cursor is where it should
    // be and ingestion is idempotent.
    const idle = await runBankSyncWorker(deps(), { workerId: WORKER, maxJobs: 5 });
    expect(idle).toMatchObject({ executed: 0 });
    await lastAttemptedHoursAgo(connectionId, 8);
    // A later window, so this is a new scheduled sync rather than a duplicate.
    clock = new Date(clock.getTime() + SCHEDULER_SYNC_INTERVAL_SECONDS * 1000);
    expect((await runBankSyncScheduler(deps())).jobsCreated).toBe(1);
    const repeat = await runBankSyncWorker(deps(), { workerId: WORKER, maxJobs: 5 });
    expect(repeat).toMatchObject({ executed: 1, succeeded: 1, continuations: 0 });
    expect(await scalar<number>(`select count(*)::int from transactions where organization_id = $1 and source = 'bank_sync'`, [org])).toBe(total + 1);
  }, 300_000);

  it("stops mid-backlog at its job budget and resumes exactly where it left off", async () => {
    const { connectionId, initialJobId } = await connect();
    await syncAndLink(connectionId, initialJobId);
    for (let index = 0; index < 1_200; index++) provider.add(provider.transaction({ providerTransactionId: `part-${index}` }));
    await lastAttemptedHoursAgo(connectionId, 8);
    expect((await runBankSyncScheduler(deps())).jobsCreated).toBe(1);

    const first = await runBankSyncWorker(deps({ maxPages: 1 }), { workerId: WORKER, maxJobs: 1 });
    expect(first).toMatchObject({ executed: 1, stoppedBecause: "job_limit", continuations: 1 });
    const ingestedFirst = await scalar<number>(`select count(*)::int from bank_external_transactions`);
    expect(ingestedFirst).toBeLessThan(1_200);
    expect(ingestedFirst).toBeGreaterThan(0);

    const rest = await runBankSyncWorker(deps({ maxPages: 1 }), { workerId: "workerb-2222222222222222", maxJobs: 25 });
    expect(rest.stoppedBecause).toBe("queue_empty");
    expect(await scalar<number>(`select count(*)::int from bank_external_transactions`)).toBe(1_200);
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where status in ('QUEUED', 'RUNNING', 'RETRYABLE')`)).toBe(0);
  }, 300_000);
});

describe("a webhook reaches the ledger only through the worker", () => {
  const webhook = (overrides: Record<string, unknown>) => {
    const rawBody = JSON.stringify({
      providerEventId: "evt-1",
      providerEventType: "TRANSACTIONS:SYNC_UPDATES_AVAILABLE",
      type: "TRANSACTIONS_UPDATED",
      occurredAt: new Date().toISOString(),
      ...overrides,
    });
    const timestamp = Math.floor(clock.getTime() / 1000);
    return { rawBody, headers: { "x-fixture-timestamp": String(timestamp), "x-fixture-signature": provider.sign(rawBody, timestamp) } };
  };

  it("enqueues a job that the worker then runs, and imports the transaction once", async () => {
    const { connectionId, initialJobId } = await connect();
    await syncAndLink(connectionId, initialJobId);
    provider.add(provider.transaction({ providerTransactionId: "webhook-coffee" }));
    const providerConnectionId = await scalar<string>(`select provider_connection_id from bank_connections where id = $1`, [connectionId]);

    const { rawBody, headers } = webhook({ providerConnectionId });
    const response = await ingestBankWebhook(deps(), { providerId: "fixture", rawBody, headers });

    // The webhook wrote no financial row: it queued work and returned.
    expect(response).toEqual({ status: 200, body: { received: true } });
    expect(await scalar(`select outcome from bank_webhook_events order by received_at desc limit 1`)).toBe("SYNC_ENQUEUED");
    expect(await scalar<number>(`select count(*)::int from transactions where organization_id = $1 and source = 'bank_sync'`, [org])).toBe(0);
    expect(await scalar(`select status from bank_sync_jobs where trigger = 'WEBHOOK'`)).toBe("QUEUED");
    expect(provider.calls.fetch).toBe(1);

    const worked = await runBankSyncWorker(deps(), { workerId: WORKER, maxJobs: 5 });

    expect(worked).toMatchObject({ executed: 1, succeeded: 1 });
    expect(await scalar<number>(`select count(*)::int from transactions where organization_id = $1 and source = 'bank_sync'`, [org])).toBe(1);
    expect(await scalar(`select status from bank_sync_jobs where trigger = 'WEBHOOK'`)).toBe("SUCCEEDED");
  }, 60_000);

  it("does the work once however often the provider redelivers the event", async () => {
    const { connectionId, initialJobId } = await connect();
    await syncAndLink(connectionId, initialJobId);
    provider.add(provider.transaction({ providerTransactionId: "redelivered" }));
    const providerConnectionId = await scalar<string>(`select provider_connection_id from bank_connections where id = $1`, [connectionId]);
    const { rawBody, headers } = webhook({ providerConnectionId, providerEventId: "evt-same" });

    const first = await ingestBankWebhook(deps(), { providerId: "fixture", rawBody, headers });
    const second = await ingestBankWebhook(deps(), { providerId: "fixture", rawBody, headers });
    const third = await ingestBankWebhook(deps(), { providerId: "fixture", rawBody, headers });

    expect(first.body).toEqual({ received: true });
    expect(second.body).toEqual({ received: true, duplicate: true });
    expect(third.body).toEqual({ received: true, duplicate: true });
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where trigger = 'WEBHOOK'`)).toBe(1);

    const worked = await runBankSyncWorker(deps(), { workerId: WORKER, maxJobs: 10 });
    expect(worked).toMatchObject({ executed: 1, succeeded: 1 });
    expect(await scalar<number>(`select count(*)::int from transactions where organization_id = $1 and source = 'bank_sync'`, [org])).toBe(1);
    expect(await scalar<number>(`select count(*)::int from bank_external_transactions`)).toBe(1);
  }, 60_000);
});
