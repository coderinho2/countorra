import { PROVIDER_CALL_TIMEOUT_MS } from "./provider";
import { MAX_SYNC_ATTEMPTS, SYNC_LEASE_SECONDS, syncIdempotencyKey } from "./sync-job";

/**
 * THE WORKER'S POLICY, WITHOUT A DATABASE OR A PROVIDER.
 *
 * Task 11 left a documented hole: jobs were queued (by a link, a refresh, a
 * webhook, a continuation) and nothing ran them. This file decides WHEN a
 * worker stops, HOW OFTEN a connection is synced on a schedule, and WHAT a
 * worker calls itself. The execution itself is
 * src/server/bank-connections/worker.ts; the work of one job is still
 * `runBankSyncJob`, unchanged.
 *
 * EVERY BOUND IS A CONSTANT HERE
 *
 * A worker invocation is finite in three independent ways — jobs, wall clock,
 * and an empty queue — because a background loop with one bound is a loop with
 * none as soon as that bound is wrong. Nothing here spins: a worker that finds
 * nothing returns immediately and the next invocation looks again.
 *
 * WHY POSTGRES AND NOT A QUEUE
 *
 * The jobs are already durable rows with a state machine, a lease, an
 * idempotency key and a one-active-job constraint, all enforced by the
 * database. A broker in front of that would add a second source of truth to
 * keep in step with the first, which is how work gets executed twice or lost.
 * At this product's size the missing piece was a claim operation, not
 * infrastructure.
 */

/**
 * Jobs claimed per database round trip.
 *
 * One, deliberately. A claimed job is leased to this invocation, so claiming
 * more than it is about to run would strand leases on work nobody is doing
 * until they expire. The batch claim exists in SQL (and is tested with larger
 * batches, for a long-running worker process that can honour them); a bounded
 * serverless invocation takes one job at a time and stays exactly on its
 * deadline.
 */
export const WORKER_CLAIM_BATCH_SIZE = 1;

/** Jobs one invocation will execute, however much is queued. The rest waits
 *  for the next invocation — which is the point of a durable queue. */
export const WORKER_MAX_JOBS_PER_INVOCATION = 25;

/**
 * Wall clock for one invocation. Sized for a scheduled serverless function
 * with a 60-second ceiling: the worker stops itself with time to finish the
 * job it is on, release its lease and answer, rather than being killed
 * mid-page (which is survivable — see the lease — but wasteful).
 */
export const WORKER_MAX_DURATION_MS = 50_000;

/**
 * THE SERVERLESS BUDGET.
 *
 * The worker route declares `maxDuration = 60` (Vercel's route segment
 * config). The platform kills the function at that instant, whatever it is
 * doing — so the last moment a NEW job or a NEW provider page may start is the
 * limit, minus the worst case of one provider call (it must be allowed to
 * finish), minus a margin to commit the page, complete the run and answer.
 *
 *     60 s  −  25 s (PROVIDER_CALL_TIMEOUT_MS)  −  5 s  =  30 s
 *
 * Being killed is survivable (the lease expires and the sweep requeues the
 * job), but a big initial sync that is killed at the same point every time
 * would spend its five attempts and fail for good. Stopping at the budget and
 * handing off to a CONTINUATION job makes every invocation productive.
 */
export const WORKER_ROUTE_MAX_DURATION_SECONDS = 60;
export const WORKER_COMPLETION_MARGIN_MS = 5_000;

/** Milliseconds after an invocation starts by which no new job is claimed and
 *  no new provider page is started. Never negative. */
export function workerStartBudgetMs(input: { functionLimitMs: number; providerWorstCaseMs?: number; marginMs?: number }): number {
  const worst = input.providerWorstCaseMs ?? PROVIDER_CALL_TIMEOUT_MS;
  const margin = input.marginMs ?? WORKER_COMPLETION_MARGIN_MS;
  return Math.max(0, input.functionLimitMs - worst - margin);
}

/** A due job older than this means the scheduler is not keeping up — or is
 *  not being invoked at all. Reported as a warning, once per invocation. */
export const WORKER_BACKLOG_WARNING_SECONDS = 30 * 60;

export interface WorkerQueueHealth {
  /** Jobs that could be claimed right now. */
  dueJobs: number;
  /** How long the oldest claimable job has been waiting, or null if none. */
  oldestDueAgeSeconds: number | null;
  /** RUNNING jobs whose lease has already expired — abandoned by a worker. */
  runningPastLease: number;
}

/** Whether the queue says something is wrong with how the worker is run. */
export function isQueueUnhealthy(health: WorkerQueueHealth): boolean {
  return (health.oldestDueAgeSeconds ?? 0) > WORKER_BACKLOG_WARNING_SECONDS || health.runningPastLease > 0;
}

/** A worker claims a job for this long, then extends it page by page. Task
 *  11's lease, unchanged. */
export const WORKER_LEASE_SECONDS = SYNC_LEASE_SECONDS;

/** How often a connection is synced when nothing else asks. Six hours: far
 *  below any provider's per-item limits, and often enough that a person who
 *  opens Countorra in the morning sees yesterday's transactions. */
export const SCHEDULER_SYNC_INTERVAL_SECONDS = 6 * 60 * 60;

