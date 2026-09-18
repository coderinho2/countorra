import type { ConnectionStatus, ConnectionStatusReason, SyncFailureCategory } from "./types";

/**
 * THE BANK-CONNECTION LIFECYCLE.
 *
 *            ┌──────────────▶ ERROR ◀───────────────┐
 *            │                  │ ▲                 │
 *   PENDING ─┼──▶ ACTIVE ◀──────┘ │                 │
 *            │     │  ▲  ▲        │                 │
 *            │     ▼  │  │        │                 │
 *            │  DEGRADED ────▶ REQUIRES_REAUTH ─────┘
 *            │
 *            └──────── any ───────▶ DISCONNECTED  (terminal)
 *
 * The browser never sets a status. A status moves only because the server or
 * a verified provider event reported something, and `nextConnectionStatus`
 * decides what that means. The guard trigger `bank_connections_guard` in
 * migration 0047 enforces the same table, so a bug here still cannot write an
 * illegal row.
 *
 * DISCONNECTED is terminal on purpose. Reconnecting creates a new connection:
 * providers issue a new connection identity on re-link, and reusing a row
 * would blur which history came from which consent.
 */

export const CONNECTION_TRANSITIONS: Readonly<Record<ConnectionStatus, readonly ConnectionStatus[]>> = {
  PENDING: ["ACTIVE", "ERROR", "DISCONNECTED"],
  ACTIVE: ["DEGRADED", "REQUIRES_REAUTH", "ERROR", "DISCONNECTED"],
  DEGRADED: ["ACTIVE", "REQUIRES_REAUTH", "ERROR", "DISCONNECTED"],
  REQUIRES_REAUTH: ["ACTIVE", "ERROR", "DISCONNECTED"],
  ERROR: ["ACTIVE", "DEGRADED", "REQUIRES_REAUTH", "DISCONNECTED"],
  DISCONNECTED: [],
};

export class InvalidConnectionTransitionError extends Error {
  constructor(from: ConnectionStatus, to: ConnectionStatus) {
    super(`A bank connection cannot move from ${from} to ${to}.`);
    this.name = "InvalidConnectionTransitionError";
  }
}

export function canTransitionConnection(from: ConnectionStatus, to: ConnectionStatus): boolean {
  return CONNECTION_TRANSITIONS[from].includes(to);
}

export function assertConnectionTransition(from: ConnectionStatus, to: ConnectionStatus): void {
  if (!canTransitionConnection(from, to)) throw new InvalidConnectionTransitionError(from, to);
}

/** Consecutive failed runs that turn a working connection into DEGRADED. */
export const DEGRADED_AFTER_FAILED_RUNS = 1;
/** Consecutive failed runs after which a connection is ERROR. */
export const ERROR_AFTER_FAILED_RUNS = 3;

/** Something that happened to a connection. */
export type ConnectionEvent =
  | { kind: "LINK_COMPLETED" }
  | { kind: "SYNC_SUCCEEDED" }
  | { kind: "SYNC_FAILED"; category: SyncFailureCategory; consecutiveFailures: number }
  | { kind: "PROVIDER_REAUTH_REQUIRED" }
  | { kind: "PROVIDER_ERROR" }
  | { kind: "PROVIDER_REVOKED" }
  | { kind: "PROVIDER_RECOVERED" }
  | { kind: "CONSENT_EXPIRED" }
  | { kind: "USER_DISCONNECTED" };

export type ConnectionDecision =
  | { kind: "transition"; from: ConnectionStatus; to: ConnectionStatus; reason: ConnectionStatusReason }
  | { kind: "unchanged"; status: ConnectionStatus }
  /** The event does not apply to a connection in this status (for example,
   *  anything at all after DISCONNECTED). Recorded, never forced. */
  | { kind: "ignored"; status: ConnectionStatus; why: "TERMINAL" | "NOT_APPLICABLE" };

/**
 * What an event does to a connection. Pure.
 *
 * Conservative by construction: a single failed run makes a connection
 * DEGRADED, not ERROR, because a provider outage is usually transient and
 * "error" would tell the person to act when there is nothing for them to do.
 * Only a failure the person CAN act on — re-authentication, revoked consent —
 * moves straight to a status that asks for them.
 */
