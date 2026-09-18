import { describe, expect, it } from "vitest";
import { SYNC_FAILURE_CATEGORIES, SYNC_JOB_STATUSES } from "./types";
import {
  MANUAL_SYNC_MIN_INTERVAL_SECONDS,
  MAX_SYNC_ATTEMPTS,
  SYNC_JOB_TRANSITIONS,
  InvalidSyncJobTransitionError,
  assertSyncJobTransition,
  decideSyncFailure,
  decideSyncRequest,
  isRetryableSyncFailure,
  isTerminalSyncJobStatus,
  jobRunnability,
  manualSyncReference,
  retryDelaySeconds,
  syncIdempotencyKey,
} from "./sync-job";

const NOW = new Date("2026-09-15T12:00:00Z");
const CONNECTION = "c0000000-0000-4000-8000-000000000001";

describe("sync job transitions", () => {
  it("defines every status, with three terminal ones", () => {
    expect(Object.keys(SYNC_JOB_TRANSITIONS).sort()).toEqual([...SYNC_JOB_STATUSES].sort());
    expect(SYNC_JOB_STATUSES.filter(isTerminalSyncJobStatus)).toEqual(["SUCCEEDED", "FAILED", "CANCELLED"]);
  });

  it("rejects skipping RUNNING and resurrecting finished jobs", () => {
    expect(() => assertSyncJobTransition("QUEUED", "SUCCEEDED")).toThrow(InvalidSyncJobTransitionError);
    expect(() => assertSyncJobTransition("SUCCEEDED", "QUEUED")).toThrow(InvalidSyncJobTransitionError);
    expect(() => assertSyncJobTransition("FAILED", "QUEUED")).toThrow(InvalidSyncJobTransitionError);
    expect(() => assertSyncJobTransition("RETRYABLE", "QUEUED")).not.toThrow();
  });
});

describe("retries are bounded", () => {
  it("retries only failures a retry can fix", () => {
    const retryable = SYNC_FAILURE_CATEGORIES.filter(isRetryableSyncFailure);
    expect(retryable).toEqual(["PROVIDER_UNAVAILABLE", "PROVIDER_TIMEOUT", "PROVIDER_RATE_LIMITED", "CURSOR_RESET_REQUIRED", "CURSOR_CONFLICT", "LEASE_EXPIRED", "INTERNAL_ERROR"]);
    expect(isRetryableSyncFailure("MALFORMED_PROVIDER_RESPONSE")).toBe(false);
    expect(isRetryableSyncFailure("REAUTH_REQUIRED")).toBe(false);
  });

  it("backs off exponentially up to a ceiling", () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelaySeconds)).toEqual([60, 120, 240, 480, 960, 1800]);
    expect(retryDelaySeconds(1000)).toBe(1800);
  });

  it("stops retrying when attempts run out, even for a retryable failure", () => {
    expect(decideSyncFailure({ attempts: 1, maxAttempts: MAX_SYNC_ATTEMPTS }, "PROVIDER_TIMEOUT", NOW)).toEqual({
      status: "RETRYABLE",
      category: "PROVIDER_TIMEOUT",
      nextAttemptAt: new Date("2026-09-15T12:01:00Z"),
    });
    expect(decideSyncFailure({ attempts: MAX_SYNC_ATTEMPTS, maxAttempts: MAX_SYNC_ATTEMPTS }, "PROVIDER_TIMEOUT", NOW)).toEqual({ status: "FAILED", category: "PROVIDER_TIMEOUT" });
    expect(decideSyncFailure({ attempts: 1, maxAttempts: MAX_SYNC_ATTEMPTS }, "REAUTH_REQUIRED", NOW)).toEqual({ status: "FAILED", category: "REAUTH_REQUIRED" });
  });

  it("can never schedule more than MAX_SYNC_ATTEMPTS runs", () => {
    let attempts = 0;
    let runs = 0;
    for (;;) {
      attempts += 1;
      runs += 1;
      const decision = decideSyncFailure({ attempts, maxAttempts: MAX_SYNC_ATTEMPTS }, "INTERNAL_ERROR", NOW);
      if (decision.status === "FAILED") break;
      if (runs > 100) throw new Error("unbounded retry loop");
    }
    expect(runs).toBe(MAX_SYNC_ATTEMPTS);
  });
});

