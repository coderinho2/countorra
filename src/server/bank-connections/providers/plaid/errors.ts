import type { ConnectionEvent } from "@/domain/bank-connections/lifecycle";
import type { SyncFailureCategory } from "@/domain/bank-connections/types";

/**
 * Plaid's failures, translated into Countorra's categories.
 *
 * WHY A TABLE AND NOT A STRING
 *
 * Plaid's message text is a sentence written for a developer; it can name an
 * institution, an item, or the shape of a request. None of that is shown to a
 * person or written to a log here — the category is (Task 11's
 * SYNC_FAILURE_TEXT supplies the words), and the category decides whether a
 * retry can possibly help.
 *
 * The distinction that matters most is retryable versus not. `ITEM_LOGIN_REQUIRED`
 * retried five times is five pointless calls and a connection that looks broken
 * for longer; `INTERNAL_SERVER_ERROR` not retried at all is a lost sync.
 */

export interface PlaidErrorFacts {
  errorCode: string | null;
  errorType: string | null;
  status: number | null;
  /** Plaid's request id. Safe to log: it identifies the call, not the customer. */
  requestId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 && value.length <= 120 ? value : null);

/**
 * Pulls the few safe facts out of whatever the SDK threw: an axios error with
 * `response.data`, a plain Plaid error body, or something else entirely.
 */
export function extractPlaidError(error: unknown): PlaidErrorFacts {
  const root = asRecord(error);
  const response = root ? asRecord(root.response) : null;
  const body = response ? asRecord(response.data) : (root ? asRecord(root.data) ?? root : null);

  const status = response && typeof response.status === "number" ? response.status : root && typeof root.status === "number" ? root.status : null;

  return {
    errorCode: body ? asString(body.error_code) : null,
    errorType: body ? asString(body.error_type) : null,
    status,
    requestId: body ? asString(body.request_id) : null,
  };
}

/** A person must re-authenticate before anything more can be imported. */
const REAUTH_CODES = new Set(["ITEM_LOGIN_REQUIRED", "ITEM_LOCKED", "PENDING_EXPIRATION", "PENDING_DISCONNECT", "INSTITUTION_NO_LONGER_SUPPORTED"]);

/** Access is gone: the consent was withdrawn or the item no longer exists. */
const REVOKED_CODES = new Set(["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN", "USER_PERMISSION_REVOKED", "USER_ACCOUNT_REVOKED", "ITEM_NOT_SUPPORTED"]);

/** This deployment's Plaid configuration is wrong — nothing about the bank. */
const CONFIGURATION_CODES = new Set(["INVALID_API_KEYS", "INVALID_CLIENT_ID", "INVALID_SECRET", "UNAUTHORIZED_ENVIRONMENT", "INVALID_PRODUCT", "PRODUCTS_NOT_SUPPORTED", "NOT_ENTITLED"]);

/** Temporary on Plaid's or the bank's side. Worth another attempt. */
const TRANSIENT_CODES = new Set([
  "INTERNAL_SERVER_ERROR",
  "PLANNED_MAINTENANCE",
  "INSTITUTION_DOWN",
  "INSTITUTION_NOT_RESPONDING",
  "INSTITUTION_NOT_AVAILABLE",
  "PRODUCT_NOT_READY",
  "TRANSACTIONS_SYNC_LIMIT",
]);

export function classifyPlaidFailure(error: unknown): SyncFailureCategory {
  const { errorCode, errorType, status } = extractPlaidError(error);

  if (errorCode === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") return "CURSOR_RESET_REQUIRED";
  if (errorCode && REAUTH_CODES.has(errorCode)) return "REAUTH_REQUIRED";
  if (errorCode && REVOKED_CODES.has(errorCode)) return "CONNECTION_REVOKED";
  if (errorCode && CONFIGURATION_CODES.has(errorCode)) return "PROVIDER_NOT_CONFIGURED";
  if (errorCode === "RATE_LIMIT" || errorType === "RATE_LIMIT_EXCEEDED" || status === 429) return "PROVIDER_RATE_LIMITED";
  if (errorCode && TRANSIENT_CODES.has(errorCode)) return "PROVIDER_UNAVAILABLE";
  if (errorType === "INSTITUTION_ERROR" || errorType === "API_ERROR") return "PROVIDER_UNAVAILABLE";
  if (status !== null && status >= 500) return "PROVIDER_UNAVAILABLE";
  // A request Plaid rejected as invalid is a bug on this side. Bounded
  // attempts apply either way, and the run's failure category makes it
  // visible rather than silently swallowed.
  if (errorType === "INVALID_REQUEST" || errorType === "INVALID_INPUT" || (status !== null && status >= 400)) return "INTERNAL_ERROR";
  // A network fault, a timeout, an aborted socket: no status, no body.
  return "PROVIDER_UNAVAILABLE";
}

/**
 * What an item's own reported error means for the connection's lifecycle.
 *
 * Plaid keeps the last error on the item, so this is also what a webhook and a
 * post-reauthentication check are read through. `null` means the item is
 * healthy as far as this error code is concerned.
 */
export function itemErrorToConnectionEvent(errorCode: string | null): ConnectionEvent | null {
  if (!errorCode) return null;
  if (REAUTH_CODES.has(errorCode)) return { kind: "PROVIDER_REAUTH_REQUIRED" };
  if (REVOKED_CODES.has(errorCode)) return { kind: "PROVIDER_REVOKED" };
  return { kind: "PROVIDER_ERROR" };
}

/** True when the error says a person must act, so a retry is pointless. */
export function requiresHumanAction(category: SyncFailureCategory): boolean {
  return category === "REAUTH_REQUIRED" || category === "CONNECTION_REVOKED";
}
