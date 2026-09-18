import { canSync } from "./lifecycle";
import type { ConnectionStatus, SyncFailureCategory, SyncJobStatus, SyncTrigger } from "./types";

/**
 * THE SYNC-JOB STATE MACHINE.
 *
 *   QUEUED ──▶ RUNNING ──▶ SUCCEEDED
 *     │           │ │
 *     │           │ └──▶ RETRYABLE ──▶ QUEUED   (after a bounded backoff)
 *     │           │          │
 *     │           ▼          ▼
 *     └──────▶ CANCELLED   FAILED
 *
 * Pure. The same table is enforced by `bank_sync_jobs_guard` in migration
 * 0047, and "one active job per connection" is a partial unique index there —
 * so two browsers, a webhook and a scheduler asking at the same instant
 * produce one job, not a sync storm, whatever this file decides.
 *
 * WHY NOT REUSE document_processing_jobs
 *
 * Audited before writing this: that table's foreign key is a document, its
 * completion states are extraction outcomes, and its guard trigger requires an
 * extraction row before a job may complete. A bank sync has none of those. The
 * PATTERN is reused — idempotency key, bounded attempts, lease, guard trigger,
 * service-role writes — rather than bending one table to mean two things.
 *
 * WHO RUNS A JOB
 *
 * A request runs one inline through `runBankSyncJob`; the background worker
 * (src/server/bank-connections/worker.ts, BANK-SYNC-WORKER.md) claims due jobs
 * and runs them through `executeClaimedSyncRun`. The limits in this file bound
 * both equally — a worker has no extra licence to retry, page or wait. With no
 * provider configured, no job can be created at all.
 */

export const SYNC_JOB_TRANSITIONS: Readonly<Record<SyncJobStatus, readonly SyncJobStatus[]>> = {
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "RETRYABLE", "FAILED", "CANCELLED"],
  RETRYABLE: ["QUEUED", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

export const ACTIVE_SYNC_JOB_STATUSES: readonly SyncJobStatus[] = ["QUEUED", "RUNNING", "RETRYABLE"];

/** A sync job is attempted at most this many times. */
export const MAX_SYNC_ATTEMPTS = 5;
/** A run holding RUNNING longer than this is presumed dead. Longer than
 *  MAX_PAGES_PER_RUN provider calls at their timeout. */
export const SYNC_LEASE_SECONDS = 600;
/** Provider pages fetched in one run. A larger backlog continues in a new job. */
export const MAX_PAGES_PER_RUN = 20;
/** External transactions reconciled per database batch. Also bounds the id
 *  lists a batch sends in a request URL. */
export const RECONCILE_BATCH_SIZE = 100;
/** External transactions reconciled in one run. */
export const MAX_RECONCILED_PER_RUN = 5_000;
/** A manual refresh right after a successful sync fetches nothing new. */
export const MANUAL_SYNC_MIN_INTERVAL_SECONDS = 300;

const BACKOFF_BASE_SECONDS = 60;
const BACKOFF_CEILING_SECONDS = 30 * 60;

export class InvalidSyncJobTransitionError extends Error {
  constructor(from: SyncJobStatus, to: SyncJobStatus) {
    super(`A bank sync job cannot move from ${from} to ${to}.`);
    this.name = "InvalidSyncJobTransitionError";
  }
}

export function canTransitionSyncJob(from: SyncJobStatus, to: SyncJobStatus): boolean {
  return SYNC_JOB_TRANSITIONS[from].includes(to);
}

export function assertSyncJobTransition(from: SyncJobStatus, to: SyncJobStatus): void {
  if (!canTransitionSyncJob(from, to)) throw new InvalidSyncJobTransitionError(from, to);
}

export function isTerminalSyncJobStatus(status: SyncJobStatus): boolean {
  return SYNC_JOB_TRANSITIONS[status].length === 0;
}

/**
 * Whether a failure is worth retrying automatically.
 *
 * Retryable: the provider or this server was briefly unable. Not retryable:
 * anything a retry cannot change — a person must re-authenticate, consent was
 * revoked, the response was malformed (retrying a malformed payload loops),
 * no provider or credential exists, or the connection is gone.
 */
export function isRetryableSyncFailure(category: SyncFailureCategory): boolean {
  switch (category) {
    case "PROVIDER_UNAVAILABLE":
    case "PROVIDER_TIMEOUT":
    case "PROVIDER_RATE_LIMITED":
    case "CURSOR_RESET_REQUIRED":
    case "CURSOR_CONFLICT":
    case "LEASE_EXPIRED":
    case "INTERNAL_ERROR":
      return true;
    case "PROVIDER_NOT_CONFIGURED":
    case "MALFORMED_PROVIDER_RESPONSE":
    case "REAUTH_REQUIRED":
    case "CONNECTION_REVOKED":
    case "CREDENTIAL_UNAVAILABLE":
    case "CONNECTION_DISCONNECTED":
      return false;
  }
}

/** 60s, 120s, 240s … capped at 30 minutes. Bounded twice: by this ceiling and
 *  by MAX_SYNC_ATTEMPTS, so there is no retry loop without an end. */
export function retryDelaySeconds(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 16));
  return Math.min(BACKOFF_BASE_SECONDS * 2 ** exponent, BACKOFF_CEILING_SECONDS);
}

