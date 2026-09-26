import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";
import { FixtureBankProvider, MemorySecretStore } from "../fixtures/bank-provider-fixture";
import { createPgliteBankStore } from "../fixtures/bank-store-pglite";
import type { BankStore, ClaimedSyncJob } from "@/server/bank-connections/store";
import { completeBankLink, type ServiceDependencies } from "@/server/bank-connections/service";
import { executeClaimedSyncRun, runBankSyncJob, type SystemAuditEvent } from "@/server/bank-connections/sync";
import { runBankSyncScheduler, runBankSyncWorker } from "@/server/bank-connections/worker";
import { __resetObservabilitySinksForTests, registerObservabilitySink, type ReportedError } from "@/lib/observability";
import { SYNC_LEASE_SECONDS, retryDelaySeconds } from "@/domain/bank-connections/sync-job";

/**
 * THE WORKER, AGAINST REAL POSTGRES.
 *
 * Claiming (one job and many workers), lease ownership and the fence that
 * makes a lost lease harmless, retry classification and backoff, recovery from
 * a worker that stopped at each interesting point, organization isolation, and
 * the bounds that keep a claim from scanning a queue.
 *
 * Every assertion goes through the production modules and the real SQL
 * functions from migrations 0047–0049, with a deterministic TEST-ONLY
 * provider. No Plaid, and nothing here contacts any network.
 *
 * ONE HONEST LIMIT OF THIS HARNESS
 *
 * PGlite is a single-backend Postgres: statements from JavaScript are
 * serialized, so two claims cannot physically overlap inside it. What is
 * verified here is that the claim is ATOMIC and that its outcome is exclusive —
 * a job claimed once is never claimable again, and interleaved workers get
 * disjoint sets. FOR UPDATE SKIP LOCKED's behaviour under true contention is
 * Postgres's own, and is what makes the same code safe on more than one
 * connection; that part is not exercisable in-process and is stated as a
 * limitation rather than implied by a passing test.
 */

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKER_A = "workera-1111111111111111";
const WORKER_B = "workerb-2222222222222222";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

let db: TestDatabase;
let org: string;
let usd: string;
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

async function row<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await rows<T>(sql, params))[0];
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
 * Runs a connection's INITIAL job — which is how the provider's accounts reach
 * `bank_linked_accounts` — and links the checking account to a Countorra
 * account, so later imports reach the ledger.
 */
async function syncAndLink(connectionId: string, jobId: string, organizationId = org, accountId = usd): Promise<void> {
  const first = await runBankSyncJob(deps(), { organizationId, jobId });
  expect(first.kind).toBe("succeeded");
  const linkedAccountId = await scalar<string>(`select id from bank_linked_accounts where connection_id = $1`, [connectionId]);
  const outcome = await store.linkAccount({ organizationId, linkedAccountId, accountId, importMode: "IMPORT", actorId: OWNER });
  expect(outcome).toBe("APPLIED");
}

/** A fresh job for a connection that has already been linked. */
async function enqueue(connectionId: string, organizationId = org, reference = `t-${enqueueCounter++}`): Promise<string> {
  const enqueued = await store.enqueueJob({ organizationId, connectionId, trigger: "SCHEDULED", idempotencyKey: reference, requestedBy: null, webhookEventId: null });
  expect(enqueued.outcome).toBe("CREATED");
  return enqueued.jobId!;
}

let enqueueCounter = 0;

const job = (jobId: string) => row(`select * from bank_sync_jobs where id = $1`, [jobId]);
/**
 * Puts the engine's clock far enough back that the retry IT schedules
 * (`retryDelaySeconds(attempt)` after that clock) is already due. Nothing
 * updates `next_attempt_at` by hand: the guard refuses that, which is the
 * property being relied on here.
 */
const clockSoRetryIsDue = (attempt: number) => new Date(Date.now() - (retryDelaySeconds(attempt) + 60) * 1000);
const claim = (workerId: string, limit = 1) => store.claimNextJobs({ limit, leaseSeconds: SYNC_LEASE_SECONDS, workerId });
/** Makes a running job look abandoned, the way a killed process leaves it. */
const expireLease = (jobId: string) => scalar(`update bank_sync_jobs set lease_expires_at = now() - interval '1 minute' where id = $1 returning id`, [jobId]);

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin((query) => query(`insert into auth.users (id, email) values ($1, 'owner@example.test')`, [OWNER]));
  const created = await newOrganization("Synthetic");
  org = created.organizationId;
  usd = created.accountId;
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

