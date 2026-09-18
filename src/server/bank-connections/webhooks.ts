import { providerWebhookEventSchema, resolveBankProvider, runBankProviderCall } from "@/domain/bank-connections/provider";
import { syncIdempotencyKey } from "@/domain/bank-connections/sync-job";
import type { WebhookOutcome } from "@/domain/bank-connections/types";
import { WEBHOOK_LEASE_SECONDS, planWebhookEvent } from "@/domain/bank-connections/webhooks";
import { reportError, reportEvent } from "@/lib/observability";
import { applyConnectionEvent, type SyncDependencies } from "./sync";

/**
 * THE PROVIDER-INDEPENDENT WEBHOOK BOUNDARY.
 *
 * An unauthenticated request arrives from the internet. In order:
 *
 *   1. The provider must be configured on this deployment. It is not, so every
 *      request today ends here with 404 and no database write.
 *   2. The raw body is bounded and handed to the provider adapter's signature
 *      verification. Anything unverified is refused with 400, and its body is
 *      never parsed, logged or stored.
 *   3. The verified event's id is CLAIMED in `bank_webhook_events`. A duplicate —
 *      sequential or concurrent — gets 200 and does nothing.
 *   4. The event is resolved to a connection by the provider's connection id,
 *      which authorizes nothing: it can only name a connection this provider
 *      owns, and the unique constraint means that connection is in exactly one
 *      organization.
 *   5. The plan (src/domain/bank-connections/webhooks.ts) is applied. No
 *      financial row is written here: "transactions updated" enqueues a sync
 *      job, which fetches from the provider with the stored credential.
 *
 * Status codes are a contract with the provider's retry logic: 400 never
 * retried, 404 not configured, 200 handled or duplicate, 503 retry later.
 */

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export interface WebhookResponse {
  status: 200 | 400 | 404 | 413 | 503;
  body: Record<string, string | boolean>;
}

export async function ingestBankWebhook(
  deps: Pick<SyncDependencies, "store" | "providers" | "now" | "hash" | "audit">,
  input: { providerId: string; rawBody: string; headers: Readonly<Record<string, string>> },
): Promise<WebhookResponse> {
  const availability = resolveBankProvider(deps.providers, input.providerId);
  if (!availability.available) return { status: 404, body: { error: "not_configured" } };
  const { provider } = availability;

  if (Buffer.byteLength(input.rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) return { status: 413, body: { error: "too_large" } };

  const verified = await runBankProviderCall((signal) => {
    void signal;
    return provider.verifyWebhook({ rawBody: input.rawBody, headers: input.headers, receivedAt: deps.now() });
  }, providerWebhookEventSchema, 10_000);
  if (!verified.ok) {
    reportEvent("bank.webhook_rejected", { scope: "bank", detail: { provider: provider.id, errorCategory: verified.category } }, "warning");
    return { status: 400, body: { error: "unverified" } };
  }
  const event = verified.value;

  const claim = await deps.store.claimWebhookEvent({
    provider: provider.id,
    providerEventId: event.providerEventId,
    eventType: event.type,
    providerEventType: event.providerEventType,
    providerConnectionId: event.providerConnectionId,
    occurredAt: event.occurredAt,
    payloadSha256: deps.hash(input.rawBody),
    leaseSeconds: WEBHOOK_LEASE_SECONDS,
  });
  if (!claim.claimed) {
    if (!claim.payloadMatches) reportEvent("bank.webhook_replayed_with_different_body", { scope: "bank", detail: { provider: provider.id, webhookEventId: claim.eventId } }, "warning");
    return { status: 200, body: { received: true, duplicate: true } };
  }

  let organizationId: string | null = null;
  let connectionId: string | null = null;
  try {
    const connection = event.providerConnectionId ? await deps.store.findConnectionByProvider(provider.id, event.providerConnectionId) : null;
    organizationId = connection?.organizationId ?? null;
    connectionId = connection?.id ?? null;
    const plan = planWebhookEvent(event, connection);

    let outcome: WebhookOutcome;
    let handled: "PROCESSED" | "IGNORED" = "PROCESSED";

    if (plan.kind === "ignore" || !connection) {
      outcome = plan.kind === "ignore" ? plan.outcome : "UNKNOWN_CONNECTION";
      handled = "IGNORED";
    } else if (plan.kind === "enqueue_sync") {
      const enqueued = await deps.store.enqueueJob({
        organizationId: connection.organizationId,
        connectionId: connection.id,
        trigger: "WEBHOOK",
        idempotencyKey: syncIdempotencyKey({ connectionId: connection.id, trigger: "WEBHOOK", reference: event.providerEventId }),
        requestedBy: null,
        webhookEventId: claim.eventId,
      });
      if (enqueued.outcome === "CREATED") outcome = "SYNC_ENQUEUED";
      else if (enqueued.outcome === "CONNECTION_DISCONNECTED" || enqueued.outcome === "NOT_FOUND") {
        outcome = "CONNECTION_DISCONNECTED";
        handled = "IGNORED";
      } else outcome = "SYNC_ALREADY_ACTIVE";
    } else {
      const applied = await applyConnectionEvent(deps, connection, eventFor(event.type), plan.eventAt);
      if (applied === "APPLIED") outcome = "STATUS_UPDATED";
      else {
        outcome = applied === "STALE" ? "STALE_EVENT" : "NO_CHANGE";
        handled = "IGNORED";
      }
    }

    await deps.store.completeWebhookEvent({ eventId: claim.eventId, status: handled, outcome, organizationId, connectionId });
    reportEvent("bank.webhook_handled", { scope: "bank", organizationId: organizationId ?? undefined, detail: { provider: provider.id, webhookEventId: claim.eventId, eventType: event.type, outcome, connectionId } });
    return { status: 200, body: { received: true } };
  } catch (error) {
    reportError(error, { scope: "bank", organizationId: organizationId ?? undefined, detail: { step: "handle_webhook", provider: provider.id, webhookEventId: claim.eventId, eventType: event.type } });
    await deps.store.completeWebhookEvent({ eventId: claim.eventId, status: "FAILED", outcome: null, organizationId, connectionId }).catch(() => undefined);
    return { status: 503, body: { error: "retry" } };
  }
}

function eventFor(type: string) {
  switch (type) {
    case "CONNECTION_REQUIRES_REAUTH":
      return { kind: "PROVIDER_REAUTH_REQUIRED" } as const;
    case "CONNECTION_ERROR":
      return { kind: "PROVIDER_ERROR" } as const;
    case "CONNECTION_REVOKED":
      return { kind: "PROVIDER_REVOKED" } as const;
    default:
      return { kind: "PROVIDER_RECOVERED" } as const;
  }
}
