import { randomUUID } from "node:crypto";
import { resolveBankProvider } from "@/domain/bank-connections/provider";
import {
  SCHEDULER_MAX_CONNECTIONS_PER_RUN,
  SCHEDULER_MAX_RECLAIMED_PER_RUN,
  SCHEDULER_SYNC_INTERVAL_SECONDS,
  WORKER_LEASE_SECONDS,
  WORKER_MAX_DURATION_MS,
  WORKER_MAX_JOBS_PER_INVOCATION,
  isQueueUnhealthy,
  nextWorkerStep,
  scheduledSyncIdempotencyKey,
  workerIdentity,
  type SchedulerRunSummary,
  type WorkerJobResult,
  type WorkerRunSummary,
  type WorkerQueueHealth,
  type WorkerStopReason,
} from "@/domain/bank-connections/worker";
import { reportError, reportEvent } from "@/lib/observability";
import { executeClaimedSyncRun, type SyncDependencies, type SyncRunOutcome } from "./sync";

/**
 * THE BANK SYNC WORKER AND SCHEDULER.
 *
 *   scheduler ─▶ reclaim abandoned leases
 *             ─▶ connections due for a sync ─▶ enqueue SCHEDULED jobs
 *
 *   worker ─▶ claim one due job (FOR UPDATE SKIP LOCKED, lease held by THIS
 *             invocation) ─▶ executeClaimedSyncRun ─▶ provider ─▶ ledger
 *             ─▶ next job, until the job budget, the clock, or the queue ends
 *
 * PROVIDER-INDEPENDENT
 *
 * Nothing here knows what Plaid is. A job names a connection, the connection
 * names its provider, and the provider is resolved from the registry — the
 * same path an inline refresh takes. Adding a second provider changes this
 * file not at all.
 *
 * NO IN-MEMORY QUEUE
 *
 * Postgres is the only source of truth for what is queued, who owns it and
 * what happened. This module holds nothing between invocations: a restart
 * mid-job loses no work, because the job row is still RUNNING with a lease
 * that expires, and the next scheduler invocation puts it back in line.
 *
 * AT LEAST ONCE, NOT EXACTLY ONCE
 *
 * A crash between a provider response and the database commit means that page
 * is fetched again. That is safe because every write boundary is idempotent:
 * pages are keyed by provider transaction id and content hash, the cursor only
 * moves with the page that is applied in the same transaction, and a repeated
 * page produces `added: 0`. Exactly-once delivery is not available from a bank
 * provider and is not claimed here.
 *
 * WHAT IS LOGGED
 *
 * Ids, the provider name, the job type, the attempt, a duration, a result
 * state and a failure category. Never a credential, a cursor, an amount, a
 * description, or a provider's own message.
 */

export interface WorkerOptions {
  /** The lease identity for this invocation. Generated when absent. */
  workerId?: string;
  maxJobs?: number;
  maxDurationMs?: number;
  leaseSeconds?: number;
  /**
   * Wall-clock time (epoch ms) after which no job starts a new provider page.
   * Passed straight through to the engine as `deadline`; the backlog continues
   * in a CONTINUATION job. Set by the serverless route from its time limit.
   */
  pageDeadline?: number;
  /** Injected in tests so a run's clock is deterministic. */
  monotonic?: () => number;
}

export interface SchedulerOptions {
  maxConnections?: number;
  maxReclaimed?: number;
  intervalSeconds?: number;
}

const bounded = (value: number | undefined, fallback: number, min: number, max: number): number =>
  Math.max(min, Math.min(value ?? fallback, max));

/** A worker identity for one invocation. Unique per execution, not per host:
 *  two overlapping invocations of the same function must not share a lease. */
export function newWorkerIdentity(prefix = "worker"): string {
  return workerIdentity({ prefix, unique: randomUUID().replace(/-/g, "") });
}

/**
 * Executes queued bank sync work, then stops.
 *
 * Three independent bounds, all configurable and all enforced: the number of
 * jobs, the wall clock, and an empty queue. There is no `while (true)` without
 * one of them, and the claim asks only for the jobs this invocation will
 * actually run — so a lease is never left on work nobody is doing.
 */
