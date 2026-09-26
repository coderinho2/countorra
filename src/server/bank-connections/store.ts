import type { TransferSide } from "@/domain/bank-connections/internal-transfers";
import type { NormalizedPage } from "@/domain/bank-connections/normalization";
import type { SyncJobSnapshot } from "@/domain/bank-connections/sync-job";
import type { WorkerQueueHealth } from "@/domain/bank-connections/worker";
import type {
  CandidateQuery,
  ExternalForReconciliation,
  LedgerFields,
  LedgerRowForReconciliation,
  ManualCandidate,
  ReconciliationDecision,
  ReconciliationInput,
  WrittenLedgerFields,
} from "@/domain/bank-connections/reconciliation";
import type {
  ConnectionStatus,
  ConnectionStatusReason,
  Direction,
  ExternalTransactionStatus,
  ImportMode,
  ReconciliationState,
  ReviewReason,
  SyncFailureCategory,
  SyncTrigger,
  WebhookEventStatus,
  WebhookEventType,
  WebhookOutcome,
  ExternalAccountType,
} from "@/domain/bank-connections/types";

/**
 * THE PERSISTENCE PORT FOR BANK CONNECTIONS.
 *
 * The sync engine, webhook ingestion and every service talk to this interface,
 * never to a query builder. Two implementations exist and run the SAME SQL
 * functions from migration 0047:
 *
 *   * src/server/db/repositories/bank-connections.ts — the Supabase service-role
 *     client, used in production;
 *   * tests/fixtures/bank-store-pglite.ts — real Postgres in-process, used by the
 *     engine tests.
 *
 * So the engine's behaviour against the database is tested against the real
 * database functions, not against a mock of them.
 *
 * Every method that writes is service-role only. Callers authorize first.
 */

export interface BankConnectionRecord {
  id: string;
  organizationId: string;
  provider: string;
  providerConnectionId: string;
  /**
   * Which of the provider's environments this connection was made in (Plaid:
   * "sandbox" | "production"), stamped at link time and immutable thereafter.
   * `null` for connections created before migration 0048 recorded it.
   *
   * Read by the sync path to refuse a connection whose environment is not the
   * one now configured (`environmentMatches`), so this is a safety input, not
   * a display field.
   */
  providerEnvironment: string | null;
  institutionName: string | null;
  status: ConnectionStatus;
  statusReason: ConnectionStatusReason;
  lastProviderEventAt: string | null;
  consecutiveFailedRuns: number;
  pageCursor: string | null;
  committedCursor: string | null;
  lastSuccessfulSyncAt: string | null;
}

export interface BankSyncJobRecord extends SyncJobSnapshot {
  organizationId: string;
  connectionId: string;
  trigger: SyncTrigger;
}

export type EnqueueOutcome = "CREATED" | "DUPLICATE" | "ALREADY_ACTIVE" | "CONNECTION_DISCONNECTED" | "NOT_FOUND";

export type IngestResult =
  | { outcome: "APPLIED"; accounts: number; added: number; modified: number; unchanged: number; removed: number; rejected: number }
  | { outcome: "CURSOR_CONFLICT" | "RUN_NOT_ACTIVE" | "CONNECTION_DISCONNECTED" };

export type ReconcileOutcome = "APPLIED" | "STALE" | "NOT_FOUND" | "INVALID" | "CONFLICT" | "LEDGER_EDITED";
export type TransitionOutcome = "APPLIED" | "UNCHANGED" | "STATUS_CHANGED" | "STALE" | "ILLEGAL" | "NOT_FOUND";
export type LinkOutcome =
  | "APPLIED"
  | "NOT_FOUND"
  | "DETACHED"
  | "INVALID"
  | "CURRENCY_UNKNOWN"
  | "CURRENCY_MISMATCH"
  | "HAS_IMPORTED_HISTORY"
  | "ACCOUNT_ALREADY_LINKED"
  // 0054: refused by the application before the database is asked.
  | "UNSUPPORTED_ACCOUNT_TYPE"
  | "ACCOUNT_KIND_MISMATCH"
  | "ALREADY_DECIDED";
