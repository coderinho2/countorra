import { failureCountsAgainstConnection, nextConnectionStatus, type ConnectionEvent } from "@/domain/bank-connections/lifecycle";
import { normalizeTransactionsPage } from "@/domain/bank-connections/normalization";
import { MAX_PAGE_SIZE, providerTransactionsPageSchema, resolveBankProvider, runBankProviderCall, type BankConnectionProvider, type ProviderSecretStore } from "@/domain/bank-connections/provider";
import { decideReconciliation } from "@/domain/bank-connections/reconciliation";
import { MAX_PAGES_PER_RUN, MAX_RECONCILED_PER_RUN, RECONCILE_BATCH_SIZE, SYNC_LEASE_SECONDS, decideSyncFailure, jobRunnability, syncIdempotencyKey } from "@/domain/bank-connections/sync-job";
import type { SyncFailureCategory } from "@/domain/bank-connections/types";
import { reportError, reportEvent } from "@/lib/observability";
import type { BankConnectionRecord, BankStore, ReconcileCursor } from "./store";

/**
 * THE SYNC ENGINE.
 *
 *   job QUEUED ─▶ claim (RUNNING + run row, one transaction)
 *     ─▶ credential from the secret store ─▶ provider page (bounded, timed out)
 *     ─▶ validate ─▶ normalize ─▶ ingest page + move cursor (one transaction)
 *     ─▶ reconcile changed rows in bounded batches ─▶ … next page
 *     ─▶ complete run and job ─▶ connection status from the lifecycle rules
 *
 * WHO CALLS THIS
 *
 * `runBankSyncJob` takes a job id and no user session — an inline refresh uses
 * it. The worker (src/server/bank-connections/worker.ts) claims a batch of due
 * jobs with `bank_claim_next_sync_jobs` and calls `executeClaimedSyncRun` for
 * each, so a job is claimed exactly once however many workers are running.
 * Nothing about a run depends on who asked for it.
 *
 * MEMORY
 *
 * Nothing is ever loaded without a bound: one provider page (≤ MAX_PAGE_SIZE),
 * one reconciliation batch (≤ RECONCILE_BATCH_SIZE), at most MAX_PAGES_PER_RUN
 * pages and MAX_RECONCILED_PER_RUN reconciliations per run. A longer backlog
 * continues in a CONTINUATION job.
 *
 * WHAT NEVER LEAVES THIS FILE
 *
 * Observability records ids, the provider name, statuses, durations and counts.
 * Never a credential, a cursor, an amount, a merchant, a description or a
 * provider's own message.
 */