export function nextConnectionStatus(current: ConnectionStatus, event: ConnectionEvent): ConnectionDecision {
  if (current === "DISCONNECTED") return { kind: "ignored", status: current, why: "TERMINAL" };

  const to = (target: ConnectionStatus, reason: ConnectionStatusReason): ConnectionDecision => {
    if (target === current) return { kind: "unchanged", status: current };
    if (!canTransitionConnection(current, target)) return { kind: "ignored", status: current, why: "NOT_APPLICABLE" };
    return { kind: "transition", from: current, to: target, reason };
  };

  switch (event.kind) {
    case "LINK_COMPLETED":
      return current === "PENDING" ? to("ACTIVE", "LINK_COMPLETED") : { kind: "ignored", status: current, why: "NOT_APPLICABLE" };

    case "SYNC_SUCCEEDED":
      // A successful run proves the connection works. It does NOT clear
      // REQUIRES_REAUTH: only the person re-authenticating does, and a run
      // cannot succeed without that anyway.
      if (current === "REQUIRES_REAUTH") return { kind: "unchanged", status: current };
      if (current === "PENDING") return to("ACTIVE", "LINK_COMPLETED");
      return to("ACTIVE", "SYNC_SUCCEEDED");

    case "SYNC_FAILED": {
      if (event.category === "REAUTH_REQUIRED") return to("REQUIRES_REAUTH", "PROVIDER_REPORTED_REAUTH");
      if (event.category === "CONNECTION_REVOKED") return to("ERROR", "PROVIDER_REVOKED");
      if (event.category === "CREDENTIAL_UNAVAILABLE") return to("ERROR", "CREDENTIAL_UNAVAILABLE");
      // Failures that say nothing about the connection itself.
      if (event.category === "CONNECTION_DISCONNECTED" || event.category === "CURSOR_CONFLICT" || event.category === "PROVIDER_NOT_CONFIGURED") {
        return { kind: "unchanged", status: current };
      }
      if (current === "PENDING") return to("ERROR", "SYNC_FAILED");
      if (current === "REQUIRES_REAUTH") return { kind: "unchanged", status: current };
      if (event.consecutiveFailures >= ERROR_AFTER_FAILED_RUNS) return to("ERROR", "REPEATED_SYNC_FAILURE");
      if (event.consecutiveFailures >= DEGRADED_AFTER_FAILED_RUNS) return current === "ERROR" ? { kind: "unchanged", status: current } : to("DEGRADED", "SYNC_FAILED");
      return { kind: "unchanged", status: current };
    }

    case "PROVIDER_REAUTH_REQUIRED":
      return to("REQUIRES_REAUTH", "PROVIDER_REPORTED_REAUTH");
    case "CONSENT_EXPIRED":
      return to("REQUIRES_REAUTH", "CONSENT_EXPIRED");
    case "PROVIDER_ERROR":
      return to("ERROR", "PROVIDER_REPORTED_ERROR");
    case "PROVIDER_REVOKED":
      return to("ERROR", "PROVIDER_REVOKED");
    case "PROVIDER_RECOVERED":
      return current === "PENDING" ? { kind: "ignored", status: current, why: "NOT_APPLICABLE" } : to("ACTIVE", "PROVIDER_RECOVERED");
    case "USER_DISCONNECTED":
      return to("DISCONNECTED", "USER_DISCONNECTED");
  }
}

/** Whether a failed run says something about the connection itself, and so
 *  counts toward DEGRADED and ERROR. A lost race or a missing deployment
 *  provider does not. */
export function failureCountsAgainstConnection(category: SyncFailureCategory): boolean {
  return category !== "CURSOR_CONFLICT" && category !== "CONNECTION_DISCONNECTED" && category !== "PROVIDER_NOT_CONFIGURED";
}

/** Whether a connection in this status may be synced at all. */
export function canSync(status: ConnectionStatus): boolean {
  return status === "ACTIVE" || status === "DEGRADED" || status === "ERROR";
}
