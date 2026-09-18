/**
 * The bank-connection vocabulary, provider-independent.
 *
 * Nothing in src/domain/bank-connections names a provider. A provider adapter
 * (Plaid, or any other) translates its own shapes into the contract in
 * ./provider.ts; everything past that boundary speaks only these types. The
 * SQL check constraints in supabase/migrations/0047_bank_connections.sql mirror
 * every list below — change them together.
 *
 * THE LAYERS, IN ORDER
 *
 *   provider payload (untrusted, adapter-specific)
 *     ─▶ provider contract (validated, ./provider.ts)
 *     ─▶ normalized external transaction (./normalization.ts)
 *     ─▶ bank_external_transactions (idempotent by provider id)
 *     ─▶ reconciliation decision (./reconciliation.ts)
 *     ─▶ the existing `transactions` ledger, or an explicit review state
 *
 * An external transaction is never the ledger. It is evidence of what a bank
 * reported, kept separately and linked to at most one ledger row.
 */

// ── Connections ─────────────────────────────────────────────────────────

export const CONNECTION_STATUSES = ["PENDING", "ACTIVE", "DEGRADED", "REQUIRES_REAUTH", "ERROR", "DISCONNECTED"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Why a connection is in its status. A code written by Countorra — never a
 *  provider's own message. */
export const CONNECTION_STATUS_REASONS = [
  "LINK_STARTED",
  "LINK_COMPLETED",
  "SYNC_SUCCEEDED",
  "SYNC_FAILED",
  "REPEATED_SYNC_FAILURE",
  "PROVIDER_REPORTED_REAUTH",
  "PROVIDER_REPORTED_ERROR",
  "PROVIDER_REVOKED",
  "PROVIDER_RECOVERED",
  "CONSENT_EXPIRED",
  "CREDENTIAL_UNAVAILABLE",
  "USER_DISCONNECTED",
] as const;
export type ConnectionStatusReason = (typeof CONNECTION_STATUS_REASONS)[number];

// ── Linked (external) accounts ──────────────────────────────────────────

export const EXTERNAL_ACCOUNT_TYPES = ["DEPOSITORY", "CREDIT", "LOAN", "INVESTMENT", "OTHER"] as const;
export type ExternalAccountType = (typeof EXTERNAL_ACCOUNT_TYPES)[number];

/**
 * What happens to an external account's transactions.
 *
 * AWAITING_DECISION is the default and imports nothing: a person must say
 * which Countorra account a bank account feeds, or that it is ignored. There
 * is no automatic account creation — that is how a workspace ends up with a
 * duplicate of an account someone already records by hand.
 */
export const IMPORT_MODES = ["AWAITING_DECISION", "IMPORT", "IGNORE"] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

// ── External transactions ───────────────────────────────────────────────

export const EXTERNAL_TRANSACTION_STATUSES = ["PENDING", "POSTED", "SUPERSEDED", "REMOVED"] as const;
export type ExternalTransactionStatus = (typeof EXTERNAL_TRANSACTION_STATUSES)[number];

/** Money out of the account (DEBIT) or into it (CREDIT). Amounts are always
 *  non-negative, matching `transactions.amount_minor`; direction carries the
 *  sign, exactly as `transactions.kind` does. */
export type Direction = "DEBIT" | "CREDIT";

export const RECONCILIATION_STATES = [
  /** Not yet decided. */
  "UNRECONCILED",
  /** Pending at the bank. Pending transactions never enter the ledger. */
  "PENDING_SETTLEMENT",
  /** Posted, but its bank account is not linked to a Countorra account yet. */
  "AWAITING_ACCOUNT_LINK",
  /** A new ledger transaction was created from it. */
  "IMPORTED",
  /** Linked to a transaction a person had already entered. */
  "MATCHED",
  /** Something needs a person. See REVIEW_REASONS. */
  "NEEDS_REVIEW",
  /** Its bank account is ignored. */
  "IGNORED",
  /** Its currency is not the linked account's currency. */
  "CURRENCY_MISMATCH",
  /** Its currency is not one Countorra can hold. */
  "UNSUPPORTED_CURRENCY",
  /** A pending transaction that was replaced or cancelled. Never in the ledger. */
  "NOT_POSTED",
  /** It was imported, and a person later deleted that ledger transaction. It is
   *  not imported again. */
  "REMOVED_FROM_BOOKS",
] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

export const REVIEW_REASONS = [
  /** More than one hand-entered transaction could be this one. */
  "AMBIGUOUS_MANUAL_MATCH",
  /** The bank changed a transaction whose ledger copy a person had edited. */
  "PROVIDER_CHANGED_AFTER_EDIT",
  /** The bank changed a transaction that is matched to a hand-entered one. */
  "PROVIDER_CHANGED_MATCHED",
  /** The bank removed a posted transaction that is in the ledger. */
  "REMOVED_BY_PROVIDER",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

// ── Sync jobs ───────────────────────────────────────────────────────────

export const SYNC_JOB_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "RETRYABLE", "FAILED", "CANCELLED"] as const;
export type SyncJobStatus = (typeof SYNC_JOB_STATUSES)[number];

export const SYNC_TRIGGERS = ["INITIAL", "MANUAL", "WEBHOOK", "SCHEDULED", "CONTINUATION"] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

export const SYNC_FAILURE_CATEGORIES = [
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "MALFORMED_PROVIDER_RESPONSE",
  "REAUTH_REQUIRED",
  "CONNECTION_REVOKED",
  "CREDENTIAL_UNAVAILABLE",
  "CURSOR_RESET_REQUIRED",
  "CURSOR_CONFLICT",
  "CONNECTION_DISCONNECTED",
  "LEASE_EXPIRED",
  "INTERNAL_ERROR",
] as const;
export type SyncFailureCategory = (typeof SYNC_FAILURE_CATEGORIES)[number];

// ── Webhooks ────────────────────────────────────────────────────────────

/** A provider's event, reduced to what Countorra acts on. */
export const WEBHOOK_EVENT_TYPES = [
  "TRANSACTIONS_UPDATED",
  "CONNECTION_REQUIRES_REAUTH",
  "CONNECTION_ERROR",
  "CONNECTION_REVOKED",
  "CONNECTION_RECOVERED",
  "CONSENT_EXPIRING",
  "UNSUPPORTED",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_EVENT_STATUSES = ["RECEIVED", "PROCESSING", "PROCESSED", "IGNORED", "FAILED"] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

export const WEBHOOK_OUTCOMES = [
  "SYNC_ENQUEUED",
  "SYNC_ALREADY_ACTIVE",
  "STATUS_UPDATED",
  "STALE_EVENT",
  "UNKNOWN_CONNECTION",
  "CONNECTION_DISCONNECTED",
  "UNSUPPORTED_EVENT",
  "NO_CHANGE",
] as const;
export type WebhookOutcome = (typeof WEBHOOK_OUTCOMES)[number];