export async function runBankSyncWorker(deps: SyncDependencies, options: WorkerOptions = {}): Promise<WorkerRunSummary> {
  const monotonic = options.monotonic ?? (() => Date.now());
  const startedAt = monotonic();
  const workerId = options.workerId ?? newWorkerIdentity();
  const leaseSeconds = bounded(options.leaseSeconds, WORKER_LEASE_SECONDS, 30, 3600);
  const bounds = {
    maxJobs: bounded(options.maxJobs, WORKER_MAX_JOBS_PER_INVOCATION, 1, 500),
    maxDurationMs: bounded(options.maxDurationMs, WORKER_MAX_DURATION_MS, 1_000, 15 * 60_000),
  };

  const jobs: WorkerJobResult[] = [];
  const summary = (stoppedBecause: WorkerStopReason, providerConfigured: boolean): WorkerRunSummary => ({
    workerId,
    providerConfigured,
    claimed: jobs.length,
    executed: jobs.length,
    succeeded: jobs.filter((job) => job.outcome === "succeeded").length,
    failed: jobs.filter((job) => job.outcome === "failed").length,
    retrying: jobs.filter((job) => job.outcome === "retrying").length,
    cancelled: jobs.filter((job) => job.outcome === "cancelled").length,
    abandoned: jobs.filter((job) => job.outcome === "abandoned" || job.outcome === "lease_lost").length,
    continuations: jobs.filter((job) => job.continuationJobId !== null).length,
    stoppedBecause,
    durationMs: monotonic() - startedAt,
    jobs,
  });

  // With no provider, every claim would start an attempt that can only fail
  // PROVIDER_NOT_CONFIGURED and spend one of the job's five tries. Nothing is
  // claimed at all — which is this deployment's state today.
  if (deps.providers.length === 0) {
    reportEvent("bank.worker_skipped", { scope: "bank", detail: { workerId, reason: "provider_not_configured" } });
    return summary("queue_empty", false);
  }

  reportEvent("bank.worker_started", { scope: "bank", detail: { workerId, maxJobs: bounds.maxJobs, maxDurationMs: bounds.maxDurationMs } });

  let lastBatchSize = 1;
  let stoppedBecause: WorkerStopReason = "queue_empty";

  for (;;) {
    const step = nextWorkerStep({ jobsExecuted: jobs.length, lastBatchSize, elapsedMs: monotonic() - startedAt }, bounds);
    if (step.kind === "stop") {
      stoppedBecause = step.reason;
      break;
    }

    const claimed = await deps.store.claimNextJobs({ limit: step.limit, leaseSeconds, workerId });
    lastBatchSize = claimed.length;
    if (claimed.length === 0) {
      stoppedBecause = "queue_empty";
      break;
    }

    for (const job of claimed) {
      const jobStartedAt = monotonic();
      let outcome: SyncRunOutcome;
      try {
        outcome = await executeClaimedSyncRun(options.pageDeadline === undefined ? deps : { ...deps, deadline: options.pageDeadline }, {
          organizationId: job.organizationId,
          jobId: job.jobId,
          runId: job.runId,
          workerId,
        });
      } catch (error) {
        // The engine fails its own run for anything it can categorize. Landing
        // here means the store itself refused — the lease is left to expire and
        // be reclaimed rather than guessing at the job's state.
        reportError(error, { scope: "bank", organizationId: job.organizationId, detail: { step: "worker_execute", workerId, jobId: job.jobId, connectionId: job.connectionId } });
        outcome = { kind: "abandoned", jobId: job.jobId, runId: job.runId };
      }

      const result: WorkerJobResult = {
        jobId: job.jobId,
        connectionId: job.connectionId,
        organizationId: job.organizationId,
        trigger: job.trigger,
        attempt: job.attempt,
        outcome: workerOutcome(outcome),
        failureCategory: outcome.kind === "failed" ? outcome.category : null,
        continuationJobId: outcome.kind === "succeeded" ? outcome.continuationJobId : null,
        durationMs: monotonic() - jobStartedAt,
      };
      jobs.push(result);

      reportEvent(
        "bank.worker_job_finished",
        {
          scope: "bank",
          organizationId: job.organizationId,
          detail: {
            workerId,
            jobId: result.jobId,
            connectionId: result.connectionId,
            trigger: result.trigger,
            attempt: result.attempt,
            result: result.outcome,
            errorCategory: result.failureCategory,
            continuation: result.continuationJobId !== null,
            durationMs: result.durationMs,
          },
        },
        result.outcome === "failed" || result.outcome === "abandoned" ? "warning" : "info",
      );
    }
  }

  const finished = summary(stoppedBecause, true);
  reportEvent("bank.worker_finished", {
    scope: "bank",
    detail: {
      workerId,
      executed: finished.executed,
      succeeded: finished.succeeded,
      failed: finished.failed,
      retrying: finished.retrying,
      cancelled: finished.cancelled,
      abandoned: finished.abandoned,
      continuations: finished.continuations,
      stoppedBecause: finished.stoppedBecause,
      durationMs: finished.durationMs,
    },
  });
  return finished;
}

function workerOutcome(outcome: SyncRunOutcome): WorkerJobResult["outcome"] {
  switch (outcome.kind) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return outcome.jobStatus === "RETRYABLE" ? "retrying" : "failed";
    case "cancelled":
      return "cancelled";
    case "abandoned":
      return "abandoned";
    case "not_runnable":
    case "not_claimed":
    case "not_found":
      return "not_runnable";
  }
}