export type DisconnectOutcome = ConnectionStatus | "NOT_FOUND" | "ALREADY_DISCONNECTED";

export interface ReconciliationRow extends Omit<ReconciliationInput, "candidates"> {
  connectionId: string;
  linkedAccountId: string;
  createdAt: string;
}

/** A candidate other leg, as `bank_transfer_candidates` returns it. It is a
 *  `TransferSide` plus the revision the pairing call has to present. */
export type TransferCandidate = TransferSide & { revision: number };

export type TransferPairOutcome = "APPLIED" | "NOT_FOUND" | "STALE" | "INVALID" | "LEDGER_EDITED";

/** Keyset position in a walk over changed rows. By id alone: rows written by
 *  one page share a `created_at`, so time cannot order them. */
export interface ReconcileCursor {
  id: string;
}

/** One job a worker has taken, with the run it must write its results to.
 *  `runId` is the fencing token: a run that is no longer the job's current
 *  attempt cannot ingest a page or complete. */
export interface ClaimedSyncJob {
  jobId: string;
  organizationId: string;
  connectionId: string;
  trigger: SyncTrigger;
  attempt: number;
  runId: string;
}

export type HeartbeatOutcome = "EXTENDED" | "LOST" | "NOT_FOUND";

export interface ConnectionDueForSync {
  connectionId: string;
  organizationId: string;
  provider: string;
}

export interface WebhookClaim {
  eventId: string;
  claimed: boolean;
  status: WebhookEventStatus;
  payloadMatches: boolean;
}

export interface BankStore {
  getConnection(organizationId: string, connectionId: string): Promise<BankConnectionRecord | null>;
  /** Resolution for a VERIFIED webhook only. Never an authorization input. */
  findConnectionByProvider(provider: string, providerConnectionId: string): Promise<BankConnectionRecord | null>;
  createConnection(input: {
    organizationId: string;
    provider: string;
    providerConnectionId: string;
    institutionId: string | null;
    institutionName: string | null;
    /** Which provider environment the link was made against (Plaid: sandbox |
     *  production). From the adapter, never from the browser. */
    providerEnvironment: string | null;
    createdBy: string | null;
  }): Promise<string>;
  storeCredentialRef(input: { organizationId: string; connectionId: string; secretRef: string }): Promise<void>;
  getCredentialRef(organizationId: string, connectionId: string): Promise<string | null>;
  listCredentialRefs(organizationId: string): Promise<{ connectionId: string; provider: string; secretRef: string }[]>;

  getJob(organizationId: string, jobId: string): Promise<BankSyncJobRecord | null>;
  getActiveJob(organizationId: string, connectionId: string): Promise<BankSyncJobRecord | null>;
  enqueueJob(input: { organizationId: string; connectionId: string; trigger: SyncTrigger; idempotencyKey: string; requestedBy: string | null; webhookEventId: string | null }): Promise<{ jobId: string | null; outcome: EnqueueOutcome }>;
  /** Returns the new run id, or null when nothing is claimable now. */
  claimJob(organizationId: string, jobId: string, leaseSeconds: number): Promise<string | null>;
  /**
   * Finds due jobs across every organization and claims them for `workerId`,
   * atomically and one at a time (FOR UPDATE SKIP LOCKED). The only operation
   * in this port that is not scoped to one organization: a worker serves the
   * whole deployment, and each claimed job carries the organization it belongs
   * to, which every later call is scoped by.
   */
  claimNextJobs(input: { limit: number; leaseSeconds: number; workerId: string }): Promise<ClaimedSyncJob[]>;
  /** Extends a lease this worker still owns. LOST means another worker has the
   *  job now, or the lease ran out — either way this worker must stop. */
  heartbeatRun(input: { organizationId: string; runId: string; workerId: string | null; leaseSeconds: number }): Promise<HeartbeatOutcome>;
  /** Recovers jobs whose worker stopped without finishing. Returns how many. */
  reclaimExpiredLeases(limit: number): Promise<number>;
  /** Connections a scheduled sync is due for: syncable, not already syncing,
   *  and last attempted longer ago than `minIntervalSeconds`. Bounded. */
  listConnectionsDueForSync(input: { limit: number; minIntervalSeconds: number }): Promise<ConnectionDueForSync[]>;
  /** Read-only: how deep the claimable queue is, how long its oldest job has
   *  waited, and how many running jobs have outlived their lease. Counts and
   *  one age — never a row. Answered from the partial indexes in 0049. */
  queueHealth(): Promise<WorkerQueueHealth>;
  completeRun(input: { organizationId: string; runId: string; outcome: "SUCCEEDED" | "FAILED" | "CANCELLED"; failureCategory: SyncFailureCategory | null; nextAttemptAt: Date | null; countsAgainstConnection: boolean; durationMs: number }): Promise<string>;

