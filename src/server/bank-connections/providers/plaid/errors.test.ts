import { describe, expect, it } from "vitest";
import { isRetryableSyncFailure } from "@/domain/bank-connections/sync-job";
import { classifyPlaidFailure, extractPlaidError, itemErrorToConnectionEvent, requiresHumanAction } from "./errors";

/**
 * Plaid's failures, classified.
 *
 * The property that matters most: a failure a retry cannot fix must never be
 * retried, and a transient one must never be treated as final. Everything else
 * — messages, request shapes, institution names — is discarded.
 */

/** What the SDK actually throws: an axios error with Plaid's body inside. */
const axiosError = (status: number, body: Record<string, unknown>) => ({
  isAxiosError: true,
  message: `Request failed with status code ${status}`,
  response: { status, data: body },
});

const plaidBody = (errorCode: string, errorType = "ITEM_ERROR") => ({
  error_code: errorCode,
  error_type: errorType,
  error_message: "A sentence written for a developer, naming the institution Chase and item item-abc123.",
  display_message: null,
  request_id: "req_abc123",
});

describe("reading a Plaid error", () => {
  it("takes only the safe facts", () => {
    expect(extractPlaidError(axiosError(400, plaidBody("ITEM_LOGIN_REQUIRED")))).toEqual({
      errorCode: "ITEM_LOGIN_REQUIRED",
      errorType: "ITEM_ERROR",
      status: 400,
      requestId: "req_abc123",
    });
  });

  it("survives anything else being thrown", () => {
    for (const value of [new Error("socket hang up"), "nope", null, undefined, {}, { response: {} }]) {
      expect(extractPlaidError(value)).toMatchObject({ errorCode: null });
    }
  });
});

describe("classification", () => {
  const classify = (status: number, body: Record<string, unknown>) => classifyPlaidFailure(axiosError(status, body));

  it("asks the person to act, without retrying, when only they can fix it", () => {
    for (const code of ["ITEM_LOGIN_REQUIRED", "ITEM_LOCKED", "PENDING_EXPIRATION", "PENDING_DISCONNECT", "INSTITUTION_NO_LONGER_SUPPORTED"]) {
      const category = classify(400, plaidBody(code));
      expect(category, code).toBe("REAUTH_REQUIRED");
      expect(isRetryableSyncFailure(category), code).toBe(false);
      expect(requiresHumanAction(category)).toBe(true);
    }
  });

  it("treats withdrawn access as revoked, and never retries it", () => {
    for (const code of ["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN", "USER_PERMISSION_REVOKED", "USER_ACCOUNT_REVOKED"]) {
      expect(classify(400, plaidBody(code)), code).toBe("CONNECTION_REVOKED");
      expect(isRetryableSyncFailure("CONNECTION_REVOKED")).toBe(false);
    }
  });

  it("separates this deployment's misconfiguration from a bank problem", () => {
    for (const code of ["INVALID_API_KEYS", "UNAUTHORIZED_ENVIRONMENT", "INVALID_PRODUCT", "NOT_ENTITLED"]) {
      expect(classify(400, plaidBody(code, "INVALID_INPUT")), code).toBe("PROVIDER_NOT_CONFIGURED");
    }
  });

  it("retries what is worth retrying", () => {
    for (const code of ["INTERNAL_SERVER_ERROR", "PLANNED_MAINTENANCE", "INSTITUTION_DOWN", "INSTITUTION_NOT_RESPONDING", "PRODUCT_NOT_READY"]) {
      const category = classify(500, plaidBody(code, "API_ERROR"));
      expect(category, code).toBe("PROVIDER_UNAVAILABLE");
      expect(isRetryableSyncFailure(category), code).toBe(true);
    }
    expect(classify(429, plaidBody("RATE_LIMIT", "RATE_LIMIT_EXCEEDED"))).toBe("PROVIDER_RATE_LIMITED");
    expect(isRetryableSyncFailure("PROVIDER_RATE_LIMITED")).toBe(true);
    expect(classify(503, { error_type: "API_ERROR" })).toBe("PROVIDER_UNAVAILABLE");
  });

  it("restarts pagination when Plaid says the data moved under it", () => {
    const category = classify(400, plaidBody("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "INVALID_REQUEST"));
    expect(category).toBe("CURSOR_RESET_REQUIRED");
    expect(isRetryableSyncFailure(category)).toBe(true);
  });

  it("classifies a network fault with no response as temporary", () => {
    expect(classifyPlaidFailure(new Error("ECONNRESET"))).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyPlaidFailure({ code: "ETIMEDOUT" })).toBe("PROVIDER_UNAVAILABLE");
  });

  it("never lets Plaid's message text become the category", () => {
    const category = classify(400, plaidBody("ITEM_LOGIN_REQUIRED"));
    expect(JSON.stringify(category)).not.toContain("Chase");
    expect(JSON.stringify(category)).not.toContain("item-abc123");
  });
});

describe("an item's own error, as a lifecycle event", () => {
  it("maps to the event the connection should follow", () => {
    expect(itemErrorToConnectionEvent(null)).toBeNull();
    expect(itemErrorToConnectionEvent("ITEM_LOGIN_REQUIRED")).toEqual({ kind: "PROVIDER_REAUTH_REQUIRED" });
    expect(itemErrorToConnectionEvent("USER_PERMISSION_REVOKED")).toEqual({ kind: "PROVIDER_REVOKED" });
    expect(itemErrorToConnectionEvent("SOMETHING_ELSE")).toEqual({ kind: "PROVIDER_ERROR" });
  });
});
