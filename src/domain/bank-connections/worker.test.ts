import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PROVIDER_CALL_TIMEOUT_MS } from "./provider";
import { MAX_SYNC_ATTEMPTS, SYNC_LEASE_SECONDS } from "./sync-job";
import {
  InvalidWorkerIdentityError,
  SCHEDULER_MAX_CONNECTIONS_PER_RUN,
  SCHEDULER_SYNC_INTERVAL_SECONDS,
  WORKER_BACKLOG_WARNING_SECONDS,
  WORKER_CLAIM_BATCH_SIZE,
  WORKER_COMPLETION_MARGIN_MS,
  WORKER_ROUTE_MAX_DURATION_SECONDS,
  WORKER_LEASE_SECONDS,
  WORKER_MAX_ATTEMPTS,
  WORKER_MAX_DURATION_MS,
  WORKER_MAX_JOBS_PER_INVOCATION,
  isQueueUnhealthy,
  isWorkerIdentity,
  nextWorkerStep,
  scheduledSyncIdempotencyKey,
  scheduledSyncReference,
  workerIdentity,
  workerStartBudgetMs,
} from "./worker";

/** The worker's policy, on its own: no database, no provider, no clock. */

describe("when a worker stops", () => {
  const bounds = { maxJobs: 10, maxDurationMs: 50_000 };
  const progress = (overrides: Partial<{ jobsExecuted: number; lastBatchSize: number; elapsedMs: number }> = {}) => ({
    jobsExecuted: 0,
    lastBatchSize: 1,
    elapsedMs: 0,
    ...overrides,
  });

  it("claims at the start of an invocation", () => {
    expect(nextWorkerStep(progress(), bounds)).toEqual({ kind: "claim", limit: WORKER_CLAIM_BATCH_SIZE });
  });

  it("stops at its job budget, whatever is still queued", () => {
    expect(nextWorkerStep(progress({ jobsExecuted: 10, lastBatchSize: 1 }), bounds)).toEqual({ kind: "stop", reason: "job_limit" });
    expect(nextWorkerStep(progress({ jobsExecuted: 11 }), bounds)).toEqual({ kind: "stop", reason: "job_limit" });
  });

  it("stops at its deadline, before claiming work it cannot finish", () => {
    expect(nextWorkerStep(progress({ elapsedMs: 50_000 }), bounds)).toEqual({ kind: "stop", reason: "time_limit" });
    expect(nextWorkerStep(progress({ jobsExecuted: 3, elapsedMs: 120_000 }), bounds)).toEqual({ kind: "stop", reason: "time_limit" });
  });

  it("stops when the queue had nothing due", () => {
    expect(nextWorkerStep(progress({ jobsExecuted: 2, lastBatchSize: 0 }), bounds)).toEqual({ kind: "stop", reason: "queue_empty" });
  });

  it("never claims more than the job budget that is left", () => {
    expect(nextWorkerStep(progress({ jobsExecuted: 9 }), { maxJobs: 10, maxDurationMs: 50_000 })).toEqual({ kind: "claim", limit: 1 });
    expect(nextWorkerStep(progress(), { maxJobs: 1, maxDurationMs: 50_000 })).toEqual({ kind: "claim", limit: 1 });
  });

  it("is bounded three ways at once, so one wrong bound is not a loop without an end", () => {
    // Whatever the state, the answer is either "claim a bounded batch" or
    // "stop" — there is no third possibility.
    for (const jobsExecuted of [0, 5, 10, 99]) {
      for (const lastBatchSize of [0, 1, 5]) {
        for (const elapsedMs of [0, 49_999, 50_000, 10 ** 7]) {
          const step = nextWorkerStep({ jobsExecuted, lastBatchSize, elapsedMs }, bounds);
          if (step.kind === "claim") expect(step.limit).toBeGreaterThan(0);
          else expect(["queue_empty", "job_limit", "time_limit"]).toContain(step.reason);
        }
      }
    }
  });
});

describe("a worker's identity", () => {
  it("is unique per execution and safe to log", () => {
    const first = workerIdentity({ unique: "0123456789abcdef0123456789abcdef" });
    const second = workerIdentity({ unique: "fedcba9876543210fedcba9876543210" });
    expect(first).not.toBe(second);
    expect(isWorkerIdentity(first)).toBe(true);
    expect(first).toMatch(/^worker-[0-9a-f]+$/);
  });

  it("keeps a prefix a deployment chose, within the characters the column allows", () => {
    expect(workerIdentity({ prefix: "vercel-cron!", unique: "abcdefgh" })).toBe("vercelcron-abcdefgh");
    expect(workerIdentity({ prefix: "", unique: "abcdefgh" })).toBe("worker-abcdefgh");
  });

  it("refuses an identity too short to be unique", () => {
    expect(() => workerIdentity({ unique: "" })).toThrow(InvalidWorkerIdentityError);
    expect(isWorkerIdentity("short")).toBe(false);
    expect(isWorkerIdentity(`worker-${"x".repeat(80)}`)).toBe(false);
    // The pattern is the one migration 0049 enforces on bank_sync_jobs.lease_owner.
    expect(isWorkerIdentity("worker with spaces")).toBe(false);
  });
});