/** Connections a single scheduler invocation will queue. Bounded so one
 *  invocation cannot aim a whole deployment at a provider at once. */
export const SCHEDULER_MAX_CONNECTIONS_PER_RUN = 50;

/** Abandoned jobs recovered per scheduler invocation. */
export const SCHEDULER_MAX_RECLAIMED_PER_RUN = 100;

/** Attempts per job. Task 11's limit, restated here so a worker reading this
 *  file cannot conclude it may retry forever. */
export const WORKER_MAX_ATTEMPTS = MAX_SYNC_ATTEMPTS;

const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,63}$/;

export class InvalidWorkerIdentityError extends Error {
  constructor(value: string) {
    super(`A worker identity must be 8 to 64 characters of A-Za-z0-9_.:- (got ${value.length}).`);
    this.name = "InvalidWorkerIdentityError";
  }
}

/**
 * The identity a worker holds its leases under.
 *
 * It must be unique per execution, not per machine: two invocations of the
 * same scheduled function overlap, and a lease is owned by one of them. It
 * carries no secret and no customer data — it goes into a database column and
 * into logs, and it is deliberately not readable by members.
 */
export function workerIdentity(input: { prefix?: string; unique: string }): string {
  const prefix = (input.prefix ?? "worker").replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "worker";
  const unique = input.unique.replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
  const identity = `${prefix}-${unique}`.slice(0, 64);
  if (!WORKER_ID_PATTERN.test(identity)) throw new InvalidWorkerIdentityError(identity);
  return identity;
}

export function isWorkerIdentity(value: string): boolean {
  return WORKER_ID_PATTERN.test(value);
}

export interface WorkerProgress {
  /** Jobs whose execution has finished, whatever the outcome. */
  jobsExecuted: number;
  /** Jobs the last claim returned. Zero means the queue had nothing due. */
  lastBatchSize: number;
  elapsedMs: number;
}

export interface WorkerBounds {
  maxJobs: number;
  maxDurationMs: number;
}

export type WorkerStopReason = "queue_empty" | "job_limit" | "time_limit";

export type WorkerStep = { kind: "claim"; limit: number } | { kind: "stop"; reason: WorkerStopReason };

/**
 * Whether to claim more work. Pure, and the only place a worker loop is
 * allowed to decide it continues.
 *
 * `claim` never asks for more than the job budget that remains, so the last
 * batch of an invocation cannot claim leases on jobs it will not run.
 */
export function nextWorkerStep(progress: WorkerProgress, bounds: WorkerBounds): WorkerStep {
  if (progress.jobsExecuted >= bounds.maxJobs) return { kind: "stop", reason: "job_limit" };
  if (progress.elapsedMs >= bounds.maxDurationMs) return { kind: "stop", reason: "time_limit" };
  if (progress.lastBatchSize === 0 && progress.jobsExecuted > 0) return { kind: "stop", reason: "queue_empty" };
  return { kind: "claim", limit: Math.max(1, Math.min(WORKER_CLAIM_BATCH_SIZE, bounds.maxJobs - progress.jobsExecuted)) };
}

/**
 * The idempotency reference for a scheduled sync.
 *
 * Keyed to the interval window rather than to the instant, so two schedulers
 * firing in the same window — a retried cron delivery, two regions, a person
 * invoking it by hand — produce one job. The database refuses the second by
 * unique key, so this is belt and braces rather than the only protection.
 */
export function scheduledSyncReference(now: Date, intervalSeconds: number = SCHEDULER_SYNC_INTERVAL_SECONDS): string {
  const window = Math.floor(now.getTime() / (Math.max(60, intervalSeconds) * 1000));
  return `window-${window}`;
}

export function scheduledSyncIdempotencyKey(connectionId: string, now: Date, intervalSeconds?: number): string {
  return syncIdempotencyKey({ connectionId, trigger: "SCHEDULED", reference: scheduledSyncReference(now, intervalSeconds) });
}

export interface WorkerJobResult {
  jobId: string;
  connectionId: string;
  organizationId: string;
  trigger: string;
  attempt: number;
  outcome: "succeeded" | "failed" | "retrying" | "cancelled" | "abandoned" | "lease_lost" | "not_runnable";
  failureCategory: string | null;
  continuationJobId: string | null;
  durationMs: number;
}

export interface WorkerRunSummary {
  workerId: string;
  /** False on a deployment with no bank provider: nothing is claimed at all,
   *  rather than jobs failing their way through five attempts. */
  providerConfigured: boolean;
  claimed: number;
  executed: number;
  succeeded: number;
  failed: number;
  retrying: number;
  cancelled: number;
  abandoned: number;
  continuations: number;
  stoppedBecause: WorkerStopReason;
  durationMs: number;
  jobs: WorkerJobResult[];
}

export interface SchedulerRunSummary {
  /** The queue as the scheduler found it, after reclaiming abandoned leases.
   *  Null when it could not be read — which is itself reported. */
  queue: WorkerQueueHealth | null;
  reclaimedLeases: number;
  connectionsConsidered: number;
  jobsCreated: number;
  alreadyActive: number;
  duplicates: number;
  skipped: number;
  durationMs: number;
}