describe("claiming a job", () => {
  it("gives one job to exactly one of two workers, and records who holds it", async () => {
    const { connectionId, initialJobId } = await connect();

    const first = await claim(WORKER_A);
    const second = await claim(WORKER_B);

    expect(first.map((claimed) => claimed.jobId)).toEqual([initialJobId]);
    expect(second).toEqual([]);
    expect(first[0]).toMatchObject({ organizationId: org, connectionId, trigger: "INITIAL", attempt: 1 });

    const row = await job(initialJobId);
    expect(row.status).toBe("RUNNING");
    expect(row.lease_owner).toBe(WORKER_A);
    expect(await scalar<number>(`select count(*)::int from bank_sync_runs where job_id = $1`, [initialJobId])).toBe(1);
  });

  it("hands ten workers many jobs without giving one job to two of them", async () => {
    const connections: string[] = [];
    for (let index = 0; index < 10; index++) {
      const { connectionId } = await connect(org, `public-many-${index}`);
      connections.push(connectionId);
    }
    const queued = await scalar<number>(`select count(*)::int from bank_sync_jobs where status = 'QUEUED'`);
    expect(queued).toBe(10);

    // Ten worker identities, taking turns — the interleaving a batch of
    // concurrent invocations produces, with each claim atomic in the database.
    const taken: ClaimedSyncJob[] = [];
    for (let round = 0; round < 3; round++) {
      for (let worker = 0; worker < 10; worker++) {
        taken.push(...(await claim(`worker${worker}-${"0".repeat(10)}${worker}`, 1)));
      }
    }

    const ids = taken.map((claimed) => claimed.jobId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(10);
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where status = 'RUNNING'`)).toBe(10);
    // Each running job has exactly one run row, and one owner.
    expect(await scalar<number>(`select count(*)::int from bank_sync_runs`)).toBe(10);
    expect(await scalar<number>(`select count(distinct lease_owner)::int from bank_sync_jobs where status = 'RUNNING'`)).toBe(10);
  }, 60_000);

  it("returns disjoint batches to successive claims", async () => {
    for (let index = 0; index < 8; index++) await connect(org, `public-batch-${index}`);

    const first = await claim(WORKER_A, 5);
    const second = await claim(WORKER_B, 5);

    expect(first).toHaveLength(5);
    expect(second).toHaveLength(3);
    const overlap = first.filter((a) => second.some((b) => b.jobId === a.jobId));
    expect(overlap).toEqual([]);
    expect(await claim("workerc-3333333333333333", 5)).toEqual([]);
  }, 60_000);

  it("never re-executes a finished job", async () => {
    const { initialJobId } = await connect();
    provider.add(provider.transaction({ providerTransactionId: "coffee" }));

    const worked = await runBankSyncWorker(deps(), { workerId: WORKER_A, maxJobs: 5 });
    expect(worked).toMatchObject({ executed: 1, succeeded: 1, stoppedBecause: "queue_empty" });
    expect((await job(initialJobId)).status).toBe("SUCCEEDED");

    expect(await claim(WORKER_B)).toEqual([]);
    const again = await runBankSyncWorker(deps(), { workerId: WORKER_B, maxJobs: 5 });
    expect(again).toMatchObject({ executed: 0 });
    expect(await scalar<number>(`select count(*)::int from bank_sync_runs where job_id = $1`, [initialJobId])).toBe(1);
  });

  it("passes over a retry that is not due yet, and takes it once it is", async () => {
    const { initialJobId } = await connect();
    provider.failNext.push("PROVIDER_UNAVAILABLE");

    // This run's clock is now, so the retry it schedules is a minute away.
    const failed = await runBankSyncWorker(deps(), { workerId: WORKER_A, maxJobs: 1 });
    expect(failed).toMatchObject({ executed: 1, retrying: 1 });
    const retryable = await job(initialJobId);
    expect(retryable.status).toBe("RETRYABLE");
    expect(retryable.failure_category).toBe("PROVIDER_UNAVAILABLE");
    expect(new Date(String(retryable.next_attempt_at)).getTime()).toBeGreaterThan(Date.now());

    // Not due, so no worker takes it.
    expect(await claim(WORKER_B)).toEqual([]);
    const tooSoon = await runBankSyncWorker(deps(), { workerId: WORKER_B, maxJobs: 1 });
    expect(tooSoon).toMatchObject({ executed: 0, stoppedBecause: "queue_empty" });

    // A second connection, whose failing run happened long enough ago that its
    // retry is already due, IS claimed — and the claim is what moves it
    // RETRYABLE -> QUEUED -> RUNNING, as a second attempt.
    const due = await connect(org, "public-due");
    clock = clockSoRetryIsDue(1);
    provider.failNext.push("PROVIDER_TIMEOUT");
    expect(await runBankSyncWorker(deps(), { workerId: WORKER_A, maxJobs: 1 })).toMatchObject({ executed: 1, retrying: 1 });
    expect((await job(due.initialJobId)).status).toBe("RETRYABLE");

    provider.failNext.push("PROVIDER_TIMEOUT");
    const secondAttempt = await runBankSyncWorker(deps(), { workerId: WORKER_B, maxJobs: 1 });
    expect(secondAttempt).toMatchObject({ executed: 1, retrying: 1 });
    expect((await job(due.initialJobId)).attempts).toBe(2);
    // The first job, still waiting out its backoff, was left alone.
    expect((await job(initialJobId)).attempts).toBe(1);
  });

  it("takes a continuation job as soon as it exists", async () => {
    const { initialJobId } = await connect();
    // More than one page of backlog, so one run cannot finish it.
    for (let index = 0; index < 700; index++) provider.add(provider.transaction({ providerTransactionId: `page-${index}` }));

    // One page per run, so the first run leaves a continuation behind.
    const first = await runBankSyncWorker(deps({ maxPages: 1 }), { workerId: WORKER_A, maxJobs: 1 });
    expect(first.executed).toBe(1);
    void initialJobId;

    const continuation = await row(`select * from bank_sync_jobs where trigger = 'CONTINUATION'`);
    expect(continuation.status).toBe("QUEUED");
    expect(continuation.next_attempt_at).toBeNull();
    const claimed = await claim(WORKER_B);
    expect(claimed.map((entry) => entry.jobId)).toEqual([continuation.id]);
  });

  it("cancels, rather than runs, a job whose connection was disconnected while it waited", async () => {
    const { connectionId, initialJobId } = await connect();
    await scalar(`select bank_finalize_disconnect($1, $2, null)`, [org, connectionId]);
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("DISCONNECTED");

    expect(await claim(WORKER_A)).toEqual([]);
    expect((await job(initialJobId)).status).toBe("CANCELLED");
  });

  it("refuses a claim that names no worker, and an out-of-range batch", async () => {
    await expect(scalar(`select * from bank_claim_next_sync_jobs(1, 600, null)`)).rejects.toThrow(/worker identity is required/);
    await expect(scalar(`select * from bank_claim_next_sync_jobs(0, 600, $1)`, [WORKER_A])).rejects.toThrow(/limit must be between/);
    await expect(scalar(`select * from bank_claim_next_sync_jobs(101, 600, $1)`, [WORKER_A])).rejects.toThrow(/limit must be between/);
    await expect(scalar(`select bank__claim_sync_job($1, $2, 600, 'short')`, [org, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"])).rejects.toThrow(/worker identity is 8 to 64/);
  });
});

describe("leases", () => {
  it("extends a lease its owner still holds", async () => {
    const { initialJobId } = await connect();
    const [claimed] = await claim(WORKER_A);
    const before = await scalar<string>(`select lease_expires_at from bank_sync_jobs where id = $1`, [initialJobId]);

    await scalar(`update bank_sync_jobs set lease_expires_at = now() + interval '5 seconds' where id = $1 returning id`, [initialJobId]);
    const beat = await store.heartbeatRun({ organizationId: org, runId: claimed.runId, workerId: WORKER_A, leaseSeconds: SYNC_LEASE_SECONDS });

    expect(beat).toBe("EXTENDED");
    const after = await scalar<string>(`select lease_expires_at from bank_sync_jobs where id = $1`, [initialJobId]);
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime() - 60_000);
    expect(new Date(after).getTime()).toBeGreaterThan(Date.now() + 500_000);
  });

  it("tells a worker its lease is gone rather than letting it carry on", async () => {
    const { initialJobId } = await connect();
    const [claimed] = await claim(WORKER_A);

    // Another worker's identity on the same run.
    expect(await store.heartbeatRun({ organizationId: org, runId: claimed.runId, workerId: WORKER_B, leaseSeconds: 600 })).toBe("LOST");
    // The right worker, after the lease ran out.
    await expireLease(initialJobId);
    expect(await store.heartbeatRun({ organizationId: org, runId: claimed.runId, workerId: WORKER_A, leaseSeconds: 600 })).toBe("LOST");
    // Another organization asking about this run learns nothing.
    const other = await newOrganization("Elsewhere");
    expect(await store.heartbeatRun({ organizationId: other.organizationId, runId: claimed.runId, workerId: WORKER_A, leaseSeconds: 600 })).toBe("NOT_FOUND");
  });

  it("refuses to renew an expired lease, in the database itself", async () => {
    const { initialJobId } = await connect();
    await claim(WORKER_A);
    await expireLease(initialJobId);

    await expect(scalar(`update bank_sync_jobs set lease_expires_at = now() + interval '10 minutes' where id = $1 returning id`, [initialJobId])).rejects.toThrow(/lease has expired/);
    // Ingesting a page renews the lease, so the same rule stops a page being
    // committed by a worker that no longer owns the job.
    expect((await job(initialJobId)).status).toBe("RUNNING");
  });

  it("clears the lease and its owner when the job stops running", async () => {
    const { initialJobId } = await connect();
    const [claimed] = await claim(WORKER_A);
    await store.completeRun({ organizationId: org, runId: claimed.runId, outcome: "SUCCEEDED", failureCategory: null, nextAttemptAt: null, countsAgainstConnection: false, durationMs: 5 });

    const row = await job(initialJobId);
    expect(row.status).toBe("SUCCEEDED");
    expect(row.lease_expires_at).toBeNull();
    expect(row.lease_owner).toBeNull();
  });

  it("recovers a job whose worker stopped, and refuses that worker's later writes", async () => {
    const { connectionId, initialJobId } = await connect();
    await syncAndLink(connectionId, initialJobId);
    provider.add(provider.transaction({ providerTransactionId: "coffee" }));
    const jobId = await enqueue(connectionId);

    // Worker A claims and then "crashes" — nothing completes its run.
    const [abandoned] = await claim(WORKER_A);
    expect(abandoned.jobId).toBe(jobId);
    await expireLease(jobId);

    // A sweep puts the job back in line. The run it was on is failed, and the
    // failure is LEASE_EXPIRED, which never counts against the connection.
    expect(await store.reclaimExpiredLeases(50)).toBe(1);
    const afterSweep = await job(jobId);
    expect(afterSweep.status).toBe("RETRYABLE");
    expect(afterSweep.failure_category).toBe("LEASE_EXPIRED");
    expect(afterSweep.lease_owner).toBeNull();
    expect(await scalar(`select status from bank_sync_runs where id = $1`, [abandoned.runId])).toBe("FAILED");
    expect(await scalar(`select consecutive_failed_runs from bank_connections where id = $1`, [connectionId])).toBe(0);

    // Worker B takes it (the retry is due immediately) and finishes it.
    const [taken] = await claim(WORKER_B);
    expect(taken.jobId).toBe(jobId);
    expect(taken.attempt).toBe(2);
    const outcome = await executeClaimedSyncRun(deps(), { organizationId: org, jobId: taken.jobId, runId: taken.runId, workerId: WORKER_B });
    expect(outcome).toMatchObject({ kind: "succeeded" });

    // Worker A, coming back to life, cannot write anything: its run is no
    // longer the job's attempt, so the fence rejects it.
    expect(await store.heartbeatRun({ organizationId: org, runId: abandoned.runId, workerId: WORKER_A, leaseSeconds: 600 })).toBe("LOST");
    const stale = await executeClaimedSyncRun(deps(), { organizationId: org, jobId, runId: abandoned.runId, workerId: WORKER_A });
    expect(stale.kind).toBe("abandoned");

    // One import, not two.
    expect(await scalar<number>(`select count(*)::int from transactions where organization_id = $1 and source = 'bank_sync'`, [org])).toBe(1);
    expect(await scalar<number>(`select count(*)::int from bank_external_transactions`)).toBe(1);
  });

  it("makes no provider call at all once its run has been taken away", async () => {
    const { connectionId, initialJobId } = await connect();
    await syncAndLink(connectionId, initialJobId);
    provider.add(provider.transaction({ providerTransactionId: "never-fetched" }));
    const jobId = await enqueue(connectionId);

    const [claimed] = await claim(WORKER_A);
    await expireLease(jobId);
    await store.reclaimExpiredLeases(10);
    provider.calls.fetch = 0;

    // The job is RETRYABLE now, not RUNNING: this worker stops before asking
    // the bank anything, rather than fetching a page it could not commit.
    const outcome = await executeClaimedSyncRun(deps(), { organizationId: org, jobId, runId: claimed.runId, workerId: WORKER_A });

    expect(outcome).toEqual({ kind: "abandoned", jobId, runId: claimed.runId });
    expect(provider.calls.fetch).toBe(0);
    expect(await scalar<number>(`select count(*)::int from bank_external_transactions`)).toBe(0);
  }, 60_000);

  it("stops retrying a job once its attempts are spent", async () => {
    const { initialJobId } = await connect();

    // max_attempts is immutable, so the attempts are spent the honest way.
    for (let attempt = 1; attempt <= 5; attempt++) {
      clock = clockSoRetryIsDue(attempt);
      provider.failNext.push("PROVIDER_UNAVAILABLE");
      const run = await runBankSyncWorker(deps(), { workerId: WORKER_A, maxJobs: 1 });
      expect(run.executed).toBe(1);
    }
    const exhausted = await job(initialJobId);
    expect(exhausted.status).toBe("FAILED");
    expect(exhausted.attempts).toBe(5);
    expect(await claim(WORKER_B)).toEqual([]);
  }, 60_000);
});

describe("retries", () => {
  it("retries a provider outage with a doubling backoff, five times at most", async () => {
    const { initialJobId } = await connect();
    const delays: number[] = [];

    for (let attempt = 1; attempt <= 5; attempt++) {
      clock = clockSoRetryIsDue(attempt);
      provider.failNext.push("PROVIDER_UNAVAILABLE");
      const run = await runBankSyncWorker(deps(), { workerId: WORKER_A, maxJobs: 1 });
      expect(run.executed).toBe(1);
      const current = await job(initialJobId);
      expect(current.attempts).toBe(attempt);
      if (attempt < 5) {
        expect(current.status).toBe("RETRYABLE");
        delays.push(Math.round((new Date(String(current.next_attempt_at)).getTime() - clock.getTime()) / 1000));
      } else {
        expect(current.status).toBe("FAILED");
      }
    }

    // 60s doubling. Compared with a second of tolerance because the stored
    // timestamp's sub-second part does not survive the round trip, not because
    // the backoff is approximate.
    for (const [index, delay] of delays.entries()) {
      const expected = [60, 120, 240, 480][index];
      expect(delay).toBeGreaterThan(expected - 2);
      expect(delay).toBeLessThanOrEqual(expected);
    }
    expect(delays).toHaveLength(4);
    expect(await scalar<number>(`select count(*)::int from bank_sync_runs where job_id = $1`, [initialJobId])).toBe(5);
    expect(await claim(WORKER_B)).toEqual([]);
  }, 60_000);

  it("does not retry what a retry cannot fix", async () => {
    for (const category of ["REAUTH_REQUIRED", "CONNECTION_REVOKED", "MALFORMED_PROVIDER_RESPONSE", "CREDENTIAL_UNAVAILABLE"] as const) {
      const { connectionId, initialJobId } = await connect(org, `public-${category}`);
      if (category === "MALFORMED_PROVIDER_RESPONSE") provider.malformedNext = true;
      else if (category === "CREDENTIAL_UNAVAILABLE") {
        const ref = await scalar<string>(`select secret_ref from bank_connection_credentials where connection_id = $1`, [connectionId]);
        secrets.secrets.delete(ref);
      } else provider.failNext.push(category);

      const run = await runBankSyncWorker(deps(), { workerId: WORKER_A, maxJobs: 1 });
      expect(run).toMatchObject({ executed: 1, failed: 1, retrying: 0 });
      const row = await job(initialJobId);
      expect([row.status, row.failure_category, row.attempts]).toEqual(["FAILED", category, 1]);
    }
  }, 60_000);

  it("spreads a rate-limited provider out instead of hammering it", async () => {
    const { initialJobId } = await connect();
    provider.failNext.push("PROVIDER_RATE_LIMITED");

    const run = await runBankSyncWorker(deps(), { workerId: WORKER_A, maxJobs: 5 });

    expect(run).toMatchObject({ executed: 1, retrying: 1, stoppedBecause: "queue_empty" });
    const row = await job(initialJobId);
    expect(row.status).toBe("RETRYABLE");
    expect(new Date(String(row.next_attempt_at)).getTime()).toBeGreaterThan(Date.now() + 30_000);
    // The worker did not immediately try again inside the same invocation.
    expect(provider.calls.fetch).toBe(1);
    expect(await claim(WORKER_B)).toEqual([]);
  });

  it("counts a bank's failure against the connection, and its own against nothing", async () => {
    const { connectionId, initialJobId } = await connect();
    provider.failNext.push("PROVIDER_UNAVAILABLE");
    clock = clockSoRetryIsDue(1);
    await runBankSyncWorker(deps(), { workerId: WORKER_A, maxJobs: 1 });
    expect(await scalar(`select consecutive_failed_runs from bank_connections where id = $1`, [connectionId])).toBe(1);
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("DEGRADED");

    const [claimed] = await claim(WORKER_B);
    expect(claimed.jobId).toBe(initialJobId);
    await expireLease(initialJobId);
    expect(await store.reclaimExpiredLeases(10)).toBe(1);
    // A lease this deployment lost is not the bank's fault: the counter and the
    // connection's status are left where the provider's own failure put them.
    expect(await scalar(`select consecutive_failed_runs from bank_connections where id = $1`, [connectionId])).toBe(1);
    expect(await scalar(`select status from bank_connections where id = $1`, [connectionId])).toBe("DEGRADED");
  });
});

describe("a worker that stops part-way", () => {
  it("loses no cursor progress and imports nothing twice, whichever point it stopped at", async () => {
    const { connectionId, initialJobId } = await connect();
    await syncAndLink(connectionId, initialJobId);
    const cursorAtLink = await scalar<string>(`select page_cursor from bank_connections where id = $1`, [connectionId]);
    provider.add(
      provider.transaction({ providerTransactionId: "one" }),
      provider.transaction({ providerTransactionId: "two", amount: "12.00" }),
      provider.transaction({ providerTransactionId: "three", amount: "99.00" }),
    );

    // STOPPED AFTER THE CLAIM, before any provider call. Nothing is fetched,
    // nothing is written, and the cursor has not moved.
    const jobId = await enqueue(connectionId);
    provider.calls.fetch = 0;
    await claim(WORKER_A);
    await expireLease(jobId);
    expect(await store.reclaimExpiredLeases(10)).toBe(1);
    expect(provider.calls.fetch).toBe(0);
    expect(await scalar<number>(`select count(*)::int from bank_external_transactions`)).toBe(0);
    expect(await scalar(`select page_cursor from bank_connections where id = $1`, [connectionId])).toBe(cursorAtLink);

    // STOPPED AFTER THE PROVIDER ANSWERED, before the page was committed. The
    // page and the cursor move in ONE database transaction, so there is nothing
    // to half-apply: the same page is simply fetched again.
    const secretRef = await scalar<string>(`select secret_ref from bank_connection_credentials where connection_id = $1`, [connectionId]);
    const secret = (await secrets.get(secretRef))!;
    await provider.fetchTransactions({ secret, cursor: cursorAtLink, pageSize: 500 });
    expect(provider.calls.fetch).toBe(1);
    expect(await scalar<number>(`select count(*)::int from bank_external_transactions`)).toBe(0);
    expect(await scalar(`select page_cursor from bank_connections where id = $1`, [connectionId])).toBe(cursorAtLink);

    const [retry] = await claim(WORKER_B);
    expect(retry.jobId).toBe(jobId);
    const finished = await executeClaimedSyncRun(deps(), { organizationId: org, jobId: retry.jobId, runId: retry.runId, workerId: WORKER_B });
    expect(finished).toMatchObject({ kind: "succeeded", counts: { added: 3, imported: 3 } });
    const cursorAfter = await scalar<string>(`select page_cursor from bank_connections where id = $1`, [connectionId]);
    expect(cursorAfter).not.toBe(cursorAtLink);

    // STOPPED AFTER THE LEDGER AND CURSOR COMMIT. A new job resumes from the
    // committed cursor and finds nothing new — no second copy of anything.
    const replayJobId = await enqueue(connectionId, org, "after-cursor");
    const [replay] = await claim(WORKER_A);
    expect(replay.jobId).toBe(replayJobId);
    const replayed = await executeClaimedSyncRun(deps(), { organizationId: org, jobId: replay.jobId, runId: replay.runId, workerId: WORKER_A });
    expect(replayed).toMatchObject({ kind: "succeeded", counts: { added: 0, imported: 0 } });

    expect(await scalar<number>(`select count(*)::int from transactions where organization_id = $1 and source = 'bank_sync'`, [org])).toBe(3);
    expect(await scalar<number>(`select count(*)::int from bank_external_transactions`)).toBe(3);
    expect(await scalar(`select page_cursor from bank_connections where id = $1`, [connectionId])).toBe(cursorAfter);
  }, 60_000);

  it("leaves no permanently RUNNING job behind", async () => {
    const connections: string[] = [];
    for (let index = 0; index < 3; index++) {
      const { connectionId, initialJobId } = await connect(org, `public-stuck-${index}`);
      connections.push(connectionId);
      await claim(`stuckwork-${index}${"0".repeat(10)}`);
      await expireLease(initialJobId);
    }
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where status = 'RUNNING'`)).toBe(3);

    expect(await store.reclaimExpiredLeases(100)).toBe(3);

    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where status = 'RUNNING'`)).toBe(0);
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where status = 'RETRYABLE'`)).toBe(3);
    // A second sweep finds nothing, and never touches a job whose lease is
    // alive.
    expect(await store.reclaimExpiredLeases(100)).toBe(0);
    await connect(org, "public-healthy");
    await claim(WORKER_A);
    expect(await store.reclaimExpiredLeases(100)).toBe(0);
    expect(await scalar(`select lease_owner from bank_sync_jobs where lease_expires_at > now()`)).toBe(WORKER_A);
  }, 60_000);

  it("creates no duplicate continuation when a run is repeated", async () => {
    const { connectionId, initialJobId } = await connect();
    for (let index = 0; index < 700; index++) provider.add(provider.transaction({ providerTransactionId: `dup-${index}` }));

    await runBankSyncWorker(deps({ maxPages: 1 }), { workerId: WORKER_A, maxJobs: 1 });
    const firstContinuations = await rows<{ id: string }>(`select id from bank_sync_jobs where trigger = 'CONTINUATION'`);
    expect(firstContinuations).toHaveLength(1);

    // The same job's continuation is keyed on that job, so asking again is a
    // duplicate rather than a second job.
    const repeated = await store.enqueueJob({
      organizationId: org,
      connectionId,
      trigger: "CONTINUATION",
      idempotencyKey: `${connectionId}|CONTINUATION|${initialJobId}`,
      requestedBy: null,
      webhookEventId: null,
    });
    expect(repeated).toEqual({ jobId: firstContinuations[0].id, outcome: "DUPLICATE" });
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where trigger = 'CONTINUATION'`)).toBe(1);
  });
});

describe("organizations stay separate", () => {
  it("runs each claimed job only against its own organization", async () => {
    const other = await newOrganization("Second workspace");
    const mine = await connect(org, "public-mine");
    const theirs = await connect(other.organizationId, "public-theirs");
    await syncAndLink(mine.connectionId, mine.initialJobId);
    await syncAndLink(theirs.connectionId, theirs.initialJobId, other.organizationId, other.accountId);
    provider.add(provider.transaction({ providerTransactionId: "shared-coffee" }));
    await enqueue(mine.connectionId, org, "mine-1");
    await enqueue(theirs.connectionId, other.organizationId, "theirs-1");

    const worked = await runBankSyncWorker(deps(), { workerId: WORKER_A, maxJobs: 10 });
    expect(worked).toMatchObject({ executed: 2, succeeded: 2 });

    // Each workspace's ledger holds its own import of the same provider
    // transaction, and every bank row names the organization of the connection
    // that produced it.
    for (const organizationId of [org, other.organizationId]) {
      expect(await scalar<number>(`select count(*)::int from transactions where organization_id = $1 and source = 'bank_sync'`, [organizationId])).toBe(1);
    }
    expect(await scalar<number>(`select count(*)::int from bank_external_transactions e join bank_connections c on c.id = e.connection_id where e.organization_id <> c.organization_id`)).toBe(0);
    expect(await scalar<number>(`select count(*)::int from bank_sync_runs r join bank_sync_jobs j on j.id = r.job_id where r.organization_id <> j.organization_id`)).toBe(0);
    expect(await scalar<number>(`select count(*)::int from transactions t join bank_external_transactions e on e.ledger_transaction_id = t.id where t.organization_id <> e.organization_id`)).toBe(0);
  }, 90_000);

  it("cannot be asked to run one organization's job as another", async () => {
    const other = await newOrganization("Third workspace");
    const mine = await connect(org, "public-only-mine");

    expect(await store.getJob(other.organizationId, mine.initialJobId)).toBeNull();
    expect(await store.claimJob(other.organizationId, mine.initialJobId, SYNC_LEASE_SECONDS)).toBeNull();
    const outcome = await executeClaimedSyncRun(deps(), { organizationId: other.organizationId, jobId: mine.initialJobId, runId: mine.initialJobId, workerId: WORKER_A });
    expect(outcome).toEqual({ kind: "not_found" });
    expect((await job(mine.initialJobId)).status).toBe("QUEUED");
  });
});

describe("bounds", () => {
  it("stops at its job budget and leaves the rest queued", async () => {
    for (let index = 0; index < 8; index++) await connect(org, `public-budget-${index}`);

    const worked = await runBankSyncWorker(deps(), { workerId: WORKER_A, maxJobs: 3 });

    expect(worked).toMatchObject({ executed: 3, stoppedBecause: "job_limit" });
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where status = 'QUEUED'`)).toBe(5);
  }, 60_000);

  it("stops at its deadline", async () => {
    for (let index = 0; index < 4; index++) await connect(org, `public-clock-${index}`);
    let ticks = 0;
    // A clock that jumps a minute per read: the first job runs, the second
    // finds the deadline passed.
    const monotonic = () => (ticks++ === 0 ? 0 : 60_000);

    const worked = await runBankSyncWorker(deps(), { workerId: WORKER_A, maxJobs: 10, maxDurationMs: 30_000, monotonic });

    expect(worked.stoppedBecause).toBe("time_limit");
    expect(worked.executed).toBeLessThanOrEqual(1);
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where status = 'QUEUED'`)).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it("claims nothing at all when this deployment has no provider", async () => {
    await connect();
    const worked = await runBankSyncWorker(deps({ providers: [] }), { workerId: WORKER_A });

    expect(worked).toMatchObject({ providerConfigured: false, executed: 0, claimed: 0 });
    // No attempt was spent, so nothing is closer to failing for good.
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where status = 'QUEUED' and attempts = 0`)).toBe(1);
  });

  it("reads a large queue through its index, not by scanning it", async () => {
    // A thousand queued jobs, one per connection (the one-active-job rule).
    await db.asAdmin(async (query) => {
      await query("set role service_role");
      try {
        await query(
          `insert into bank_connections (organization_id, provider, provider_connection_id)
           select $1, 'fixture', 'item-bulk-' || g from generate_series(1, 1000) g`,
          [org],
        );
        await query(
          `insert into bank_sync_jobs (organization_id, connection_id, trigger, idempotency_key)
           select $1, c.id, 'SCHEDULED', 'bulk-' || c.provider_connection_id from bank_connections c
            where c.organization_id = $1 and c.provider_connection_id like 'item-bulk-%'`,
          [org],
        );
      } finally {
        await query("reset role");
      }
    });
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where status = 'QUEUED'`)).toBe(1000);

    // The claim's candidate query can be answered from the partial index — if
    // it could not, forbidding a sequential scan would still produce one.
    const plan = await db.asAdmin(async (query) => {
      await query("set enable_seqscan = off");
      const explained = await query(
        `explain select j.id from bank_sync_jobs j where j.status in ('QUEUED', 'RETRYABLE') and (j.next_attempt_at is null or j.next_attempt_at <= now())
         order by coalesce(j.next_attempt_at, j.created_at), j.id limit 5`,
      );
      await query("set enable_seqscan = on");
      return (explained.rows as { "QUERY PLAN": string }[]).map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("bank_sync_jobs_claimable_idx");
    expect(plan).not.toContain("Seq Scan");

    const started = Date.now();
    const claimed = await claim(WORKER_A, 5);
    const elapsed = Date.now() - started;
    expect(claimed).toHaveLength(5);
    expect(elapsed).toBeLessThan(5_000);
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where status = 'RUNNING'`)).toBe(5);
  }, 120_000);
});