export type FailureDecision =
  | { status: "RETRYABLE"; category: SyncFailureCategory; nextAttemptAt: Date }
  | { status: "FAILED"; category: SyncFailureCategory };

/** What a failed run does to its job. */
export function decideSyncFailure(job: { attempts: number; maxAttempts: number }, category: SyncFailureCategory, now: Date): FailureDecision {
  if (isRetryableSyncFailure(category) && job.attempts < job.maxAttempts) {
    return { status: "RETRYABLE", category, nextAttemptAt: new Date(now.getTime() + retryDelaySeconds(job.attempts) * 1000) };
  }
  return { status: "FAILED", category };
}

/**
 * The idempotency key for a sync job.
 *
 * A webhook's key is its event id, so a redelivered event is the same job. A
 * manual refresh is keyed to a five-minute window, so a double-click, a
 * retried request or a script inside that window is one job.
 */
export function syncIdempotencyKey(input: { connectionId: string; trigger: SyncTrigger; reference: string }): string {
  return [input.connectionId, input.trigger, input.reference].join("|").slice(0, 300);
}

export function manualSyncReference(now: Date): string {
  return `window-${Math.floor(now.getTime() / (MANUAL_SYNC_MIN_INTERVAL_SECONDS * 1000))}`;
}

export interface SyncJobSnapshot {
  id: string;
  status: SyncJobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
}

export type SyncRequestDecision =
  | { kind: "enqueue"; idempotencyKey: string }
  | { kind: "already_active"; jobId: string }
  | { kind: "recently_synced"; retryAfterSeconds: number }
  | { kind: "refused"; reason: "CONNECTION_NOT_SYNCABLE" };

/**
 * Whether a sync request should create a job. Pure.
 *
 * At most one job is active per connection; a request while one is active
 * joins it. A manual refresh within MANUAL_SYNC_MIN_INTERVAL_SECONDS of a
 * successful sync is refused politely — the cursor would return nothing new,
 * and a refresh button is otherwise an unmetered provider-call generator.
 */
export function decideSyncRequest(input: {
  connectionId: string;
  connectionStatus: ConnectionStatus;
  activeJob: SyncJobSnapshot | null;
  lastSuccessfulSyncAt: string | null;
  trigger: SyncTrigger;
  reference: string;
  now: Date;
}): SyncRequestDecision {
  if (!canSync(input.connectionStatus)) return { kind: "refused", reason: "CONNECTION_NOT_SYNCABLE" };
  if (input.activeJob) return { kind: "already_active", jobId: input.activeJob.id };

  if (input.trigger === "MANUAL" && input.lastSuccessfulSyncAt) {
    const elapsed = (input.now.getTime() - new Date(input.lastSuccessfulSyncAt).getTime()) / 1000;
    if (elapsed >= 0 && elapsed < MANUAL_SYNC_MIN_INTERVAL_SECONDS) {
      return { kind: "recently_synced", retryAfterSeconds: Math.ceil(MANUAL_SYNC_MIN_INTERVAL_SECONDS - elapsed) };
    }
  }

  return { kind: "enqueue", idempotencyKey: syncIdempotencyKey({ connectionId: input.connectionId, trigger: input.trigger, reference: input.reference }) };
}

export type JobRunnability =
  | { kind: "run" }
  | { kind: "requeue" }
  | { kind: "not_due"; nextAttemptAt: string }
  | { kind: "recover_expired_lease" }
  | { kind: "in_progress" }
  | { kind: "finished"; status: SyncJobStatus };

/** What a worker may do with a job right now. Pure. */
export function jobRunnability(job: SyncJobSnapshot, now: Date): JobRunnability {
  switch (job.status) {
    case "QUEUED":
      if (job.nextAttemptAt && new Date(job.nextAttemptAt) > now) return { kind: "not_due", nextAttemptAt: job.nextAttemptAt };
      return { kind: "run" };
    case "RETRYABLE":
      if (job.nextAttemptAt && new Date(job.nextAttemptAt) > now) return { kind: "not_due", nextAttemptAt: job.nextAttemptAt };
      return { kind: "requeue" };
    case "RUNNING":
      if (job.leaseExpiresAt && new Date(job.leaseExpiresAt) <= now) return { kind: "recover_expired_lease" };
      return { kind: "in_progress" };
    default:
      return { kind: "finished", status: job.status };
  }
}
