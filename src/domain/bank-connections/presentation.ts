import type { ConnectionStatus, ConnectionStatusReason, ImportMode, ReconciliationState, ReviewReason, SyncFailureCategory, SyncJobStatus } from "./types";

/**
 * Words for people. Every status is shown with its label, never color alone
 * (DESIGN.md §24), and every sentence here is Countorra's own — a provider's
 * message is never shown.
 */

export type Tone = "neutral" | "positive" | "negative" | "warning" | "info";

export const CONNECTION_STATUS_PRESENTATION: Record<ConnectionStatus, { label: string; tone: Tone; description: string }> = {
  PENDING: { label: "Setting up", tone: "neutral", description: "The bank link was started and has not finished." },
  ACTIVE: { label: "Connected", tone: "positive", description: "Imports are working." },
  DEGRADED: { label: "Delayed", tone: "warning", description: "The last import didn't complete. It will be retried." },
  // A status, deliberately worded differently from the button that fixes it
  // ("Sign in again"): a badge and an action that read identically are
  // indistinguishable to anyone navigating by name.
  REQUIRES_REAUTH: { label: "Needs sign-in", tone: "warning", description: "The bank needs you to sign in again before anything more is imported." },
  ERROR: { label: "Not importing", tone: "negative", description: "Imports have stopped. Transactions already imported are unaffected." },
  DISCONNECTED: { label: "Disconnected", tone: "neutral", description: "No longer connected. Transactions already imported stay in your books." },
};

export const CONNECTION_REASON_TEXT: Record<ConnectionStatusReason, string> = {
  LINK_STARTED: "Link started",
  LINK_COMPLETED: "Link completed",
  SYNC_SUCCEEDED: "Last import succeeded",
  SYNC_FAILED: "Last import failed",
  REPEATED_SYNC_FAILURE: "Several imports in a row failed",
  PROVIDER_REPORTED_REAUTH: "The bank asked for sign-in",
  PROVIDER_REPORTED_ERROR: "The connection reported an error",
  PROVIDER_REVOKED: "Access was withdrawn at the bank",
  PROVIDER_RECOVERED: "The connection recovered",
  CONSENT_EXPIRED: "Your consent expired",
  CREDENTIAL_UNAVAILABLE: "The stored access couldn't be used",
  USER_DISCONNECTED: "Disconnected by a member of this workspace",
};

export const IMPORT_MODE_PRESENTATION: Record<ImportMode, { label: string; tone: Tone }> = {
  AWAITING_DECISION: { label: "Not linked", tone: "warning" },
  IMPORT: { label: "Importing", tone: "positive" },
  IGNORE: { label: "Ignored", tone: "neutral" },
};

export const RECONCILIATION_PRESENTATION: Record<ReconciliationState, { label: string; tone: Tone }> = {
  UNRECONCILED: { label: "Not yet checked", tone: "neutral" },
  PENDING_SETTLEMENT: { label: "Pending at bank", tone: "neutral" },
  AWAITING_ACCOUNT_LINK: { label: "Account not linked", tone: "warning" },
  IMPORTED: { label: "In your books", tone: "positive" },
  MATCHED: { label: "Matched to your entry", tone: "positive" },
  NEEDS_REVIEW: { label: "Needs review", tone: "warning" },
  IGNORED: { label: "Ignored", tone: "neutral" },
  CURRENCY_MISMATCH: { label: "Currency differs", tone: "negative" },
  UNSUPPORTED_CURRENCY: { label: "Currency not supported", tone: "negative" },
  NOT_POSTED: { label: "Never posted", tone: "neutral" },
  REMOVED_FROM_BOOKS: { label: "Deleted from your books", tone: "neutral" },
};

export const REVIEW_REASON_TEXT: Record<ReviewReason, string> = {
  AMBIGUOUS_MANUAL_MATCH: "More than one transaction you entered could be this one. Choose what to do.",
  PROVIDER_CHANGED_AFTER_EDIT: "The bank changed this transaction after you edited it. Your edit was kept.",
  PROVIDER_CHANGED_MATCHED: "The bank changed a transaction matched to one you entered. Your entry was not changed.",
  REMOVED_BY_PROVIDER: "The bank no longer reports this transaction. It is still in your books.",
};

export const SYNC_JOB_STATUS_PRESENTATION: Record<SyncJobStatus, { label: string; tone: Tone }> = {
  QUEUED: { label: "Queued", tone: "neutral" },
  RUNNING: { label: "Importing", tone: "info" },
  SUCCEEDED: { label: "Completed", tone: "positive" },
  RETRYABLE: { label: "Will retry", tone: "warning" },
  FAILED: { label: "Failed", tone: "negative" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export const SYNC_FAILURE_TEXT: Record<SyncFailureCategory, string> = {
  PROVIDER_NOT_CONFIGURED: "No bank connection provider is configured.",
  PROVIDER_UNAVAILABLE: "The bank connection service was unavailable.",
  PROVIDER_TIMEOUT: "The bank connection service didn't respond in time.",
  PROVIDER_RATE_LIMITED: "The bank connection service asked us to slow down.",
  MALFORMED_PROVIDER_RESPONSE: "The bank connection service sent data that couldn't be used.",
  REAUTH_REQUIRED: "The bank needs you to sign in again.",
  CONNECTION_REVOKED: "Access was withdrawn at the bank.",
  CREDENTIAL_UNAVAILABLE: "The stored access couldn't be used.",
  CURSOR_RESET_REQUIRED: "The bank's data changed during the import. It will start again.",
  CURSOR_CONFLICT: "Another import was running at the same time.",
  CONNECTION_DISCONNECTED: "The connection was disconnected.",
  LEASE_EXPIRED: "The import stopped before finishing.",
  INTERNAL_ERROR: "Something went wrong on our side.",
};

/**
 * What the background worker is doing for a connection right now, in words —
 * or null when there is nothing to say and "Last import …" already says it.
 *
 * Deliberately short and deliberately not a progress bar: a sync is a sequence
 * of provider pages whose length nobody knows in advance, and an animated bar
 * that cannot be honest about its own progress is worse than a word
 * (DESIGN.md §26).
 */
export function importActivityText(job: { status: SyncJobStatus; attempts: number; maxAttempts: number } | null): string | null {
  if (!job) return null;
  switch (job.status) {
    case "QUEUED":
      return "Import queued";
    case "RUNNING":
      return "Importing now";
    case "RETRYABLE":
      return `Retry scheduled — attempt ${job.attempts + 1} of ${job.maxAttempts}`;
    case "FAILED":
      return job.attempts >= job.maxAttempts ? `Import failed after ${job.attempts} attempts` : "Last import failed";
    case "SUCCEEDED":
    case "CANCELLED":
      return null;
  }
}

/** `transactions.source`, in words. */
export const TRANSACTION_SOURCE_LABELS: Record<"manual" | "import" | "bank_sync" | "ai", string> = {
  manual: "Entered by hand",
  import: "File import",
  bank_sync: "Bank connection",
  ai: "Drafted by the assistant",
};
