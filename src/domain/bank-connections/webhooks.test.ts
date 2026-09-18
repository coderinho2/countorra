import { describe, expect, it } from "vitest";
import { planWebhookEvent, type WebhookConnectionView } from "./webhooks";

const connection = (overrides: Partial<WebhookConnectionView> = {}): WebhookConnectionView => ({
  id: "c1",
  organizationId: "o1",
  status: "ACTIVE",
  lastProviderEventAt: "2026-09-15T10:00:00Z",
  ...overrides,
});

describe("planning a verified webhook event", () => {
  it("enqueues a sync for new transactions, never applying the body as data", () => {
    expect(planWebhookEvent({ type: "TRANSACTIONS_UPDATED", occurredAt: null }, connection())).toEqual({ kind: "enqueue_sync" });
  });

  it("does nothing for an unknown or disconnected connection", () => {
    expect(planWebhookEvent({ type: "TRANSACTIONS_UPDATED", occurredAt: null }, null)).toEqual({ kind: "ignore", outcome: "UNKNOWN_CONNECTION" });
    expect(planWebhookEvent({ type: "CONNECTION_RECOVERED", occurredAt: null }, connection({ status: "DISCONNECTED" }))).toEqual({ kind: "ignore", outcome: "CONNECTION_DISCONNECTED" });
  });

  it("moves a connection that needs sign-in", () => {
    expect(planWebhookEvent({ type: "CONNECTION_REQUIRES_REAUTH", occurredAt: "2026-09-15T11:00:00Z" }, connection())).toEqual({
      kind: "transition",
      from: "ACTIVE",
      to: "REQUIRES_REAUTH",
      reason: "PROVIDER_REPORTED_REAUTH",
      eventAt: "2026-09-15T11:00:00Z",
    });
  });

  it("discards an older lifecycle event delivered after a newer one", () => {
    expect(planWebhookEvent({ type: "CONNECTION_ERROR", occurredAt: "2026-09-15T09:00:00Z" }, connection())).toEqual({ kind: "ignore", outcome: "STALE_EVENT" });
    expect(planWebhookEvent({ type: "CONNECTION_ERROR", occurredAt: "2026-09-15T10:00:00Z" }, connection())).toEqual({ kind: "ignore", outcome: "STALE_EVENT" });
  });

  it("does not sync a connection waiting for sign-in", () => {
    expect(planWebhookEvent({ type: "TRANSACTIONS_UPDATED", occurredAt: null }, connection({ status: "REQUIRES_REAUTH" }))).toEqual({ kind: "ignore", outcome: "NO_CHANGE" });
  });

  it("records unsupported events and consent notices without acting", () => {
    expect(planWebhookEvent({ type: "UNSUPPORTED", occurredAt: null }, connection())).toEqual({ kind: "ignore", outcome: "UNSUPPORTED_EVENT" });
    expect(planWebhookEvent({ type: "CONSENT_EXPIRING", occurredAt: null }, connection())).toEqual({ kind: "ignore", outcome: "NO_CHANGE" });
  });

  it("treats a repeated status as no change", () => {
    expect(planWebhookEvent({ type: "CONNECTION_REQUIRES_REAUTH", occurredAt: "2026-09-15T12:00:00Z" }, connection({ status: "REQUIRES_REAUTH" }))).toEqual({ kind: "ignore", outcome: "NO_CHANGE" });
  });
});