  ingestPage(input: { organizationId: string; runId: string; cursorBefore: string | null; page: NormalizedPage; leaseSeconds: number; hash: (value: string) => string }): Promise<IngestResult>;
  resetPageCursor(organizationId: string, connectionId: string): Promise<void>;

  /** Rows still needing reconciliation, bounded, in id order after `after`. */
  listToReconcile(organizationId: string, connectionId: string, limit: number, after: ReconcileCursor | null): Promise<ReconciliationRow[]>;
  getReconciliationRow(organizationId: string, externalId: string): Promise<ReconciliationRow | null>;
  matchCandidates(organizationId: string, query: CandidateQuery): Promise<ManualCandidate[]>;
  /**
   * Possible other legs of an internal transfer for this transaction.
   *
   * Scoped, filtered and bounded in SQL (bank_transfer_candidates, 0057), so
   * the organization boundary is not something this layer has to remember.
   * Whether any of them IS the other leg is decided by
   * `matchInternalTransfer`, which re-checks every rule anyway.
   */
  transferCandidates(organizationId: string, externalId: string): Promise<TransferCandidate[]>;
  /** Pairs two legs into one transfer row. All validation is in the database. */
  pairInternalTransfer(input: {
    organizationId: string;
    sourceExternalId: string;
    counterpartExternalId: string;
    expectedSourceRevision: number;
    expectedCounterpartRevision: number;
    runId: string | null;
    actorId: string | null;
  }): Promise<TransferPairOutcome>;
  reconcile(input: { organizationId: string; externalId: string; expectedRevision: number; decision: ReconciliationDecision; acknowledged: LedgerFields | null; runId: string | null; actorId: string | null; resolution: boolean }): Promise<ReconcileOutcome>;

  transitionConnection(input: { organizationId: string; connectionId: string; expectedStatus: ConnectionStatus; to: ConnectionStatus; reason: ConnectionStatusReason; eventAt: string | null }): Promise<TransitionOutcome>;
  finalizeDisconnect(organizationId: string, connectionId: string, actorId: string | null): Promise<DisconnectOutcome>;
  getLinkedAccount(
    organizationId: string,
    linkedAccountId: string,
  ): Promise<{ id: string; connectionId: string; importMode: ImportMode; accountId: string | null; detached: boolean; accountType: ExternalAccountType; accountSubtype: string | null } | null>;
  /** The kind of a Countorra account in this organization, or null. */
  getAccountKind(organizationId: string, accountId: string): Promise<string | null>;
  /**
   * Creates and links the Countorra account for every supported account the
   * bank reported that is still awaiting a decision (bank_auto_import_accounts,
   * 0054). Returns how many were created. Idempotent.
   */
  autoImportAccounts(organizationId: string, connectionId: string): Promise<number>;
  /**
   * Sets each Countorra-created account's opening balance so its ledger
   * balance equals the bank's current balance (bank_anchor_account_balances,
   * 0054). Returns how many changed.
   */
  anchorAccountBalances(organizationId: string, connectionId: string): Promise<number>;
  /** Creates the Countorra account for one reported bank account and links it (bank_import_linked_account, 0054). */
  importLinkedAccount(input: { organizationId: string; linkedAccountId: string; actorId: string | null }): Promise<LinkOutcome>;
  linkAccount(input: { organizationId: string; linkedAccountId: string; accountId: string | null; importMode: "IMPORT" | "IGNORE"; actorId: string | null }): Promise<LinkOutcome>;

