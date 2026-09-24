import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BankConnectionRow, BankLinkedAccountRow, BankSyncJobRow, Database, Json } from "@/types/database";
import type { ConnectionStatus, ExternalAccountType, ConnectionStatusReason, ImportMode, ReconciliationState, ReviewReason, SyncFailureCategory, SyncJobStatus, SyncTrigger } from "@/domain/bank-connections/types";
import {
  decisionPayload,
  ingestPayload,
  toManualCandidate,
  toReconciliationRow,
  type BankConnectionRecord,
  type BankStore,
  type BankSyncJobRecord,
  type DisconnectOutcome,
  type EnqueueOutcome,
  type ExternalDbRow,
  type HeartbeatOutcome,
  type IngestResult,
  type LedgerDbRow,
  type LinkedAccountDbRow,
  type LinkOutcome,
  type ReconcileOutcome,
  type ReconciliationRow,
  type TransitionOutcome,
} from "@/server/bank-connections/store";

type Client = SupabaseClient<Database>;

/**
 * Bank connections: the Supabase implementation of the store (service role),
 * and the member-facing reads (RLS-scoped client).
 *
 * THE TWO HALVES ARE DELIBERATELY DIFFERENT
 *
 * `createSupabaseBankStore` takes the admin client. It is called only from
 * server code that has already authorized the caller for `organizationId`, or
 * from a verified webhook, and every query it makes is scoped by organization
 * as well as by id — an id is never enough on its own.
 *
 * The `list…` reads below take the caller's own client and select only the
 * columns migration 0047 grants to members. Asking for a provider identifier,
 * a cursor or an idempotency key through that client is a permission error,
 * not an empty field.
 */

const CONNECTION_COLUMNS =
  "id, organization_id, provider, provider_connection_id, institution_name, status, status_reason, last_provider_event_at, consecutive_failed_runs, page_cursor, committed_cursor, last_successful_sync_at";

const JOB_COLUMNS = "id, organization_id, connection_id, status, trigger, attempts, max_attempts, next_attempt_at, lease_expires_at";

const RECONCILIATION_COLUMNS =
  "id, connection_id, linked_account_id, revision, status, direction, amount_minor, currency, transaction_date, merchant_name, description, category_hint, transfer_counterpart_id, reconciliation_state, review_reason, review_resolved_revision, ledger_transaction_id, ledger_link_kind, ledger_linked_at, ledger_written_account_id, ledger_written_kind, ledger_written_amount_minor, ledger_written_currency, ledger_written_occurred_on, ledger_written_description, created_at";

type ConnectionSelect = Pick<
  BankConnectionRow,
  "id" | "organization_id" | "provider" | "provider_connection_id" | "institution_name" | "status" | "status_reason" | "last_provider_event_at" | "consecutive_failed_runs" | "page_cursor" | "committed_cursor" | "last_successful_sync_at"
>;

function toConnection(row: ConnectionSelect): BankConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    provider: row.provider,
    providerConnectionId: row.provider_connection_id,
    institutionName: row.institution_name,
    status: row.status,
    statusReason: row.status_reason as ConnectionStatusReason,
    lastProviderEventAt: row.last_provider_event_at,
    consecutiveFailedRuns: row.consecutive_failed_runs,
    pageCursor: row.page_cursor,
    committedCursor: row.committed_cursor,
    lastSuccessfulSyncAt: row.last_successful_sync_at,
  };
}

type JobSelect = Pick<BankSyncJobRow, "id" | "organization_id" | "connection_id" | "status" | "trigger" | "attempts" | "max_attempts" | "next_attempt_at" | "lease_expires_at">;

function toJob(row: JobSelect): BankSyncJobRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    connectionId: row.connection_id,
    status: row.status as SyncJobStatus,
    trigger: row.trigger as SyncTrigger,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseExpiresAt: row.lease_expires_at,
  };
}