describe("inside a serverless time limit", () => {
  it("stops starting provider pages at its deadline, and leaves the rest to a continuation", async () => {
    const { connectionId, initialJobId } = await connect();
    // More than one page of backlog.
    for (let index = 0; index < 700; index++) provider.add(provider.transaction({ providerTransactionId: `deadline-${index}` }));
    const [claimed] = await claim(WORKER_A);

    // A deadline already passed: the first page still runs (the job must make
    // progress), the second is never started.
    const outcome = await executeClaimedSyncRun(deps({ deadline: Date.now() - 1 }), { organizationId: org, jobId: claimed.jobId, runId: claimed.runId, workerId: WORKER_A });

    expect(outcome).toMatchObject({ kind: "succeeded", hasMore: true, counts: { pages: 1, added: 500 } });
    expect(provider.calls.fetch).toBe(1);
    expect((await job(initialJobId)).status).toBe("SUCCEEDED");
    const continuation = await row(`select status, trigger from bank_sync_jobs where connection_id = $1 and trigger = 'CONTINUATION'`, [connectionId]);
    expect(continuation).toMatchObject({ status: "QUEUED", trigger: "CONTINUATION" });

    // The next invocation picks up exactly where it stopped: nothing skipped,
    // nothing twice.
    const rest = await runBankSyncWorker(deps(), { workerId: WORKER_B, maxJobs: 5 });
    expect(rest).toMatchObject({ executed: 1, succeeded: 1 });
    expect(await scalar<number>(`select count(*)::int from bank_external_transactions`)).toBe(700);
  }, 90_000);

  it("passes the route's page deadline through to every job it runs", async () => {
    await connect(org, "public-deadline-a");
    for (let index = 0; index < 700; index++) provider.add(provider.transaction({ providerTransactionId: `pass-${index}` }));

    const worked = await runBankSyncWorker(deps(), { workerId: WORKER_A, maxJobs: 1, pageDeadline: Date.now() - 1 });

    expect(worked).toMatchObject({ executed: 1, succeeded: 1, continuations: 1 });
    expect(await scalar<number>(`select max(pages_fetched)::int from bank_sync_runs`)).toBe(1);
  }, 90_000);

  it("changes nothing when no deadline is given — the inline refresh path", async () => {
    await connect(org, "public-no-deadline");
    for (let index = 0; index < 700; index++) provider.add(provider.transaction({ providerTransactionId: `free-${index}` }));

    const worked = await runBankSyncWorker(deps(), { workerId: WORKER_A, maxJobs: 1 });

    expect(worked).toMatchObject({ executed: 1, succeeded: 1, continuations: 0 });
    expect(await scalar<number>(`select max(pages_fetched)::int from bank_sync_runs`)).toBe(2);
  }, 90_000);
});

