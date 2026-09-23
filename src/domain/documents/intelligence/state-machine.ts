import { isRetryableFailure, PROCESSING_VERSION, type FailureCategory, type ProcessingJobStatus } from "./types";

/**
 * THE PROCESSING-JOB STATE MACHINE.
 *
 * Pure: a function of the job rows that already exist and the clock. The same
 * rules are enforced a second time by the guard trigger in
 * supabase/migrations/0046_document_intelligence.sql, so a bug here cannot
 * produce an illegal row.
 *
 *   QUEUED ──▶ PROCESSING ──▶ SUCCEEDED | PARTIAL | REVIEW_REQUIRED | UNSUPPORTED
 *     │            │
 *     └──▶ FAILED ◀┘ ──▶ QUEUED   (retry, while attempts remain AND the
 *                                  failure was transient — a permanent one
 *                                  stops at the first attempt)
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * There is no background worker. A run is started by an explicit request and
 * completes inside it. QUEUED is still a real state — the job row is written
 * before the run begins, so a request that dies between the two leaves a
 * visible, retryable job rather than nothing. A scheduler, when one exists,
 * picks up QUEUED jobs through `runProcessingJob` in
 * src/server/documents/processing.ts; nothing else changes.
 */

export const JOB_TRANSITIONS: Readonly<Record<ProcessingJobStatus, readonly ProcessingJobStatus[]>> = {
  QUEUED: ["PROCESSING", "FAILED"],
  PROCESSING: ["SUCCEEDED", "PARTIAL", "REVIEW_REQUIRED", "UNSUPPORTED", "FAILED"],
  FAILED: ["QUEUED"],
  SUCCEEDED: [],
  PARTIAL: [],
  REVIEW_REQUIRED: [],
  UNSUPPORTED: [],
};

/** A document may be read at most this many times per job before a person
 *  has to look at why. */
export const MAX_PROCESSING_ATTEMPTS = 3;

/** How long a run may hold PROCESSING before it is presumed dead. Longer than
 *  the provider timeout plus persistence, so a live run is never pre-empted. */
export const PROCESSING_LEASE_SECONDS = 120;

export class InvalidJobTransitionError extends Error {
  constructor(from: ProcessingJobStatus, to: ProcessingJobStatus) {
    super(`A document processing job cannot move from ${from} to ${to}.`);
    this.name = "InvalidJobTransitionError";
  }
}

export function canTransitionJob(from: ProcessingJobStatus, to: ProcessingJobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function assertJobTransition(from: ProcessingJobStatus, to: ProcessingJobStatus): void {
  if (!canTransitionJob(from, to)) throw new InvalidJobTransitionError(from, to);
}

export function isTerminalJobStatus(status: ProcessingJobStatus): boolean {
  return JOB_TRANSITIONS[status].length === 0;
}

/** What identifies "the same read" of a document: the rules, and the reader. */
export interface ProcessingIdentity {
  documentId: string;
  processingVersion: string;
  provider: string;
  providerVersion: string;
}

/**
 * The idempotency key for a job. Two requests to read the same document with
 * the same rules and the same reader are the same job — which is what stops a
 * double-click, a retried request or a scripted loop producing a second
 * extraction of identical evidence.
 */
export function idempotencyKeyFor(identity: ProcessingIdentity): string {
  return [identity.documentId, identity.processingVersion, identity.provider, identity.providerVersion].join("|");
}

export interface JobSnapshot {
  id: string;
  status: ProcessingJobStatus;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
  startedAt: string | null;
  /** Why the last attempt failed, when one did. Decides whether another
   *  attempt could possibly differ — see `isRetryableFailure`. */
  failureCategory?: FailureCategory | null;
}

export type ProcessingDecision =
  /** No job for this identity: create one. */
  | { kind: "create" }
  /** A job exists but was never started: start it. */
  | { kind: "start_existing"; jobId: string }
  /** A run holds a live lease: do nothing, report it. */
  | { kind: "in_progress"; jobId: string }
  /** A run's lease expired: fail it as LEASE_EXPIRED, then retry if allowed. */
  | { kind: "recover_expired"; jobId: string; canRetryAfter: boolean }
  /** This exact read already completed. Idempotent: return it. */
  | { kind: "already_processed"; jobId: string; status: ProcessingJobStatus }
  /** The last attempt failed and attempts remain. */
  | { kind: "retry"; jobId: string }
  /** The last attempt failed and none remain. */
  | { kind: "attempts_exhausted"; jobId: string }
  /** The last attempt failed for a reason another attempt cannot change —
   *  the format, the size, the credentials. Attempts may remain; spending
   *  them would be three identical failures and three billed calls. */
  | { kind: "permanently_failed"; jobId: string; category: FailureCategory };

/**
 * What a request to read a document should do, given the jobs that exist.
 *
 * Only the job matching this identity matters. A job under an older processing
 * or provider version is history — reading again under new rules creates a new
 * job and, on completion, a new extraction version, leaving the old one intact.
 */
export function decideProcessingRequest(jobs: readonly JobSnapshot[], identity: ProcessingIdentity, now: Date): ProcessingDecision {
  const key = idempotencyKeyFor(identity);
  const job = jobs.find((candidate) => candidate.idempotencyKey === key);
  if (!job) return { kind: "create" };

  switch (job.status) {
    case "QUEUED":
      return { kind: "start_existing", jobId: job.id };
    case "PROCESSING": {
      if (!isLeaseExpired(job, now)) return { kind: "in_progress", jobId: job.id };
      return { kind: "recover_expired", jobId: job.id, canRetryAfter: job.attempts < job.maxAttempts };
    }
    case "FAILED": {
      // Cause before budget: a file the reader cannot parse is not worth two
      // more attempts just because the budget allows them.
      if (job.failureCategory && !isRetryableFailure(job.failureCategory)) {
        return { kind: "permanently_failed", jobId: job.id, category: job.failureCategory };
      }
      return job.attempts < job.maxAttempts ? { kind: "retry", jobId: job.id } : { kind: "attempts_exhausted", jobId: job.id };
    }
    default:
      return { kind: "already_processed", jobId: job.id, status: job.status };
  }
}

export function isLeaseExpired(job: Pick<JobSnapshot, "status" | "startedAt">, now: Date): boolean {
  if (job.status !== "PROCESSING" || !job.startedAt) return false;
  const started = Date.parse(job.startedAt);
  if (Number.isNaN(started)) return true;
  return now.getTime() - started > PROCESSING_LEASE_SECONDS * 1000;
}

/** The identity of a read under the current rules. */
export function currentIdentity(documentId: string, provider: { id: string; version: string }): ProcessingIdentity {
  return { documentId, processingVersion: PROCESSING_VERSION, provider: provider.id, providerVersion: provider.version };
}