  claimWebhookEvent(input: { provider: string; providerEventId: string; eventType: WebhookEventType; providerEventType: string; providerConnectionId: string | null; occurredAt: string | null; payloadSha256: string; leaseSeconds: number }): Promise<WebhookClaim>;
  completeWebhookEvent(input: { eventId: string; status: Extract<WebhookEventStatus, "PROCESSED" | "IGNORED" | "FAILED">; outcome: WebhookOutcome | null; organizationId: string | null; connectionId: string | null }): Promise<string>;
}

// ── Payloads shared by both implementations ─────────────────────────────

export function ingestPayload(page: NormalizedPage, hash: (value: string) => string) {
  return {
    accounts: page.accounts.map((account) => ({
      provider_account_id: account.providerAccountId,
      account_type: account.accountType,
      account_subtype: account.accountSubtype,
      display_name: account.displayName,
      mask: account.mask,
      currency: account.currency,
      current_balance_minor: account.currentBalanceMinor,
      available_balance_minor: account.availableBalanceMinor,
      provider_state: account.providerState,
    })),
    transactions: page.transactions.map((transaction) => ({
      provider_transaction_id: transaction.providerTransactionId,
      provider_account_id: transaction.providerAccountId,
      pending_provider_transaction_id: transaction.pendingProviderTransactionId,
      status: transaction.status,
      direction: transaction.direction,
      amount_decimal: transaction.amountDecimal,
      amount_minor: transaction.amountMinor,
      currency: transaction.currency,
      transaction_date: transaction.transactionDate,
      posted_date: transaction.postedDate,
      authorized_date: transaction.authorizedDate,
      merchant_name: transaction.merchantName,
      description: transaction.description,
      category_hint: transaction.categoryHint,
      content_hash: hash(transaction.contentFingerprint),
    })),
    removed: page.removedProviderTransactionIds,
    rejected: page.rejected.length,
  };
}

export function ledgerFieldsPayload(fields: LedgerFields) {
  return {
    account_id: fields.accountId,
    kind: fields.kind,
    amount_minor: fields.amountMinor,
    currency: fields.currency,
    occurred_on: fields.occurredOn,
    description: fields.description,
  };
}

export function decisionPayload(decision: ReconciliationDecision, acknowledged: LedgerFields | null): Record<string, unknown> {
  const ack = acknowledged ? { acknowledged: ledgerFieldsPayload(acknowledged) } : {};
  switch (decision.kind) {
    case "SET_STATE":
      return { kind: "SET_STATE", state: decision.state, review_reason: decision.reviewReason, ...ack };
    case "IMPORT":
      return { kind: "IMPORT", ledger: ledgerFieldsPayload(decision.ledger) };
    case "MATCH":
      return { kind: "MATCH", ledger_transaction_id: decision.ledgerTransactionId };
    case "UPDATE_LEDGER":
      return { kind: "UPDATE_LEDGER", ledger: ledgerFieldsPayload(decision.ledger) };
    case "NEEDS_CANDIDATES":
      // Never sent: the engine loads candidates and decides again first.
      return { kind: "NEEDS_CANDIDATES" };
  }
}

// ── Rows to the domain's reconciliation input ───────────────────────────

