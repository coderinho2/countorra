import { canSync, nextConnectionStatus, type ConnectionEvent } from "./lifecycle";
import type { ConnectionStatus, ConnectionStatusReason, WebhookEventType, WebhookOutcome } from "./types";

/**
 * What a VERIFIED provider event does. Pure.
 *
 * By the time an event reaches this function its signature has been checked
 * by the provider adapter and its id has been claimed in
 * `bank_webhook_events`, so a redelivery never gets here twice. What remains
 * is deciding what it means, which is never "change money":
 *
 *   TRANSACTIONS_UPDATED  → enqueue a sync job. The job fetches from the
 *                           provider with the stored credential; the webhook
 *                           body is never trusted as transaction data.
 *   lifecycle events      → move the connection's status, unless a newer event
 *                           has already been applied (out-of-order delivery).
 *   anything for an unknown or disconnected connection → recorded, ignored.
 */

export const MAX_WEBHOOK_ATTEMPTS = 5;
/** A webhook event held PROCESSING longer than this is presumed abandoned. */
export const WEBHOOK_LEASE_SECONDS = 120;

export interface WebhookConnectionView {
  id: string;
  organizationId: string;
  status: ConnectionStatus;
  lastProviderEventAt: string | null;
}

export type WebhookPlan =
  | { kind: "ignore"; outcome: Extract<WebhookOutcome, "UNKNOWN_CONNECTION" | "CONNECTION_DISCONNECTED" | "UNSUPPORTED_EVENT" | "STALE_EVENT" | "NO_CHANGE"> }
  | { kind: "enqueue_sync" }
  | { kind: "transition"; from: ConnectionStatus; to: ConnectionStatus; reason: ConnectionStatusReason; eventAt: string | null };

const LIFECYCLE_EVENTS: Partial<Record<WebhookEventType, ConnectionEvent>> = {
  CONNECTION_REQUIRES_REAUTH: { kind: "PROVIDER_REAUTH_REQUIRED" },
  CONNECTION_ERROR: { kind: "PROVIDER_ERROR" },
  CONNECTION_REVOKED: { kind: "PROVIDER_REVOKED" },
  CONNECTION_RECOVERED: { kind: "PROVIDER_RECOVERED" },
};

export function planWebhookEvent(event: { type: WebhookEventType; occurredAt: string | null }, connection: WebhookConnectionView | null): WebhookPlan {
  if (!connection) return { kind: "ignore", outcome: "UNKNOWN_CONNECTION" };
  if (connection.status === "DISCONNECTED") return { kind: "ignore", outcome: "CONNECTION_DISCONNECTED" };
  if (event.type === "UNSUPPORTED") return { kind: "ignore", outcome: "UNSUPPORTED_EVENT" };

  if (event.type === "TRANSACTIONS_UPDATED") {
    return canSync(connection.status) ? { kind: "enqueue_sync" } : { kind: "ignore", outcome: "NO_CHANGE" };
  }

  // Consent expiry is advance notice, not a state: the connection still works
  // until the provider says re-authentication is required.
  if (event.type === "CONSENT_EXPIRING") return { kind: "ignore", outcome: "NO_CHANGE" };

  if (event.occurredAt && connection.lastProviderEventAt && new Date(event.occurredAt) <= new Date(connection.lastProviderEventAt)) {
    return { kind: "ignore", outcome: "STALE_EVENT" };
  }

  const lifecycleEvent = LIFECYCLE_EVENTS[event.type];
  if (!lifecycleEvent) return { kind: "ignore", outcome: "UNSUPPORTED_EVENT" };
  const decision = nextConnectionStatus(connection.status, lifecycleEvent);
  if (decision.kind !== "transition") return { kind: "ignore", outcome: "NO_CHANGE" };
  return { kind: "transition", from: decision.from, to: decision.to, reason: decision.reason, eventAt: event.occurredAt };
}