describe("scheduling a periodic sync", () => {
  it("keys a window rather than an instant, so a repeated invocation is one job", () => {
    // Windows are six hours wide, counted from the epoch, so two invocations
    // inside one window share a key and the next window has its own.
    const at = new Date("2026-09-17T07:00:00Z");
    const sameWindow = new Date("2026-09-17T11:59:59Z");
    const nextWindow = new Date("2026-09-17T12:00:01Z");

    expect(scheduledSyncReference(at)).toBe(scheduledSyncReference(new Date(at.getTime() + 1000)));
    expect(scheduledSyncReference(at)).toBe(scheduledSyncReference(sameWindow));
    expect(scheduledSyncReference(at)).not.toBe(scheduledSyncReference(nextWindow));
  });

  it("builds the same idempotency key the sync job table is keyed on", () => {
    const connectionId = "11111111-1111-4111-8111-111111111111";
    const at = new Date("2026-09-17T08:00:00Z");
    expect(scheduledSyncIdempotencyKey(connectionId, at)).toBe(`${connectionId}|SCHEDULED|${scheduledSyncReference(at)}`);
    expect(scheduledSyncIdempotencyKey(connectionId, at).length).toBeLessThanOrEqual(300);
  });

  it("refuses an interval so short it would become a busy loop", () => {
    const at = new Date("2026-09-17T08:00:00Z");
    expect(scheduledSyncReference(at, 1)).toBe(scheduledSyncReference(at, 60));
    expect(scheduledSyncReference(at, 0)).toBe(scheduledSyncReference(at, 60));
  });
});

describe("the bounds themselves", () => {
  it("keeps Task 11's retry limit and lease", () => {
    expect(WORKER_MAX_ATTEMPTS).toBe(MAX_SYNC_ATTEMPTS);
    expect(WORKER_MAX_ATTEMPTS).toBe(5);
    expect(WORKER_LEASE_SECONDS).toBe(SYNC_LEASE_SECONDS);
    expect(WORKER_LEASE_SECONDS).toBe(600);
  });

  it("claims one job at a time, so no lease is held on work this invocation will not run", () => {
    expect(WORKER_CLAIM_BATCH_SIZE).toBe(1);
  });

  it("fits inside a sixty-second scheduled function, and asks a bank no more than four times a day", () => {
    expect(WORKER_MAX_DURATION_MS).toBeLessThan(60_000);
    expect(WORKER_MAX_JOBS_PER_INVOCATION).toBeGreaterThan(0);
    expect(SCHEDULER_SYNC_INTERVAL_SECONDS).toBe(6 * 60 * 60);
    expect(SCHEDULER_MAX_CONNECTIONS_PER_RUN).toBeLessThanOrEqual(500);
  });
});

describe("the serverless time budget", () => {
  it("leaves room for the slowest provider call and the commit after it", () => {
    const budget = workerStartBudgetMs({ functionLimitMs: WORKER_ROUTE_MAX_DURATION_SECONDS * 1000 });
    expect(budget).toBe(30_000);
    // A page started at the very last allowed moment, at the provider's own
    // timeout, plus the completion margin, still ends inside the limit.
    expect(budget + PROVIDER_CALL_TIMEOUT_MS + WORKER_COMPLETION_MARGIN_MS).toBeLessThanOrEqual(WORKER_ROUTE_MAX_DURATION_SECONDS * 1000);
  });

  it("is never negative, however small the limit", () => {
    expect(workerStartBudgetMs({ functionLimitMs: 10_000 })).toBe(0);
    expect(workerStartBudgetMs({ functionLimitMs: 300_000 })).toBe(270_000);
  });

  it("matches the limit the route actually declares", () => {
    const route = readFileSync(path.resolve(process.cwd(), "src/app/api/bank-connections/worker/route.ts"), "utf8");
    // Next reads route segment config statically, so it must be a literal —
    // and it must be the number this budget was computed from.
    expect(route).toMatch(new RegExp(`export const maxDuration = ${WORKER_ROUTE_MAX_DURATION_SECONDS};`));
  });
});

describe("what counts as an unhealthy queue", () => {
  it("is quiet while work is recent", () => {
    expect(isQueueUnhealthy({ dueJobs: 0, oldestDueAgeSeconds: null, runningPastLease: 0 })).toBe(false);
    expect(isQueueUnhealthy({ dueJobs: 40, oldestDueAgeSeconds: 120, runningPastLease: 0 })).toBe(false);
  });

  it("speaks up when due work has waited too long — a stopped or overwhelmed cron", () => {
    expect(isQueueUnhealthy({ dueJobs: 1, oldestDueAgeSeconds: WORKER_BACKLOG_WARNING_SECONDS + 1, runningPastLease: 0 })).toBe(true);
  });

  it("speaks up when a running job has outlived its lease — a killed worker", () => {
    expect(isQueueUnhealthy({ dueJobs: 0, oldestDueAgeSeconds: null, runningPastLease: 1 })).toBe(true);
  });
});