describe("queue health", () => {
  let events: ReportedError[];

  beforeEach(() => {
    events = [];
    registerObservabilitySink({ name: "test", capture: (record) => void events.push(record) });
  });

  afterEach(() => {
    __resetObservabilitySinksForTests();
  });

  it("reads an empty queue as empty", async () => {
    expect(await store.queueHealth()).toEqual({ dueJobs: 0, oldestDueAgeSeconds: null, runningPastLease: 0 });
  });

  it("counts claimable work and how long it has waited, and nothing that is not claimable", async () => {
    const { initialJobId } = await connect();
    await connect(org, "public-health-2");

    const fresh = await store.queueHealth();
    expect(fresh.dueJobs).toBe(2);
    expect(fresh.oldestDueAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(fresh.oldestDueAgeSeconds).toBeLessThan(60);
    expect(fresh.runningPastLease).toBe(0);

    // A retry scheduled for later is not claimable, so it is not "due".
    provider.failNext.push("PROVIDER_UNAVAILABLE");
    await runBankSyncWorker(deps(), { workerId: WORKER_A, maxJobs: 1 });
    expect((await job(initialJobId)).status).toBe("RETRYABLE");
    expect((await store.queueHealth()).dueJobs).toBe(1);
  });

  it("sees a running job that has outlived its lease", async () => {
    const { initialJobId } = await connect();
    await claim(WORKER_A);
    await expireLease(initialJobId);

    expect(await store.queueHealth()).toMatchObject({ dueJobs: 0, runningPastLease: 1 });
  });

  it("makes the scheduler warn when due work has waited too long — the cron has stopped or cannot keep up", async () => {
    const { connectionId } = await connect();
    await scalar(`update bank_sync_jobs set status = 'CANCELLED', completed_at = now() where connection_id = $1 returning id`, [connectionId]);
    // A job that became due two hours ago, as a stalled scheduler leaves it.
    await db.asAdmin(async (query) => {
      await query("set role service_role");
      try {
        await query(`insert into bank_sync_jobs (organization_id, connection_id, trigger, idempotency_key, created_at) values ($1, $2, 'SCHEDULED', 'stalled', now() - interval '2 hours')`, [org, connectionId]);
      } finally {
        await query("reset role");
      }
    });

    const summary = await runBankSyncScheduler(deps());

    expect(summary.queue).toMatchObject({ dueJobs: 1, runningPastLease: 0 });
    expect(summary.queue!.oldestDueAgeSeconds!).toBeGreaterThan(7_000);
    const backlog = events.filter((event) => event.errorName === "bank.worker_backlog");
    expect(backlog).toHaveLength(1);
    expect(backlog[0]).toMatchObject({ severity: "warning", detail: { dueJobs: 1, runningPastLease: 0 } });
    // The routine summary carries the numbers too, at info.
    expect(events.find((event) => event.errorName === "bank.scheduler_finished")?.detail).toMatchObject({ dueJobs: 1 });
  });

  it("stays quiet about a healthy queue", async () => {
    await connect();
    const summary = await runBankSyncScheduler(deps());

    expect(summary.queue?.dueJobs).toBe(1);
    expect(events.filter((event) => event.errorName === "bank.worker_backlog")).toHaveLength(0);
  });
});

describe("a connection from another environment, seen by the worker", () => {
  /**
   * The worker serves every organization in one invocation, so the question is
   * not only "is the mismatched connection refused" but "does refusing it cost
   * anything else". A guard that wedged the queue, or that stopped the
   * invocation before the healthy connections were worked, would trade one
   * problem for a worse one.
   */

  it("counts the mismatched connection as failed and finishes the invocation", async () => {
    provider.environment = "sandbox";
    const { connectionId, initialJobId } = await connect();
    await syncAndLink(connectionId, initialJobId);
    await enqueue(connectionId);

    provider.environment = "production";
    const fetches = provider.calls.fetch;

    const worked = await runBankSyncWorker(deps(), { maxDurationMs: 10_000 });

    expect(worked.executed).toBe(1);
    expect(worked.failed).toBe(1);
    expect(worked.succeeded).toBe(0);
    // Refused before the provider, even inside the worker.
    expect(provider.calls.fetch).toBe(fetches);
  });

  it("does not wedge the queue: the job finishes and nothing stays leased", async () => {
    provider.environment = "sandbox";
    const { connectionId, initialJobId } = await connect();
    await syncAndLink(connectionId, initialJobId);
    const jobId = await enqueue(connectionId);

    provider.environment = "production";
    await runBankSyncWorker(deps(), { maxDurationMs: 10_000 });

    const finished = await job(jobId);
    // Terminal, lease released, nothing left for a reclaim sweep to find.
    expect(["FAILED", "RETRYABLE"]).toContain(finished.status);
    expect(finished.lease_expires_at).toBeNull();
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where status = 'RUNNING'`)).toBe(0);
    expect(await store.reclaimExpiredLeases(10)).toBe(0);

    // And a second invocation is not stuck on it either.
    const again = await runBankSyncWorker(deps(), { maxDurationMs: 10_000 });
    expect(again.abandoned).toBe(0);
  });

  it("still works a matching connection in the same invocation", async () => {
    // The mismatched one must not starve the healthy one. Two organizations,
    // because a connection's environment is fixed at link time — so the only
    // way to have one of each is to link them under different runtimes.
    provider.environment = "sandbox";
    const stale = await connect(org, "public-stale");
    await syncAndLink(stale.connectionId, stale.initialJobId);
    await enqueue(stale.connectionId);

    const second = await newOrganization("Healthy Workspace");
    provider.environment = "production";
    const healthy = await connect(second.organizationId, "public-healthy");
    await syncAndLink(healthy.connectionId, healthy.initialJobId, second.organizationId, second.accountId);
    provider.add(provider.transaction({ providerTransactionId: "healthy-1", amount: "25.00" }));
    await enqueue(healthy.connectionId, second.organizationId);

    const worked = await runBankSyncWorker(deps(), { maxDurationMs: 20_000 });

    expect(worked.executed).toBe(2);
    expect(worked.succeeded).toBe(1);
    expect(worked.failed).toBe(1);
    // The healthy workspace's import landed.
    expect(await scalar<number>(`select count(*)::int from bank_external_transactions where provider_transaction_id = $1`, ["healthy-1"])).toBe(1);
    // The stale one imported nothing.
    expect(await scalar<number>(`select count(*)::int from bank_external_transactions where connection_id = $1 and provider_transaction_id = $2`, [stale.connectionId, "healthy-1"])).toBe(0);
  });

  it("is not scheduled into an endless retry loop", async () => {
    provider.environment = "sandbox";
    const { connectionId, initialJobId } = await connect();
    await syncAndLink(connectionId, initialJobId);
    await enqueue(connectionId);
    provider.environment = "production";

    for (let attempt = 0; attempt < 6; attempt++) {
      await runBankSyncWorker(deps({ now: () => clockSoRetryIsDue(attempt + 1) }), { maxDurationMs: 10_000 });
    }

    // Whatever the retry policy decides, it terminates and the provider is
    // never called.
    expect(await scalar<number>(`select count(*)::int from bank_sync_jobs where connection_id = $1 and status in ('QUEUED', 'RUNNING')`, [connectionId])).toBe(0);
    expect(provider.calls.fetch).toBe(1); // the INITIAL sync, before the switch
  });
});