export interface SystemAuditEvent {
  organizationId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface SyncDependencies {
  store: BankStore;
  providers: readonly BankConnectionProvider[];
  secrets: ProviderSecretStore | null;
  now: () => Date;
  hash: (value: string) => string;
  audit?: (event: SystemAuditEvent) => Promise<void>;
  providerTimeoutMs?: number;
  maxPages?: number;
  /**
   * Wall-clock time (epoch ms) after which no NEW provider page is started.
   * The page in flight still finishes; the backlog continues in a
   * CONTINUATION job exactly as it does at `maxPages`. This is what keeps one
   * large sync inside a serverless function's time limit instead of being
   * killed mid-page and retried from the same point until its attempts run
   * out. Unset means "no deadline" — the inline refresh path.
   */
  deadline?: number;
}

export interface SyncCounts {
  pages: number;
  added: number;
  modified: number;
  unchanged: number;
  removed: number;
  rejected: number;
  imported: number;
  matched: number;
  updated: number;
  flagged: number;
  reconciled: number;
  /** Countorra accounts created from accounts the bank reported (0054). */
  accountsImported: number;
  /** Countorra-created accounts whose balance was re-anchored to the bank's. */
  balancesAnchored: number;
}

export type SyncRunOutcome =
  | { kind: "not_found" }
  | { kind: "not_runnable"; reason: "not_due" | "in_progress" | "finished" }
  | { kind: "not_claimed" }
  | { kind: "succeeded"; jobId: string; runId: string; counts: SyncCounts; hasMore: boolean; continuationJobId: string | null }
  | { kind: "failed"; jobId: string; runId: string; category: SyncFailureCategory; jobStatus: string }
  | { kind: "cancelled"; jobId: string; runId: string }
  | { kind: "abandoned"; jobId: string; runId: string };

const emptyCounts = (): SyncCounts => ({ pages: 0, added: 0, modified: 0, unchanged: 0, removed: 0, rejected: 0, imported: 0, matched: 0, updated: 0, flagged: 0, reconciled: 0, accountsImported: 0, balancesAnchored: 0 });

/**
 * Claims a job by id and runs it. The entry point a request uses (an inline
 * refresh) and the one Task 11 documented. A worker does not use this: it has
 * already claimed its jobs in a batch, and calls `executeClaimedSyncRun`.
 */
export async function runBankSyncJob(deps: SyncDependencies, input: { organizationId: string; jobId: string }): Promise<SyncRunOutcome> {
  const job = await deps.store.getJob(input.organizationId, input.jobId);
  if (!job) return { kind: "not_found" };

  const runnable = jobRunnability(job, deps.now());
  if (runnable.kind === "not_due" || runnable.kind === "in_progress" || runnable.kind === "finished") return { kind: "not_runnable", reason: runnable.kind };

  const connection = await deps.store.getConnection(input.organizationId, job.connectionId);
  if (!connection) return { kind: "not_found" };

  const runId = await deps.store.claimJob(input.organizationId, job.id, SYNC_LEASE_SECONDS);
  if (!runId) return { kind: "not_claimed" };

  return executeClaimedSyncRun(deps, { organizationId: input.organizationId, jobId: job.id, runId, workerId: null });
}

/**
 * Runs a job that has ALREADY been claimed — the run row exists and the lease
 * is held by `workerId` (null for an inline run).
 *
 * `runId` is the fence. It is the job's current attempt, and every write below
 * goes through a SQL function that refuses a run which is no longer that
 * attempt. So a worker whose lease expired and was reclaimed cannot ingest a
 * page, move a cursor or complete a run behind the worker that now owns the
 * job: its writes are rejected and it reports `abandoned`. The heartbeat below
 * makes it notice that BEFORE it calls the provider again.
 */
export async function executeClaimedSyncRun(
  deps: SyncDependencies,
  input: { organizationId: string; jobId: string; runId: string; workerId: string | null },
): Promise<SyncRunOutcome> {
  const runId = input.runId;
  const job = await deps.store.getJob(input.organizationId, input.jobId);
  if (!job) return { kind: "not_found" };
  // The job was claimed a moment ago, so RUNNING is the only state it can be
  // in. Anything else means this run has already been taken away (a sweep, a
  // cancellation) — and the point of checking is to stop BEFORE the first
  // provider call, not to discover it at the ingest that gets rejected.
  if (job.status !== "RUNNING") return { kind: "abandoned", jobId: job.id, runId };
  const connection = await deps.store.getConnection(input.organizationId, job.connectionId);
  if (!connection) return { kind: "not_found" };

  const started = Date.now();
  const claimed = job;
  const counts = emptyCounts();
  const detail = { connectionId: connection.id, jobId: job.id, runId, provider: connection.provider, trigger: job.trigger, attempt: claimed.attempts, workerId: input.workerId };
  reportEvent("bank.sync_started", { scope: "bank", organizationId: input.organizationId, detail });

  const fail = async (category: SyncFailureCategory): Promise<SyncRunOutcome> => {
    const decision = decideSyncFailure({ attempts: claimed.attempts, maxAttempts: claimed.maxAttempts }, category, deps.now());
    const counted = failureCountsAgainstConnection(category);
    let jobStatus = "FAILED";
    try {
      jobStatus = await deps.store.completeRun({
        organizationId: input.organizationId,
        runId,
        outcome: "FAILED",
        failureCategory: category,
        nextAttemptAt: decision.status === "RETRYABLE" ? decision.nextAttemptAt : null,
        countsAgainstConnection: counted,
        durationMs: Date.now() - started,
      });
      await applyConnectionEvent(deps, connection, { kind: "SYNC_FAILED", category, consecutiveFailures: connection.consecutiveFailedRuns + (counted ? 1 : 0) }, null);
    } catch (error) {
      reportError(error, { scope: "bank", organizationId: input.organizationId, detail: { step: "complete_failed_run", ...detail } });
    }
    reportEvent("bank.sync_failed", { scope: "bank", organizationId: input.organizationId, detail: { ...detail, errorCategory: category, jobStatus, durationMs: Date.now() - started } }, "warning");
    return { kind: "failed", jobId: job.id, runId, category, jobStatus };
  };

  const availability = resolveBankProvider(deps.providers, connection.provider);
  if (!availability.available) return fail("PROVIDER_NOT_CONFIGURED");
  const { provider } = availability;

  const secretRef = await deps.store.getCredentialRef(input.organizationId, connection.id);
  let secret = null;
  if (secretRef && deps.secrets) {
    try {
      secret = await deps.secrets.get(secretRef);
    } catch {
      secret = null;
    }
  }
  if (!secret) return fail("CREDENTIAL_UNAVAILABLE");

  let cursor = connection.pageCursor;
  let hasMore = false;
  const maxPages = Math.max(1, Math.min(deps.maxPages ?? MAX_PAGES_PER_RUN, MAX_PAGES_PER_RUN));
  const reconcileBudget = { remaining: MAX_RECONCILED_PER_RUN };

  try {
    for (let page = 0; page < maxPages; page++) {
      // Before the next provider call, confirm this run still owns the job.
      // A worker that has lost its lease stops here — no provider call, no
      // write — rather than discovering it at the ingest that gets rejected.
      if (page > 0) {
        // Out of time for another provider call: stop cleanly with the cursor
        // committed. `hasMore` is still true from the page just applied, so a
        // continuation job picks up exactly here.
        if (deps.deadline !== undefined && Date.now() >= deps.deadline) {
          reportEvent("bank.sync_deadline_reached", { scope: "bank", organizationId: input.organizationId, detail: { ...detail, pages: counts.pages } });
          break;
        }
        const beat = await deps.store.heartbeatRun({ organizationId: input.organizationId, runId, workerId: input.workerId, leaseSeconds: SYNC_LEASE_SECONDS });
        if (beat !== "EXTENDED") {
          reportEvent("bank.sync_lease_lost", { scope: "bank", organizationId: input.organizationId, detail: { ...detail, heartbeat: beat, pages: counts.pages } }, "warning");
          return { kind: "abandoned", jobId: job.id, runId };
        }
      }

      const fetched = await runBankProviderCall(
        (signal) => provider.fetchTransactions({ secret: secret!, cursor, pageSize: MAX_PAGE_SIZE, signal, includeAccounts: page === 0 }),
        providerTransactionsPageSchema,
        deps.providerTimeoutMs,
        "sync_transactions",
      );
      if (!fetched.ok) {
        if (fetched.category === "CURSOR_RESET_REQUIRED") await deps.store.resetPageCursor(input.organizationId, connection.id);
        return fail(fetched.category);
      }

      const normalized = normalizeTransactionsPage(fetched.value);
      const ingested = await deps.store.ingestPage({ organizationId: input.organizationId, runId, cursorBefore: cursor, page: normalized, leaseSeconds: SYNC_LEASE_SECONDS, hash: deps.hash });
      if (ingested.outcome !== "APPLIED") {
        if (ingested.outcome === "RUN_NOT_ACTIVE") return { kind: "abandoned", jobId: job.id, runId };
        if (ingested.outcome === "CONNECTION_DISCONNECTED") {
          await deps.store.completeRun({ organizationId: input.organizationId, runId, outcome: "CANCELLED", failureCategory: null, nextAttemptAt: null, countsAgainstConnection: false, durationMs: Date.now() - started });
          return { kind: "cancelled", jobId: job.id, runId };
        }
        return fail("CURSOR_CONFLICT");
      }

      counts.pages += 1;
      counts.added += ingested.added;
      counts.modified += ingested.modified;
      counts.unchanged += ingested.unchanged;
      counts.removed += ingested.removed;
      counts.rejected += ingested.rejected;

      // Plaid-first (0054): every supported account the bank just reported
      // gets its Countorra account now — before this page's transactions are
      // reconciled, so they land in the ledger in this same run.
      counts.accountsImported += await deps.store.autoImportAccounts(input.organizationId, connection.id);

      addCounts(counts, await reconcileConnection(deps, { organizationId: input.organizationId, connectionId: connection.id, runId, budget: reconcileBudget }));

      cursor = normalized.nextCursor;
      hasMore = normalized.hasMore;
      if (!hasMore) break;
    }
  } catch (error) {
    reportError(error, { scope: "bank", organizationId: input.organizationId, detail: { step: "sync_page", ...detail } });
    return fail("INTERNAL_ERROR");
  }

  // Once the provider has nothing more for now, the balances of the accounts
  // Countorra created are re-anchored to the bank's current balance (0054).
  // Not mid-history: a continuation would only undo it. A failure here does
  // not fail the sync — the transactions are in, and the next run anchors.
  if (!hasMore) {
    try {
      counts.balancesAnchored += await deps.store.anchorAccountBalances(input.organizationId, connection.id);
    } catch (error) {
      reportError(error, { scope: "bank", organizationId: input.organizationId, detail: { step: "anchor_balances", ...detail } });
    }
  }

  const completed = await deps.store.completeRun({ organizationId: input.organizationId, runId, outcome: "SUCCEEDED", failureCategory: null, nextAttemptAt: null, countsAgainstConnection: false, durationMs: Date.now() - started });
  if (completed === "RUN_NOT_ACTIVE") return { kind: "abandoned", jobId: job.id, runId };
  await applyConnectionEvent(deps, connection, { kind: "SYNC_SUCCEEDED" }, null);

  let continuationJobId: string | null = null;
  if (hasMore) {
    const continuation = await deps.store.enqueueJob({
      organizationId: input.organizationId,
      connectionId: connection.id,
      trigger: "CONTINUATION",
      idempotencyKey: syncIdempotencyKey({ connectionId: connection.id, trigger: "CONTINUATION", reference: job.id }),
      requestedBy: null,
      webhookEventId: null,
    });
    continuationJobId = continuation.jobId;
  }

  reportEvent("bank.sync_completed", {
    scope: "bank",
    organizationId: input.organizationId,
    detail: {
      ...detail,
      pages: counts.pages,
      transactionsAdded: counts.added,
      transactionsModified: counts.modified,
      transactionsUnchanged: counts.unchanged,
      transactionsRemoved: counts.removed,
      transactionsRejected: counts.rejected,
      ledgerImported: counts.imported,
      ledgerMatched: counts.matched,
      ledgerUpdated: counts.updated,
      flaggedForReview: counts.flagged,
      accountsImported: counts.accountsImported,
      balancesAnchored: counts.balancesAnchored,
      hasMore,
      durationMs: Date.now() - started,
    },
  });

  return { kind: "succeeded", jobId: job.id, runId, counts, hasMore, continuationJobId };
}

function addCounts(target: SyncCounts, source: Partial<SyncCounts>): void {
  for (const [key, value] of Object.entries(source)) target[key as keyof SyncCounts] += value ?? 0;
}

/**
 * Reconciles every changed external transaction of a connection, in bounded
 * batches, walking forward so a row that cannot be applied this time (a lost
 * race, a stale revision) is passed over rather than retried in a loop. It
 * stays marked and is picked up by the next run.
 */
export async function reconcileConnection(
  deps: Pick<SyncDependencies, "store">,
  input: { organizationId: string; connectionId: string; runId: string | null; budget: { remaining: number } },
): Promise<Pick<SyncCounts, "imported" | "matched" | "updated" | "flagged" | "reconciled">> {
  const counts = { imported: 0, matched: 0, updated: 0, flagged: 0, reconciled: 0 };
  let after: ReconcileCursor | null = null;

  while (input.budget.remaining > 0) {
    const rows = await deps.store.listToReconcile(input.organizationId, input.connectionId, Math.min(RECONCILE_BATCH_SIZE, input.budget.remaining), after);
    if (rows.length === 0) break;

    for (const row of rows) {
      input.budget.remaining -= 1;
      let decision = decideReconciliation({ ...row, candidates: null });
      if (decision.kind === "NEEDS_CANDIDATES") {
        const candidates = await deps.store.matchCandidates(input.organizationId, decision.query);
        decision = decideReconciliation({ ...row, candidates });
      }
      if (decision.kind === "NEEDS_CANDIDATES") continue;

      const outcome = await deps.store.reconcile({
        organizationId: input.organizationId,
        externalId: row.external.id,
        expectedRevision: row.external.revision,
        decision,
        acknowledged: decision.kind === "MATCH" ? decision.acknowledged : null,
        runId: input.runId,
        actorId: null,
        resolution: false,
      });

      if (outcome === "LEDGER_EDITED") {
        // A person edited the ledger row between the read and the write. Their
        // edit wins; the bank's change waits for them.
        const flagged = await deps.store.reconcile({
          organizationId: input.organizationId,
          externalId: row.external.id,
          expectedRevision: row.external.revision,
          decision: { kind: "SET_STATE", state: "NEEDS_REVIEW", reviewReason: "PROVIDER_CHANGED_AFTER_EDIT" },
          acknowledged: null,
          runId: input.runId,
          actorId: null,
          resolution: false,
        });
        if (flagged === "APPLIED") counts.flagged += 1;
        continue;
      }
      if (outcome !== "APPLIED") {
        if (outcome === "INVALID") {
          reportEvent("bank.reconciliation_refused", { scope: "bank", organizationId: input.organizationId, detail: { connectionId: input.connectionId, externalId: row.external.id, decision: decision.kind } }, "warning");
        }
        continue;
      }

      counts.reconciled += 1;
      if (decision.kind === "IMPORT") counts.imported += 1;
      else if (decision.kind === "MATCH") counts.matched += 1;
      else if (decision.kind === "UPDATE_LEDGER") counts.updated += 1;
      else if (decision.state === "NEEDS_REVIEW" && row.external.reconciliationState !== "NEEDS_REVIEW") counts.flagged += 1;
    }

    const last = rows[rows.length - 1];
    after = { id: last.external.id };
    if (rows.length < RECONCILE_BATCH_SIZE) break;
  }

  return counts;
}

/** Applies a lifecycle event to a connection, conditionally on the status the
 *  caller read, and audits a real change. */
export async function applyConnectionEvent(
  deps: Pick<SyncDependencies, "store" | "audit">,
  connection: Pick<BankConnectionRecord, "id" | "organizationId" | "status" | "provider">,
  event: ConnectionEvent,
  eventAt: string | null,
): Promise<"APPLIED" | "NO_CHANGE" | "STALE" | "CONFLICT"> {
  const decision = nextConnectionStatus(connection.status, event);
  if (decision.kind !== "transition") return "NO_CHANGE";
  const outcome = await deps.store.transitionConnection({
    organizationId: connection.organizationId,
    connectionId: connection.id,
    expectedStatus: decision.from,
    to: decision.to,
    reason: decision.reason,
    eventAt,
  });
  if (outcome === "STALE") return "STALE";
  if (outcome !== "APPLIED") return outcome === "UNCHANGED" ? "NO_CHANGE" : "CONFLICT";

  reportEvent("bank.connection_status_changed", { scope: "bank", organizationId: connection.organizationId, detail: { connectionId: connection.id, provider: connection.provider, from: decision.from, to: decision.to, reason: decision.reason } });
  await deps.audit?.({
    organizationId: connection.organizationId,
    action: "bank_connection.status_changed",
    resourceType: "bank_connection",
    resourceId: connection.id,
    metadata: { from: decision.from, to: decision.to, reason: decision.reason },
  });
  return "APPLIED";
}