describe("sync requests", () => {
  const base = { connectionId: CONNECTION, connectionStatus: "ACTIVE" as const, activeJob: null, lastSuccessfulSyncAt: null, trigger: "MANUAL" as const, reference: manualSyncReference(NOW), now: NOW };

  it("enqueues with a deterministic idempotency key", () => {
    const decision = decideSyncRequest(base);
    expect(decision).toEqual({ kind: "enqueue", idempotencyKey: `${CONNECTION}|MANUAL|${manualSyncReference(NOW)}` });
    expect(decideSyncRequest(base)).toEqual(decision);
  });

  it("gives the same manual key within one window and a new key in the next", () => {
    const later = new Date(NOW.getTime() + 10_000);
    const nextWindow = new Date(NOW.getTime() + MANUAL_SYNC_MIN_INTERVAL_SECONDS * 1000);
    expect(manualSyncReference(later)).toBe(manualSyncReference(new Date(Math.floor(NOW.getTime() / 300_000) * 300_000)));
    expect(manualSyncReference(nextWindow)).not.toBe(manualSyncReference(NOW));
  });

  it("joins an active job instead of creating a second one", () => {
    const activeJob = { id: "job-1", status: "RUNNING" as const, attempts: 1, maxAttempts: 5, nextAttemptAt: null, leaseExpiresAt: null };
    expect(decideSyncRequest({ ...base, activeJob })).toEqual({ kind: "already_active", jobId: "job-1" });
  });

  it("refuses a manual refresh right after a successful sync", () => {
    const decision = decideSyncRequest({ ...base, lastSuccessfulSyncAt: new Date(NOW.getTime() - 60_000).toISOString() });
    expect(decision).toEqual({ kind: "recently_synced", retryAfterSeconds: 240 });
    // A webhook is not throttled this way: the bank said something changed.
    expect(decideSyncRequest({ ...base, trigger: "WEBHOOK", lastSuccessfulSyncAt: new Date(NOW.getTime() - 60_000).toISOString() }).kind).toBe("enqueue");
  });

  it("refuses connections that cannot sync", () => {
    for (const connectionStatus of ["PENDING", "REQUIRES_REAUTH", "DISCONNECTED"] as const) {
      expect(decideSyncRequest({ ...base, connectionStatus })).toEqual({ kind: "refused", reason: "CONNECTION_NOT_SYNCABLE" });
    }
  });

  it("bounds the idempotency key length", () => {
    expect(syncIdempotencyKey({ connectionId: CONNECTION, trigger: "WEBHOOK", reference: "x".repeat(1000) }).length).toBe(300);
  });
});

describe("what a worker may do with a job", () => {
  const job = { id: "j", attempts: 1, maxAttempts: 5, nextAttemptAt: null, leaseExpiresAt: null };

  it("runs due queued jobs and waits for backoff", () => {
    expect(jobRunnability({ ...job, status: "QUEUED" }, NOW)).toEqual({ kind: "run" });
    expect(jobRunnability({ ...job, status: "RETRYABLE", nextAttemptAt: "2026-09-15T12:05:00Z" }, NOW)).toEqual({ kind: "not_due", nextAttemptAt: "2026-09-15T12:05:00Z" });
    expect(jobRunnability({ ...job, status: "RETRYABLE", nextAttemptAt: "2026-09-15T11:59:00Z" }, NOW)).toEqual({ kind: "requeue" });
  });

  it("recovers a run whose lease expired, and leaves a live one alone", () => {
    expect(jobRunnability({ ...job, status: "RUNNING", leaseExpiresAt: "2026-09-15T11:00:00Z" }, NOW)).toEqual({ kind: "recover_expired_lease" });
    expect(jobRunnability({ ...job, status: "RUNNING", leaseExpiresAt: "2026-09-15T13:00:00Z" }, NOW)).toEqual({ kind: "in_progress" });
  });

  it("never runs a finished job", () => {
    for (const status of ["SUCCEEDED", "FAILED", "CANCELLED"] as const) expect(jobRunnability({ ...job, status }, NOW)).toEqual({ kind: "finished", status });
  });
});