/**
 * Puts due work in the queue, and puts abandoned work back.
 *
 * Idempotent by construction: a scheduled job's idempotency key names the
 * interval window, so a second invocation in the same window is refused by the
 * unique key, and the one-active-job index refuses a second job for a
 * connection that is already syncing. Running this twice a minute creates no
 * more provider traffic than running it once.
 *
 * It never calls a provider and never writes a financial row — it only decides
 * what should be synced, and the worker does the syncing.
 */
export async function runBankSyncScheduler(deps: SyncDependencies, options: SchedulerOptions = {}): Promise<SchedulerRunSummary> {
  const startedAt = Date.now();
  const intervalSeconds = bounded(options.intervalSeconds, SCHEDULER_SYNC_INTERVAL_SECONDS, 60, 30 * 24 * 3600);
  const maxConnections = bounded(options.maxConnections, SCHEDULER_MAX_CONNECTIONS_PER_RUN, 1, 500);
  const maxReclaimed = bounded(options.maxReclaimed, SCHEDULER_MAX_RECLAIMED_PER_RUN, 1, 500);

  // First, jobs whose worker stopped without finishing. A job left RUNNING
  // with an expired lease blocks its connection (one active job per
  // connection), so this runs before anything is scheduled.
  let reclaimedLeases = 0;
  try {
    reclaimedLeases = await deps.store.reclaimExpiredLeases(maxReclaimed);
    if (reclaimedLeases > 0) reportEvent("bank.sync_leases_reclaimed", { scope: "bank", detail: { count: reclaimedLeases } }, "warning");
  } catch (error) {
    reportError(error, { scope: "bank", detail: { step: "reclaim_expired_leases" } });
  }

  // The queue as this invocation found it. Read-only, three indexed reads,
  // and never fatal: a scheduler that cannot measure its queue still
  // schedules. The measurement is what turns "the cron stopped" or "the
  // worker cannot keep up" from silence into a warning.
  let queue: WorkerQueueHealth | null = null;
  try {
    queue = await deps.store.queueHealth();
  } catch (error) {
    reportError(error, { scope: "bank", detail: { step: "queue_health" } }, "warning");
  }
  if (queue && isQueueUnhealthy(queue)) {
    reportEvent(
      "bank.worker_backlog",
      { scope: "bank", detail: { dueJobs: queue.dueJobs, oldestDueAgeSeconds: queue.oldestDueAgeSeconds, runningPastLease: queue.runningPastLease } },
      "warning",
    );
  }

  const summary: SchedulerRunSummary = {
    queue,
    reclaimedLeases,
    connectionsConsidered: 0,
    jobsCreated: 0,
    alreadyActive: 0,
    duplicates: 0,
    skipped: 0,
    durationMs: 0,
  };

  if (deps.providers.length === 0) {
    summary.durationMs = Date.now() - startedAt;
    reportEvent("bank.scheduler_skipped", { scope: "bank", detail: { reason: "provider_not_configured", reclaimedLeases } });
    return summary;
  }

  const due = await deps.store.listConnectionsDueForSync({ limit: maxConnections, minIntervalSeconds: intervalSeconds });
  summary.connectionsConsidered = due.length;
  const now = deps.now();

  for (const connection of due) {
    // A connection whose provider this deployment no longer configures is left
    // alone: queueing work nothing can run would only spend its attempts.
    if (!resolveBankProvider(deps.providers, connection.provider).available) {
      summary.skipped += 1;
      continue;
    }

    try {
      const enqueued = await deps.store.enqueueJob({
        organizationId: connection.organizationId,
        connectionId: connection.connectionId,
        trigger: "SCHEDULED",
        idempotencyKey: scheduledSyncIdempotencyKey(connection.connectionId, now, intervalSeconds),
        requestedBy: null,
        webhookEventId: null,
      });
      if (enqueued.outcome === "CREATED") summary.jobsCreated += 1;
      else if (enqueued.outcome === "ALREADY_ACTIVE") summary.alreadyActive += 1;
      else if (enqueued.outcome === "DUPLICATE") summary.duplicates += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.skipped += 1;
      reportError(error, { scope: "bank", organizationId: connection.organizationId, detail: { step: "schedule_sync", connectionId: connection.connectionId } });
    }
  }

  summary.durationMs = Date.now() - startedAt;
  reportEvent("bank.scheduler_finished", {
    scope: "bank",
    detail: {
      reclaimedLeases: summary.reclaimedLeases,
      dueJobs: queue?.dueJobs ?? null,
      oldestDueAgeSeconds: queue?.oldestDueAgeSeconds ?? null,
      considered: summary.connectionsConsidered,
      created: summary.jobsCreated,
      alreadyActive: summary.alreadyActive,
      duplicates: summary.duplicates,
      skipped: summary.skipped,
      intervalSeconds,
      durationMs: summary.durationMs,
    },
  });
  return summary;
}