export function createSupabaseBankStore(admin: Client): BankStore {
  async function rowsForReconciliation(organizationId: string, externals: ExternalDbRow[]): Promise<ReconciliationRow[]> {
    if (externals.length === 0) return [];

    const linkIds = [...new Set(externals.map((external) => external.linked_account_id))];
    const links = await admin.from("bank_linked_accounts").select("id, import_mode, account_id, currency, detached_at").eq("organization_id", organizationId).in("id", linkIds);
    if (links.error) throw links.error;
    const linkById = new Map((links.data as LinkedAccountDbRow[]).map((link) => [link.id, link]));

    const accountIds = [...new Set((links.data as LinkedAccountDbRow[]).map((link) => link.account_id).filter((id): id is string => id !== null))];
    const accountById = new Map<string, { id: string; currency: string; kind?: string | null }>();
    if (accountIds.length > 0) {
      const accounts = await admin.from("accounts").select("id, currency, kind").eq("organization_id", organizationId).in("id", accountIds);
      if (accounts.error) throw accounts.error;
      for (const account of accounts.data) accountById.set(account.id, account);
    }

    const ledgerIds = externals.map((external) => external.ledger_transaction_id).filter((id): id is string => id !== null);
    const ledgerById = new Map<string, LedgerDbRow>();
    if (ledgerIds.length > 0) {
      const ledger = await admin.from("transactions").select("id, account_id, kind, amount_minor, currency, occurred_on, description, source").eq("organization_id", organizationId).in("id", ledgerIds);
      if (ledger.error) throw ledger.error;
      for (const row of ledger.data) ledgerById.set(row.id, row as LedgerDbRow);
    }

    return externals.flatMap((external) => {
      const link = linkById.get(external.linked_account_id);
      if (!link) return [];
      const account = link.account_id ? (accountById.get(link.account_id) ?? null) : null;
      const ledger = external.ledger_transaction_id ? (ledgerById.get(external.ledger_transaction_id) ?? null) : null;
      return [toReconciliationRow(external, link, account, ledger)];
    });
  }

  async function text(name: "bank_reconcile_transaction" | "bank_complete_sync_run" | "bank_transition_connection" | "bank_link_account" | "bank_finalize_disconnect" | "bank_complete_webhook_event", args: never): Promise<string> {
    const { data, error } = await admin.rpc(name, args);
    if (error) throw error;
    return String(data);
  }

  return {
    async getConnection(organizationId, connectionId) {
      const { data, error } = await admin.from("bank_connections").select(CONNECTION_COLUMNS).eq("id", connectionId).eq("organization_id", organizationId).maybeSingle();
      if (error) throw error;
      return data ? toConnection(data as ConnectionSelect) : null;
    },

    async findConnectionByProvider(provider, providerConnectionId) {
      const { data, error } = await admin.from("bank_connections").select(CONNECTION_COLUMNS).eq("provider", provider).eq("provider_connection_id", providerConnectionId).maybeSingle();
      if (error) throw error;
      return data ? toConnection(data as ConnectionSelect) : null;
    },

    async createConnection(input) {
      const { data, error } = await admin
        .from("bank_connections")
        .insert({
          organization_id: input.organizationId,
          provider: input.provider,
          provider_connection_id: input.providerConnectionId,
          institution_id: input.institutionId,
          institution_name: input.institutionName,
          provider_environment: input.providerEnvironment,
          created_by: input.createdBy,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id;
    },

    async storeCredentialRef(input) {
      const { error } = await admin.from("bank_connection_credentials").insert({ connection_id: input.connectionId, organization_id: input.organizationId, secret_ref: input.secretRef });
      if (error) throw error;
    },

    async getCredentialRef(organizationId, connectionId) {
      const { data, error } = await admin.from("bank_connection_credentials").select("secret_ref").eq("connection_id", connectionId).eq("organization_id", organizationId).maybeSingle();
      if (error) throw error;
      return data?.secret_ref ?? null;
    },

    async listCredentialRefs(organizationId) {
      const { data, error } = await admin.from("bank_connection_credentials").select("connection_id, secret_ref").eq("organization_id", organizationId).limit(1000);
      if (error) throw error;
      if (data.length === 0) return [];
      const connections = await admin.from("bank_connections").select("id, provider").eq("organization_id", organizationId).in("id", data.map((row) => row.connection_id));
      if (connections.error) throw connections.error;
      const providerById = new Map(connections.data.map((row) => [row.id, row.provider]));
      return data.map((row) => ({ connectionId: row.connection_id, provider: providerById.get(row.connection_id) ?? "unknown", secretRef: row.secret_ref }));
    },

    async getJob(organizationId, jobId) {
      const { data, error } = await admin.from("bank_sync_jobs").select(JOB_COLUMNS).eq("id", jobId).eq("organization_id", organizationId).maybeSingle();
      if (error) throw error;
      return data ? toJob(data as JobSelect) : null;
    },

    async getActiveJob(organizationId, connectionId) {
      const { data, error } = await admin.from("bank_sync_jobs").select(JOB_COLUMNS).eq("connection_id", connectionId).eq("organization_id", organizationId).in("status", ["QUEUED", "RUNNING", "RETRYABLE"]).maybeSingle();
      if (error) throw error;
      return data ? toJob(data as JobSelect) : null;
    },

    async enqueueJob(input) {
      const { data, error } = await admin.rpc("bank_enqueue_sync_job", {
        p_organization_id: input.organizationId,
        p_connection_id: input.connectionId,
        p_trigger: input.trigger,
        p_idempotency_key: input.idempotencyKey,
        p_requested_by: input.requestedBy,
        p_webhook_event_id: input.webhookEventId,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : null;
      return { jobId: row?.job_id ?? null, outcome: (row?.outcome ?? "NOT_FOUND") as EnqueueOutcome };
    },

    async claimJob(organizationId, jobId, leaseSeconds) {
      const { data, error } = await admin.rpc("bank_claim_sync_job", { p_organization_id: organizationId, p_job_id: jobId, p_lease_seconds: leaseSeconds });
      if (error) throw error;
      return typeof data === "string" ? data : null;
    },

    async claimNextJobs(input) {
      const { data, error } = await admin.rpc("bank_claim_next_sync_jobs", { p_limit: input.limit, p_lease_seconds: input.leaseSeconds, p_worker: input.workerId });
      if (error) throw error;
      return (data ?? []).map((row) => ({
        jobId: row.job_id,
        organizationId: row.organization_id,
        connectionId: row.connection_id,
        trigger: row.trigger as SyncTrigger,
        attempt: row.attempt,
        runId: row.run_id,
      }));
    },

    async heartbeatRun(input) {
      const { data, error } = await admin.rpc("bank_heartbeat_sync_job", {
        p_organization_id: input.organizationId,
        p_run_id: input.runId,
        p_worker: input.workerId,
        p_lease_seconds: input.leaseSeconds,
      });
      if (error) throw error;
      return (typeof data === "string" ? data : "NOT_FOUND") as HeartbeatOutcome;
    },

    async reclaimExpiredLeases(limit) {
      const { data, error } = await admin.rpc("bank_reclaim_expired_sync_leases", { p_limit: limit });
      if (error) throw error;
      return Number(data ?? 0);
    },

    async queueHealth() {
      const now = new Date();
      const nowIso = now.toISOString();
      const due = ["QUEUED", "RETRYABLE"] as const;
      // Three bounded reads, each served by an index from 0049: a head-only
      // count, and one row each for the oldest waiting QUEUED job and the
      // oldest RETRYABLE job that has become due.
      const [count, oldestQueued, oldestRetry, stuck] = await Promise.all([
        admin.from("bank_sync_jobs").select("id", { count: "exact", head: true }).in("status", [...due]).or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`),
        admin.from("bank_sync_jobs").select("created_at").eq("status", "QUEUED").is("next_attempt_at", null).order("created_at", { ascending: true }).limit(1),
        admin.from("bank_sync_jobs").select("next_attempt_at").in("status", [...due]).lte("next_attempt_at", nowIso).order("next_attempt_at", { ascending: true }).limit(1),
        admin.from("bank_sync_jobs").select("id", { count: "exact", head: true }).eq("status", "RUNNING").lt("lease_expires_at", nowIso),
      ]);
      for (const result of [count, oldestQueued, oldestRetry, stuck]) if (result.error) throw result.error;

      const since = [oldestQueued.data?.[0]?.created_at, oldestRetry.data?.[0]?.next_attempt_at].filter((value): value is string => typeof value === "string").map((value) => new Date(value).getTime());
      return {
        dueJobs: count.count ?? 0,
        oldestDueAgeSeconds: since.length > 0 ? Math.max(0, Math.round((now.getTime() - Math.min(...since)) / 1000)) : null,
        runningPastLease: stuck.count ?? 0,
      };
    },

    async listConnectionsDueForSync(input) {
      const { data, error } = await admin.rpc("bank_connections_due_for_sync", { p_limit: input.limit, p_min_interval_seconds: input.minIntervalSeconds });
      if (error) throw error;
      return (data ?? []).map((row) => ({ connectionId: row.connection_id, organizationId: row.organization_id, provider: row.provider }));
    },

    async completeRun(input) {
      return text("bank_complete_sync_run", {
        p_organization_id: input.organizationId,
        p_run_id: input.runId,
        p_outcome: input.outcome,
        p_failure_category: input.failureCategory,
        p_next_attempt_at: input.nextAttemptAt ? input.nextAttemptAt.toISOString() : null,
        p_counts_against_connection: input.countsAgainstConnection,
        p_duration_ms: Math.max(0, Math.round(input.durationMs)),
      } as never);
    },

    async ingestPage(input) {
      const payload = ingestPayload(input.page, input.hash);
      const { data, error } = await admin.rpc("bank_ingest_sync_page", {
        p_organization_id: input.organizationId,
        p_run_id: input.runId,
        p_cursor_before: input.cursorBefore,
        p_cursor_after: input.page.nextCursor,
        p_has_more: input.page.hasMore,
        p_accounts: payload.accounts as unknown as Json,
        p_transactions: payload.transactions as unknown as Json,
        p_removed: payload.removed,
        p_rejected: payload.rejected,
        p_lease_seconds: input.leaseSeconds,
      });
      if (error) throw error;
      return data as unknown as IngestResult;
    },

    async resetPageCursor(organizationId, connectionId) {
      const { error } = await admin.rpc("bank_reset_page_cursor", { p_organization_id: organizationId, p_connection_id: connectionId });
      if (error) throw error;
    },

    async listToReconcile(organizationId, connectionId, limit, after) {
      let query = admin
        .from("bank_external_transactions")
        .select(RECONCILIATION_COLUMNS)
        .eq("organization_id", organizationId)
        .eq("connection_id", connectionId)
        .eq("needs_reconciliation", true)
        .order("id", { ascending: true })
        .limit(Math.max(1, Math.min(limit, 100)));
      if (after) query = query.gt("id", after.id);
      const { data, error } = await query;
      if (error) throw error;
      return rowsForReconciliation(organizationId, data as unknown as ExternalDbRow[]);
    },

    async getReconciliationRow(organizationId, externalId) {
      const { data, error } = await admin.from("bank_external_transactions").select(RECONCILIATION_COLUMNS).eq("organization_id", organizationId).eq("id", externalId).maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return (await rowsForReconciliation(organizationId, [data as unknown as ExternalDbRow]))[0] ?? null;
    },

    async matchCandidates(organizationId, query) {
      const { data, error } = await admin.rpc("bank_match_candidates", {
        p_organization_id: organizationId,
        p_account_id: query.accountId,
        p_kind: query.kind,
        p_amount_minor: query.amountMinor,
        p_currency: query.currency,
        p_date_from: query.dateFrom,
        p_date_to: query.dateTo,
      });
      if (error) throw error;
      return (data ?? []).map(toManualCandidate);
    },

    async transferCandidates(organizationId, externalId) {
      const { data, error } = await admin.rpc("bank_transfer_candidates", { p_organization_id: organizationId, p_external_id: externalId });
      if (error) throw error;
      return (data ?? []).map((row: Record<string, unknown>) => ({
        id: String(row.id),
        organizationId: String(row.organization_id),
        linkedAccountId: String(row.linked_account_id),
        accountId: row.account_id ? String(row.account_id) : null,
        accountKind: (row.account_kind ?? null) as never,
        direction: row.direction as "DEBIT" | "CREDIT",
        amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
        currency: String(row.currency),
        transactionDate: String(row.transaction_date).slice(0, 10),
        status: row.status as never,
        categoryHint: row.category_hint ? String(row.category_hint) : null,
        reconciliationState: row.reconciliation_state as never,
        ledgerTransactionId: row.ledger_transaction_id ? String(row.ledger_transaction_id) : null,
        transferCounterpartId: row.transfer_counterpart_id ? String(row.transfer_counterpart_id) : null,
        importable: row.importable === true,
        revision: Number(row.revision),
      }));
    },

    async pairInternalTransfer(input) {
      const { data, error } = await admin.rpc("bank_pair_internal_transfer", {
        p_organization_id: input.organizationId,
        p_source_external_id: input.sourceExternalId,
        p_counterpart_external_id: input.counterpartExternalId,
        p_expected_source_revision: input.expectedSourceRevision,
        p_expected_counterpart_revision: input.expectedCounterpartRevision,
        p_run_id: input.runId,
        p_actor: input.actorId,
      });
      if (error) throw error;
      return String(data) as never;
    },

    async reconcile(input) {
      return (await text("bank_reconcile_transaction", {
        p_organization_id: input.organizationId,
        p_external_id: input.externalId,
        p_expected_revision: input.expectedRevision,
        p_decision: decisionPayload(input.decision, input.acknowledged),
        p_run_id: input.runId,
        p_actor: input.actorId,
        p_resolution: input.resolution,
      } as never)) as ReconcileOutcome;
    },

    async transitionConnection(input) {
      return (await text("bank_transition_connection", {
        p_organization_id: input.organizationId,
        p_connection_id: input.connectionId,
        p_expected_status: input.expectedStatus,
        p_to: input.to,
        p_reason: input.reason,
        p_event_at: input.eventAt,
      } as never)) as TransitionOutcome;
    },

    async finalizeDisconnect(organizationId, connectionId, actorId) {
      return (await text("bank_finalize_disconnect", { p_organization_id: organizationId, p_connection_id: connectionId, p_actor: actorId } as never)) as DisconnectOutcome;
    },

    async getLinkedAccount(organizationId, linkedAccountId) {
      const { data, error } = await admin
        .from("bank_linked_accounts")
        .select("id, connection_id, import_mode, account_id, detached_at, account_type, account_subtype")
        .eq("organization_id", organizationId)
        .eq("id", linkedAccountId)
        .maybeSingle();
      if (error) throw error;
      return data
        ? {
            id: data.id,
            connectionId: data.connection_id,
            importMode: data.import_mode as ImportMode,
            accountId: data.account_id,
            detached: data.detached_at !== null,
            accountType: data.account_type as ExternalAccountType,
            accountSubtype: data.account_subtype,
          }
        : null;
    },

    async getAccountKind(organizationId, accountId) {
      const { data, error } = await admin.from("accounts").select("kind").eq("organization_id", organizationId).eq("id", accountId).maybeSingle();
      if (error) throw error;
      return data?.kind ?? null;
    },

    async autoImportAccounts(organizationId, connectionId) {
      const { data, error } = await admin.rpc("bank_auto_import_accounts", { p_organization_id: organizationId, p_connection_id: connectionId });
      if (error) throw error;
      return Number(data ?? 0);
    },

    async importLinkedAccount(input) {
      const { data, error } = await admin.rpc("bank_import_linked_account", { p_organization_id: input.organizationId, p_linked_account_id: input.linkedAccountId, p_actor: input.actorId });
      if (error) throw error;
      return String(data) as LinkOutcome;
    },

    async anchorAccountBalances(organizationId, connectionId) {
      const { data, error } = await admin.rpc("bank_anchor_account_balances", { p_organization_id: organizationId, p_connection_id: connectionId });
      if (error) throw error;
      return Number(data ?? 0);
    },

    async linkAccount(input) {
      return (await text("bank_link_account", {
        p_organization_id: input.organizationId,
        p_linked_account_id: input.linkedAccountId,
        p_account_id: input.accountId,
        p_import_mode: input.importMode,
        p_actor: input.actorId,
      } as never)) as LinkOutcome;
    },

    async claimWebhookEvent(input) {
      const { data, error } = await admin.rpc("bank_claim_webhook_event", {
        p_provider: input.provider,
        p_provider_event_id: input.providerEventId,
        p_event_type: input.eventType,
        p_provider_event_type: input.providerEventType,
        p_provider_connection_id: input.providerConnectionId,
        p_occurred_at: input.occurredAt,
        p_payload_sha256: input.payloadSha256,
        p_lease_seconds: input.leaseSeconds,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : null;
      if (!row) throw new Error("bank_claim_webhook_event returned no row");
      return { eventId: row.event_id, claimed: row.claimed, status: row.status as never, payloadMatches: row.payload_matches };
    },

    async completeWebhookEvent(input) {
      return text("bank_complete_webhook_event", {
        p_event_id: input.eventId,
        p_status: input.status,
        p_outcome: input.outcome,
        p_failure_category: input.status === "FAILED" ? "INTERNAL_ERROR" : null,
        p_organization_id: input.organizationId,
        p_connection_id: input.connectionId,
      } as never);
    },
  };
}

// ── Member reads (RLS-scoped client, granted columns only) ──────────────

export interface BankConnectionView {
  id: string;
  provider: string;
  institutionName: string | null;
  /** Plaid: "sandbox" | "production". Shown, so fictional sandbox data can
   *  never be mistaken for somebody's real money. */
  providerEnvironment: string | null;
  status: ConnectionStatus;
  statusReason: ConnectionStatusReason;
  statusChangedAt: string;
  consecutiveFailedRuns: number;
  lastFailureCategory: SyncFailureCategory | null;
  lastSuccessfulSyncAt: string | null;
  lastSyncAttemptAt: string | null;
  disconnectedAt: string | null;
  createdAt: string;
}

export async function listBankConnections(client: Client, organizationId: string): Promise<BankConnectionView[]> {
  const { data, error } = await client
    .from("bank_connections")
    .select(
      "id, provider, institution_name, provider_environment, status, status_reason, status_changed_at, consecutive_failed_runs, last_failure_category, last_successful_sync_at, last_sync_attempt_at, disconnected_at, created_at",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data as unknown as BankConnectionRow[]).map((row) => ({
    id: row.id,
    provider: row.provider,
    institutionName: row.institution_name,
    providerEnvironment: row.provider_environment,
    status: row.status,
    statusReason: row.status_reason as ConnectionStatusReason,
    statusChangedAt: row.status_changed_at,
    consecutiveFailedRuns: row.consecutive_failed_runs,
    lastFailureCategory: row.last_failure_category as SyncFailureCategory | null,
    lastSuccessfulSyncAt: row.last_successful_sync_at,
    lastSyncAttemptAt: row.last_sync_attempt_at,
    disconnectedAt: row.disconnected_at,
    createdAt: row.created_at,
  }));
}

export interface LinkedAccountView {
  id: string;
  connectionId: string;
  accountId: string | null;
  importMode: ImportMode;
  accountType: BankLinkedAccountRow["account_type"];
  accountSubtype: string | null;
  displayName: string;
  mask: string | null;
  currency: string | null;
  currentBalanceMinor: number | null;
  availableBalanceMinor: number | null;
  balancesAsOf: string | null;
  providerState: "OPEN" | "CLOSED";
  detached: boolean;
}

export async function listLinkedAccounts(client: Client, organizationId: string, connectionIds: string[]): Promise<LinkedAccountView[]> {
  if (connectionIds.length === 0) return [];
  const { data, error } = await client
    .from("bank_linked_accounts")
    .select("id, connection_id, account_id, import_mode, account_type, account_subtype, display_name, mask, currency, current_balance_minor, available_balance_minor, balances_as_of, provider_state, detached_at")
    .eq("organization_id", organizationId)
    .in("connection_id", connectionIds)
    .order("display_name")
    .limit(1000);
  if (error) throw error;
  return (data as unknown as BankLinkedAccountRow[]).map((row) => ({
    id: row.id,
    connectionId: row.connection_id,
    accountId: row.account_id,
    importMode: row.import_mode,
    accountType: row.account_type,
    accountSubtype: row.account_subtype,
    displayName: row.display_name,
    mask: row.mask,
    currency: row.currency,
    currentBalanceMinor: row.current_balance_minor === null ? null : Number(row.current_balance_minor),
    availableBalanceMinor: row.available_balance_minor === null ? null : Number(row.available_balance_minor),
    balancesAsOf: row.balances_as_of,
    providerState: row.provider_state,
    detached: row.detached_at !== null,
  }));
}

export interface SyncJobView {
  id: string;
  connectionId: string;
  status: SyncJobStatus;
  trigger: SyncTrigger;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  failureCategory: SyncFailureCategory | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** The newest job for each connection. Bounded: a handful of rows per connection. */
export async function listLatestSyncJobs(client: Client, organizationId: string, connectionIds: string[]): Promise<Map<string, SyncJobView>> {
  const latest = new Map<string, SyncJobView>();
  if (connectionIds.length === 0) return latest;
  const { data, error } = await client
    .from("bank_sync_jobs")
    .select("id, connection_id, status, trigger, attempts, max_attempts, next_attempt_at, failure_category, started_at, completed_at, created_at")
    .eq("organization_id", organizationId)
    .in("connection_id", connectionIds)
    .order("created_at", { ascending: false })
    .limit(Math.min(connectionIds.length * 5, 500));
  if (error) throw error;
  for (const row of data as unknown as BankSyncJobRow[]) {
    if (latest.has(row.connection_id)) continue;
    latest.set(row.connection_id, {
      id: row.id,
      connectionId: row.connection_id,
      status: row.status,
      trigger: row.trigger,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      nextAttemptAt: row.next_attempt_at,
      failureCategory: row.failure_category as SyncFailureCategory | null,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    });
  }
  return latest;
}

export async function countExternalTransactions(client: Client, organizationId: string, connectionId: string, state?: ReconciliationState): Promise<number> {
  let query = client.from("bank_external_transactions").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("connection_id", connectionId);
  if (state) query = query.eq("reconciliation_state", state);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

export interface ReviewItemView {
  id: string;
  connectionId: string;
  linkedAccountId: string;
  status: string;
  direction: "DEBIT" | "CREDIT";
  amountMinor: number | null;
  amountDecimal: string;
  currency: string;
  transactionDate: string;
  merchantName: string | null;
  description: string | null;
  reviewReason: ReviewReason;
  ledgerTransactionId: string | null;
}

export async function listReviewItems(client: Client, organizationId: string, limit = 50): Promise<ReviewItemView[]> {
  const { data, error } = await client
    .from("bank_external_transactions")
    .select("id, connection_id, linked_account_id, status, direction, amount_minor, amount_decimal, currency, transaction_date, merchant_name, description, review_reason, ledger_transaction_id")
    .eq("organization_id", organizationId)
    .eq("reconciliation_state", "NEEDS_REVIEW")
    .order("transaction_date", { ascending: false })
    .limit(Math.min(limit, 200));
  if (error) throw error;
  return (data as unknown as ReviewItemRow[]).map((row) => ({
    id: row.id,
    connectionId: row.connection_id,
    linkedAccountId: row.linked_account_id,
    status: row.status,
    direction: row.direction,
    amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
    amountDecimal: row.amount_decimal,
    currency: row.currency,
    transactionDate: row.transaction_date,
    merchantName: row.merchant_name,
    description: row.description,
    reviewReason: row.review_reason as ReviewReason,
    ledgerTransactionId: row.ledger_transaction_id,
  }));
}

type ReviewItemRow = {
  id: string;
  connection_id: string;
  linked_account_id: string;
  status: string;
  direction: "DEBIT" | "CREDIT";
  amount_minor: number | null;
  amount_decimal: string;
  currency: string;
  transaction_date: string;
  merchant_name: string | null;
  description: string | null;
  review_reason: string;
  ledger_transaction_id: string | null;
};

/** Countorra accounts currently fed by a live bank account, for the Accounts page. */
/** What the accounts page shows about the bank connection feeding an account. */
export interface BankFeed {
  displayName: string;
  mask: string | null;
  institutionName: string | null;
  connectionStatus: string;
  lastSuccessfulSyncAt: string | null;
}

/**
 * Accounts an ACTIVE bank link imports into (import mode IMPORT, not
 * detached) — the same definition the database uses for "connected"
 * (account_accepts_manual_entry, 0053) — with the connection's state. Read
 * under the caller's RLS; no provider identifier or cursor leaves this query.
 */
export async function listBankFedAccounts(client: Client, organizationId: string): Promise<Map<string, BankFeed>> {
  const { data, error } = await client
    .from("bank_linked_accounts")
    .select("account_id, connection_id, display_name, mask")
    .eq("organization_id", organizationId)
    .eq("import_mode", "IMPORT")
    .not("account_id", "is", null)
    .is("detached_at", null)
    .limit(500);
  if (error) throw error;
  const links = data as unknown as { account_id: string; connection_id: string; display_name: string; mask: string | null }[];
  if (links.length === 0) return new Map();

  const { data: connections, error: connectionError } = await client
    .from("bank_connections")
    .select("id, institution_name, status, last_successful_sync_at")
    .eq("organization_id", organizationId)
    .in("id", [...new Set(links.map((l) => l.connection_id))]);
  if (connectionError) throw connectionError;
  const byId = new Map(
    (connections as unknown as { id: string; institution_name: string | null; status: string; last_successful_sync_at: string | null }[]).map((c) => [c.id, c]),
  );

  return new Map(
    links.map((row) => {
      const connection = byId.get(row.connection_id);
      return [
        row.account_id,
        {
          displayName: row.display_name,
          mask: row.mask,
          institutionName: connection?.institution_name ?? null,
          connectionStatus: connection?.status ?? "ERROR",
          lastSuccessfulSyncAt: connection?.last_successful_sync_at ?? null,
        },
      ];
    }),
  );
}