export interface ExternalDbRow {
  id: string;
  connection_id: string;
  linked_account_id: string;
  revision: number;
  status: ExternalTransactionStatus;
  direction: Direction;
  amount_minor: number | string | null;
  currency: string;
  transaction_date: string;
  merchant_name: string | null;
  description: string | null;
  category_hint: string | null;
  transfer_counterpart_id: string | null;
  reconciliation_state: ReconciliationState;
  review_reason: ReviewReason | null;
  review_resolved_revision: number | null;
  ledger_transaction_id: string | null;
  ledger_link_kind: "IMPORTED" | "MATCHED" | null;
  ledger_linked_at: string | null;
  ledger_written_account_id: string | null;
  ledger_written_kind: "income" | "expense" | "transfer" | null;
  ledger_written_amount_minor: number | string | null;
  ledger_written_currency: string | null;
  ledger_written_occurred_on: string | null;
  ledger_written_description: string | null;
  created_at: string;
}

export interface LinkedAccountDbRow {
  id: string;
  import_mode: ImportMode;
  account_id: string | null;
  currency: string | null;
  detached_at: string | null;
}

export interface LedgerDbRow {
  id: string;
  account_id: string;
  kind: "income" | "expense" | "transfer";
  amount_minor: number | string;
  currency: string;
  occurred_on: string;
  description: string | null;
  source: "manual" | "import" | "bank_sync" | "ai";
}

const asNumber = (value: number | string | null): number | null => (value === null ? null : Number(value));
const asDate = (value: string | null): string | null => (value === null ? null : String(value).slice(0, 10));

export function toReconciliationRow(external: ExternalDbRow, link: LinkedAccountDbRow, account: { id: string; currency: string; kind?: string | null } | null, ledger: LedgerDbRow | null): ReconciliationRow {
  const written: WrittenLedgerFields | null =
    external.ledger_written_account_id && external.ledger_written_kind && external.ledger_written_amount_minor !== null && external.ledger_written_currency && external.ledger_written_occurred_on
      ? {
          accountId: external.ledger_written_account_id,
          kind: external.ledger_written_kind,
          amountMinor: Number(external.ledger_written_amount_minor),
          currency: external.ledger_written_currency.trim(),
          occurredOn: asDate(external.ledger_written_occurred_on)!,
          description: external.ledger_written_description,
        }
      : null;

  const reconciliationExternal: ExternalForReconciliation = {
    id: external.id,
    revision: external.revision,
    status: external.status,
    direction: external.direction,
    amountMinor: asNumber(external.amount_minor),
    currency: external.currency.trim(),
    transactionDate: asDate(external.transaction_date)!,
    merchantName: external.merchant_name,
    description: external.description,
    reconciliationState: external.reconciliation_state,
    reviewReason: external.review_reason,
    reviewResolvedRevision: external.review_resolved_revision,
    ledgerTransactionId: external.ledger_transaction_id,
    ledgerLinkKind: external.ledger_link_kind,
    ledgerLinkedAt: external.ledger_linked_at,
    categoryHint: external.category_hint ?? null,
    transferCounterpartId: external.transfer_counterpart_id ?? null,
    written,
  };

  const ledgerRow: LedgerRowForReconciliation | null = ledger
    ? {
        id: ledger.id,
        accountId: ledger.account_id,
        kind: ledger.kind,
        amountMinor: Number(ledger.amount_minor),
        currency: ledger.currency.trim(),
        occurredOn: asDate(ledger.occurred_on)!,
        description: ledger.description,
        source: ledger.source,
      }
    : null;

  return {
    connectionId: external.connection_id,
    linkedAccountId: external.linked_account_id,
    createdAt: external.created_at,
    external: reconciliationExternal,
    linkedAccount: { importMode: link.import_mode, accountId: link.account_id, currency: link.currency ? link.currency.trim() : null, detached: link.detached_at !== null },
    account: account ? { id: account.id, currency: account.currency.trim(), kind: account.kind ?? null } : null,
    ledger: ledgerRow,
  };
}

export function toManualCandidate(row: { id: string; account_id: string; kind: "income" | "expense" | "transfer"; amount_minor: number | string; currency: string; occurred_on: string; source: string }): ManualCandidate {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    amountMinor: Number(row.amount_minor),
    currency: row.currency.trim(),
    occurredOn: asDate(row.occurred_on)!,
    source: row.source as ManualCandidate["source"],
  };
}
