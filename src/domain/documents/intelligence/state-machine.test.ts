import { describe, expect, it } from "vitest";
import {
  JOB_TRANSITIONS,
  MAX_PROCESSING_ATTEMPTS,
  PROCESSING_LEASE_SECONDS,
  InvalidJobTransitionError,
  assertJobTransition,
  canTransitionJob,
  decideProcessingRequest,
  idempotencyKeyFor,
  isLeaseExpired,
  isTerminalJobStatus,
  type JobSnapshot,
} from "./state-machine";
import { PROCESSING_VERSION, type ProcessingJobStatus } from "./types";

/** E, F, G: the processing-job state machine, idempotency and retry. */

const identity = { documentId: "doc-1", processingVersion: PROCESSING_VERSION, provider: "pdf-text-layer", providerVersion: "1.0.0" };
const NOW = new Date("2026-09-14T12:00:00.000Z");

function job(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return { id: "job-1", status: "QUEUED", attempts: 0, maxAttempts: MAX_PROCESSING_ATTEMPTS, idempotencyKey: idempotencyKeyFor(identity), startedAt: null, ...overrides };
}

describe("transitions", () => {
  const all: ProcessingJobStatus[] = ["QUEUED", "PROCESSING", "SUCCEEDED", "PARTIAL", "REVIEW_REQUIRED", "UNSUPPORTED", "FAILED"];

  it.each([
    ["QUEUED", "PROCESSING"],
    ["QUEUED", "FAILED"],
    ["PROCESSING", "SUCCEEDED"],
    ["PROCESSING", "PARTIAL"],
    ["PROCESSING", "REVIEW_REQUIRED"],
    ["PROCESSING", "UNSUPPORTED"],
    ["PROCESSING", "FAILED"],
    ["FAILED", "QUEUED"],
  ] as const)("allows %s → %s", (from, to) => {
    expect(canTransitionJob(from, to)).toBe(true);
    expect(() => assertJobTransition(from, to)).not.toThrow();
  });

  it("refuses every other move, including skipping PROCESSING and reopening a completed job", () => {
    for (const from of all) {
      for (const to of all) {
        if (JOB_TRANSITIONS[from].includes(to)) continue;
        expect(canTransitionJob(from, to), `${from} → ${to}`).toBe(false);
        expect(() => assertJobTransition(from, to), `${from} → ${to}`).toThrow(InvalidJobTransitionError);
      }
    }
    expect(canTransitionJob("QUEUED", "SUCCEEDED")).toBe(false);
    expect(canTransitionJob("SUCCEEDED", "QUEUED")).toBe(false);
  });

  it("treats every completed outcome as terminal, and FAILED as retryable", () => {
    expect(["SUCCEEDED", "PARTIAL", "REVIEW_REQUIRED", "UNSUPPORTED"].every((status) => isTerminalJobStatus(status as ProcessingJobStatus))).toBe(true);
    expect(isTerminalJobStatus("FAILED")).toBe(false);
    expect(isTerminalJobStatus("QUEUED")).toBe(false);
  });
});

describe("idempotency", () => {
  it("gives the same read of the same document the same key", () => {
    expect(idempotencyKeyFor(identity)).toBe(idempotencyKeyFor({ ...identity }));
  });

  it("gives a new processing or provider version a different key — a new job, a new extraction version", () => {
    expect(idempotencyKeyFor({ ...identity, processingVersion: "document-intelligence.2027.1" })).not.toBe(idempotencyKeyFor(identity));
    expect(idempotencyKeyFor({ ...identity, providerVersion: "1.1.0" })).not.toBe(idempotencyKeyFor(identity));
    expect(idempotencyKeyFor({ ...identity, documentId: "doc-2" })).not.toBe(idempotencyKeyFor(identity));
  });
});

describe("what a request to read does", () => {
  it("creates a job when none exists for this read", () => {
    expect(decideProcessingRequest([], identity, NOW)).toEqual({ kind: "create" });
  });

  it("creates a new job when only an older version was read", () => {
    const older = job({ status: "SUCCEEDED", idempotencyKey: idempotencyKeyFor({ ...identity, processingVersion: "document-intelligence.2025.9" }) });
    expect(decideProcessingRequest([older], identity, NOW)).toEqual({ kind: "create" });
  });

  it("starts an existing QUEUED job instead of creating another", () => {
    expect(decideProcessingRequest([job()], identity, NOW)).toEqual({ kind: "start_existing", jobId: "job-1" });
  });

  it("leaves a live run alone", () => {
    const running = job({ status: "PROCESSING", attempts: 1, startedAt: new Date(NOW.getTime() - 10_000).toISOString() });
    expect(decideProcessingRequest([running], identity, NOW)).toEqual({ kind: "in_progress", jobId: "job-1" });
  });

  it("recovers a run whose lease expired, and retries only while attempts remain", () => {
    const stale = new Date(NOW.getTime() - (PROCESSING_LEASE_SECONDS + 1) * 1000).toISOString();
    expect(decideProcessingRequest([job({ status: "PROCESSING", attempts: 1, startedAt: stale })], identity, NOW)).toEqual({ kind: "recover_expired", jobId: "job-1", canRetryAfter: true });
    expect(decideProcessingRequest([job({ status: "PROCESSING", attempts: MAX_PROCESSING_ATTEMPTS, startedAt: stale })], identity, NOW)).toEqual({ kind: "recover_expired", jobId: "job-1", canRetryAfter: false });
  });

  it("retries a failed job while attempts remain, then stops", () => {
    expect(decideProcessingRequest([job({ status: "FAILED", attempts: 1 })], identity, NOW)).toEqual({ kind: "retry", jobId: "job-1" });
    expect(decideProcessingRequest([job({ status: "FAILED", attempts: MAX_PROCESSING_ATTEMPTS })], identity, NOW)).toEqual({ kind: "attempts_exhausted", jobId: "job-1" });
  });

  it.each(["SUCCEEDED", "PARTIAL", "REVIEW_REQUIRED", "UNSUPPORTED"] as const)("never re-reads a %s job under the same versions — no duplicate extraction", (status) => {
    expect(decideProcessingRequest([job({ status, attempts: 1 })], identity, NOW)).toEqual({ kind: "already_processed", jobId: "job-1", status });
  });
});

describe("leases", () => {
  it("expires only PROCESSING jobs past the lease", () => {
    const fresh = new Date(NOW.getTime() - 1000).toISOString();
    const stale = new Date(NOW.getTime() - (PROCESSING_LEASE_SECONDS + 5) * 1000).toISOString();
    expect(isLeaseExpired({ status: "PROCESSING", startedAt: fresh }, NOW)).toBe(false);
    expect(isLeaseExpired({ status: "PROCESSING", startedAt: stale }, NOW)).toBe(true);
    expect(isLeaseExpired({ status: "QUEUED", startedAt: stale }, NOW)).toBe(false);
    expect(isLeaseExpired({ status: "PROCESSING", startedAt: "not a date" }, NOW)).toBe(true);
  });
});
