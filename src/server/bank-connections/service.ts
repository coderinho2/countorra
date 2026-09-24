import { z } from "zod";
import { canSync } from "@/domain/bank-connections/lifecycle";
import {
  providerCompletedLinkSchema,
  providerConnectionStateSchema,
  providerLinkSessionSchema,
  resolveBankProvider,
  runBankProviderCall,
  type BankConnectionProvider,
  type ProviderSecret,
  type ProviderSecretStore,
} from "@/domain/bank-connections/provider";
import { decideReviewResolution, ledgerFieldsFor, candidateQueryFor, type ReviewResolution } from "@/domain/bank-connections/reconciliation";
import { decideSyncRequest, manualSyncReference, syncIdempotencyKey } from "@/domain/bank-connections/sync-job";
import type { ConnectionStatus, SyncFailureCategory } from "@/domain/bank-connections/types";
import { reportError, reportEvent } from "@/lib/observability";
import type { LinkOutcome, ReconcileOutcome } from "./store";
import { applyConnectionEvent, reconcileConnection, runBankSyncJob, type SyncDependencies, type SyncRunOutcome } from "./sync";
import { importedAccountKind } from "@/domain/bank-connections/account-import";

/**
 * Bank-connection operations, provider-independent and session-free.
 *
 * Server Actions (./actions.ts) authenticate, authorize and rate limit, then
 * call these with ids they have already scoped to the caller's organization.
 * Nothing here reads a browser session, and nothing here trusts an input
 * beyond the ids it was given: every object is re-read from the store in that
 * organization.
 */

export type ServiceDependencies = SyncDependencies;

// ── Linking a bank (provider Link flow) ─────────────────────────────────

export type LinkSessionOutcome =
  | { kind: "not_configured"; message: string }
  | { kind: "created"; linkToken: string; expiresAt: string; mode: "connect" | "reauthenticate" }
  | { kind: "not_found" }
  | { kind: "credential_unavailable" }
  | { kind: "provider_failed"; category: SyncFailureCategory };

/**
 * A short-lived token for the provider's own browser component — the ONLY
 * provider value that ever reaches a browser.
 *
 * With `connectionId`, the session re-opens an existing connection so the
 * person can sign in again (Plaid's update mode): the stored credential is
 * read server-side and handed to the provider, never to the client, and the
 * connection keeps its identity and its history.
 */
export async function createBankLinkSession(
  deps: Pick<ServiceDependencies, "providers" | "store" | "secrets">,
  input: { organizationId: string; userId: string; connectionId?: string },
): Promise<LinkSessionOutcome> {
  let reauthSecret: ProviderSecret | undefined;
  let providerId: string | undefined;

  if (input.connectionId) {
    const connection = await deps.store.getConnection(input.organizationId, input.connectionId);
    if (!connection || connection.status === "DISCONNECTED") return { kind: "not_found" };
    providerId = connection.provider;

    const reference = await deps.store.getCredentialRef(input.organizationId, connection.id);
    const secret = reference && deps.secrets ? await deps.secrets.get(reference).catch(() => null) : null;
    if (!secret) return { kind: "credential_unavailable" };
    reauthSecret = secret;
  }

  const availability = resolveBankProvider(deps.providers, providerId);
  if (!availability.available) return { kind: "not_configured", message: availability.message };

  const outcome = await runBankProviderCall(
    (signal) => availability.provider.createLinkSession({ organizationId: input.organizationId, userId: input.userId, reauthSecret, signal }),
    providerLinkSessionSchema,
    undefined,
    reauthSecret ? "create_update_link_token" : "create_link_token",
  );
  if (!outcome.ok) return { kind: "provider_failed", category: outcome.category };
  return { kind: "created", linkToken: outcome.value.linkToken, expiresAt: outcome.value.expiresAt, mode: reauthSecret ? "reauthenticate" : "connect" };
}

export type CompleteLinkOutcome =
  | { kind: "not_configured"; message: string }
  | { kind: "secret_store_unavailable" }
  | { kind: "provider_failed"; category: SyncFailureCategory }
  | { kind: "already_connected"; connectionId: string }
  | { kind: "belongs_elsewhere" }
  | { kind: "failed"; connectionId: string }
  | { kind: "connected"; connectionId: string; jobId: string | null };

/**
 * Exchanges a completed provider link for a connection.
 *
 * Order: provider exchange → connection row (PENDING) → credential into the
 * secret store → reference row → ACTIVE → initial sync job. A failure after the
 * row exists leaves it ERROR with no credential, never ACTIVE without one.
 *
 * A provider connection id already registered to ANOTHER organization is
 * refused — the unique constraint would refuse it too — and the reason given
 * does not say whose it is.
 */
export async function completeBankLink(deps: ServiceDependencies, input: { organizationId: string; userId: string; providerId: string; publicToken: string }): Promise<CompleteLinkOutcome> {
  const availability = resolveBankProvider(deps.providers, input.providerId);
  if (!availability.available) return { kind: "not_configured", message: availability.message };
  if (!deps.secrets) return { kind: "secret_store_unavailable" };
  const { provider } = availability;

  const exchanged = await runBankProviderCall((signal) => provider.completeLink({ publicToken: input.publicToken, signal }), providerCompletedLinkSchema, undefined, "exchange_public_token");
  if (!exchanged.ok) return { kind: "provider_failed", category: exchanged.category };
  const link = exchanged.value;

  const existing = await deps.store.findConnectionByProvider(provider.id, link.providerConnectionId);
  if (existing && existing.organizationId !== input.organizationId) {
    await bestEffortRevoke(provider, link.secret);
    return { kind: "belongs_elsewhere" };
  }
  if (existing && existing.status !== "DISCONNECTED") return { kind: "already_connected", connectionId: existing.id };
  if (existing) return { kind: "belongs_elsewhere" };

  const connectionId = await deps.store.createConnection({
    organizationId: input.organizationId,
    provider: provider.id,
    providerConnectionId: link.providerConnectionId,
    institutionId: link.institutionId,
    institutionName: link.institutionName,
    // From the provider, so a sandbox connection is recorded as one.
    providerEnvironment: link.providerEnvironment,
    createdBy: input.userId,
  });

  try {
    const secretRef = await deps.secrets.put({ organizationId: input.organizationId, connectionId, secret: link.secret });
    await deps.store.storeCredentialRef({ organizationId: input.organizationId, connectionId, secretRef });
  } catch (error) {
    reportError(error, { scope: "bank", organizationId: input.organizationId, detail: { step: "store_credential", connectionId, provider: provider.id } });
    await deps.store.transitionConnection({ organizationId: input.organizationId, connectionId, expectedStatus: "PENDING", to: "ERROR", reason: "CREDENTIAL_UNAVAILABLE", eventAt: null });
    return { kind: "failed", connectionId };
  }

  await applyConnectionEvent(deps, { id: connectionId, organizationId: input.organizationId, status: "PENDING", provider: provider.id }, { kind: "LINK_COMPLETED" }, null);
  const job = await deps.store.enqueueJob({
    organizationId: input.organizationId,
    connectionId,
    trigger: "INITIAL",
    idempotencyKey: syncIdempotencyKey({ connectionId, trigger: "INITIAL", reference: "link" }),
    requestedBy: input.userId,
    webhookEventId: null,
  });
  reportEvent("bank.connection_linked", { scope: "bank", organizationId: input.organizationId, detail: { connectionId, provider: provider.id } });
  return { kind: "connected", connectionId, jobId: job.jobId };
}

export type ReauthOutcome =
  | { kind: "not_found" }
  | { kind: "not_configured"; message: string }
  | { kind: "credential_unavailable" }
  | { kind: "provider_failed"; category: SyncFailureCategory }
  | { kind: "still_requires_reauth" }
  | { kind: "revoked" }
  | { kind: "provider_error" }
  | { kind: "reconnected"; jobId: string | null };

/**
 * Finishes a re-authentication: asks the PROVIDER whether the connection works
 * now, and only then records it as working.
 *
 * The browser saying Link succeeded is not evidence — a person can close the
 * dialog at any point, and a client can claim anything. So the provider's own
 * view of the item decides, and a connection that is still broken stays broken
 * rather than looking active and silently importing nothing.
 */
export async function completeBankReauth(deps: ServiceDependencies, input: { organizationId: string; connectionId: string; userId: string }): Promise<ReauthOutcome> {
  const connection = await deps.store.getConnection(input.organizationId, input.connectionId);
  if (!connection || connection.status === "DISCONNECTED") return { kind: "not_found" };

  const availability = resolveBankProvider(deps.providers, connection.provider);
  if (!availability.available) return { kind: "not_configured", message: availability.message };

  const reference = await deps.store.getCredentialRef(input.organizationId, connection.id);
  const secret = reference && deps.secrets ? await deps.secrets.get(reference).catch(() => null) : null;
  if (!secret) return { kind: "credential_unavailable" };

  const inspected = await runBankProviderCall((signal) => availability.provider.inspectConnection({ secret, signal }), providerConnectionStateSchema, undefined, "inspect_item");
  if (!inspected.ok) return { kind: "provider_failed", category: inspected.category };

  if (inspected.value.health === "REQUIRES_REAUTH") return { kind: "still_requires_reauth" };
  if (inspected.value.health === "REVOKED") {
    await applyConnectionEvent(deps, connection, { kind: "PROVIDER_REVOKED" }, null);
    return { kind: "revoked" };
  }
  if (inspected.value.health === "ERROR") {
    await applyConnectionEvent(deps, connection, { kind: "PROVIDER_ERROR" }, null);
    return { kind: "provider_error" };
  }

  await applyConnectionEvent(deps, connection, { kind: "PROVIDER_RECOVERED" }, null);
  const job = await deps.store.enqueueJob({
    organizationId: input.organizationId,
    connectionId: connection.id,
    trigger: "MANUAL",
    idempotencyKey: syncIdempotencyKey({ connectionId: connection.id, trigger: "MANUAL", reference: `reauth-${manualSyncReference(deps.now())}` }),
    requestedBy: input.userId,
    webhookEventId: null,
  });
  reportEvent("bank.connection_reauthenticated", { scope: "bank", organizationId: input.organizationId, detail: { connectionId: connection.id, provider: connection.provider } });
  return { kind: "reconnected", jobId: job.jobId };
}

async function bestEffortRevoke(provider: BankConnectionProvider, secret: ProviderSecret): Promise<boolean> {
  const outcome = await runBankProviderCall((signal) => provider.revoke({ secret, signal }), z.unknown(), undefined, "remove_item");
  return outcome.ok;
}

// ── Requesting a sync ───────────────────────────────────────────────────

export type SyncRequestOutcome =
  | { kind: "not_found" }
  | { kind: "not_configured"; message: string }
  | { kind: "not_syncable"; status: ConnectionStatus }
  | { kind: "already_active"; jobId: string | null }
  | { kind: "recently_synced"; retryAfterSeconds: number }
  | { kind: "queued"; jobId: string; run: SyncRunOutcome | null };

/**
 * A person asked for a refresh. One job per five-minute window and one active
 * job per connection, both enforced by the database; the run starts inline with
 * a small page budget, and any remainder waits in a CONTINUATION job for the
 * worker integration point.
 */
export async function requestBankSync(
  deps: ServiceDependencies,
  input: { organizationId: string; connectionId: string; userId: string; runInline: boolean; inlinePages?: number },
): Promise<SyncRequestOutcome> {
  const connection = await deps.store.getConnection(input.organizationId, input.connectionId);
  if (!connection) return { kind: "not_found" };
  const availability = resolveBankProvider(deps.providers, connection.provider);
  if (!availability.available) return { kind: "not_configured", message: availability.message };
  if (!canSync(connection.status)) return { kind: "not_syncable", status: connection.status };

  const now = deps.now();
  const activeJob = await deps.store.getActiveJob(input.organizationId, connection.id);
  const decision = decideSyncRequest({
    connectionId: connection.id,
    connectionStatus: connection.status,
    activeJob,
    lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
    trigger: "MANUAL",
    reference: manualSyncReference(now),
    now,
  });

  switch (decision.kind) {
    case "refused":
      return { kind: "not_syncable", status: connection.status };
    case "already_active":
      return { kind: "already_active", jobId: decision.jobId };
    case "recently_synced":
      return { kind: "recently_synced", retryAfterSeconds: decision.retryAfterSeconds };
    case "enqueue": {
      const enqueued = await deps.store.enqueueJob({ organizationId: input.organizationId, connectionId: connection.id, trigger: "MANUAL", idempotencyKey: decision.idempotencyKey, requestedBy: input.userId, webhookEventId: null });
      if (enqueued.outcome === "NOT_FOUND") return { kind: "not_found" };
      if (enqueued.outcome === "CONNECTION_DISCONNECTED") return { kind: "not_syncable", status: "DISCONNECTED" };
      if (enqueued.outcome !== "CREATED" || !enqueued.jobId) return { kind: "already_active", jobId: enqueued.jobId };
      const run = input.runInline ? await runBankSyncJob({ ...deps, maxPages: input.inlinePages ?? 3 }, { organizationId: input.organizationId, jobId: enqueued.jobId }) : null;
      return { kind: "queued", jobId: enqueued.jobId, run };
    }
  }
}

// ── Disconnecting ───────────────────────────────────────────────────────

export type DisconnectResult =
  | { kind: "not_found" }
  | { kind: "already_disconnected" }
  | { kind: "secret_store_unavailable" }
  | { kind: "credential_destroy_failed" }
  | { kind: "disconnected"; previousStatus: ConnectionStatus; providerRevoked: boolean | null };

/**
 * Disconnects a connection without deleting any financial history.
 *
 * The credential is revoked at the provider (best effort — a provider outage
 * must not trap a person in a connection they want to end) and then destroyed
 * in the secret store (required — if Countorra cannot destroy its copy, it does
 * not claim to have disconnected). Only then does the database mark the
 * connection DISCONNECTED, cancel its jobs and detach its accounts, in one
 * transaction. Imported ledger transactions are untouched.
 */
export async function disconnectBankConnection(deps: ServiceDependencies, input: { organizationId: string; connectionId: string; actorId: string }): Promise<DisconnectResult> {
  const connection = await deps.store.getConnection(input.organizationId, input.connectionId);
  if (!connection) return { kind: "not_found" };
  if (connection.status === "DISCONNECTED") return { kind: "already_disconnected" };

  let providerRevoked: boolean | null = null;
  const secretRef = await deps.store.getCredentialRef(input.organizationId, connection.id);
  if (secretRef) {
    if (!deps.secrets) return { kind: "secret_store_unavailable" };
    try {
      const secret = await deps.secrets.get(secretRef);
      const availability = resolveBankProvider(deps.providers, connection.provider);
      if (secret && availability.available) providerRevoked = await bestEffortRevoke(availability.provider, secret);
      await deps.secrets.destroy(secretRef);
    } catch (error) {
      reportError(error, { scope: "bank", organizationId: input.organizationId, detail: { step: "destroy_credential", connectionId: connection.id, provider: connection.provider } });
      return { kind: "credential_destroy_failed" };
    }
  }

  const previous = await deps.store.finalizeDisconnect(input.organizationId, connection.id, input.actorId);
  if (previous === "NOT_FOUND") return { kind: "not_found" };
  if (previous === "ALREADY_DISCONNECTED") return { kind: "already_disconnected" };
  reportEvent("bank.connection_disconnected", { scope: "bank", organizationId: input.organizationId, detail: { connectionId: connection.id, provider: connection.provider, previousStatus: previous, providerRevoked } });
  return { kind: "disconnected", previousStatus: previous, providerRevoked };
}

/**
 * Before an organization is deleted: destroy every provider credential it holds.
 *
 * The reference rows disappear with the organization (ON DELETE CASCADE), but
 * the credential itself lives in the secret store, which no cascade reaches. If
 * any credential exists and cannot be destroyed, deletion must not proceed —
 * the alternative is a live bank credential nobody can find.
 */
export async function releaseOrganizationBankCredentials(
  deps: Pick<ServiceDependencies, "store" | "providers" | "secrets">,
  organizationId: string,
): Promise<{ ok: true; released: number } | { ok: false; reason: "SECRET_STORE_UNAVAILABLE" | "DESTROY_FAILED" }> {
  const refs = await deps.store.listCredentialRefs(organizationId);
  if (refs.length === 0) return { ok: true, released: 0 };
  if (!deps.secrets) return { ok: false, reason: "SECRET_STORE_UNAVAILABLE" };

  for (const ref of refs) {
    try {
      const secret = await deps.secrets.get(ref.secretRef);
      const availability = resolveBankProvider(deps.providers, ref.provider);
      if (secret && availability.available) await bestEffortRevoke(availability.provider, secret);
      await deps.secrets.destroy(ref.secretRef);
    } catch (error) {
      reportError(error, { scope: "bank", organizationId, detail: { step: "release_credentials", connectionId: ref.connectionId, provider: ref.provider } });
      return { ok: false, reason: "DESTROY_FAILED" };
    }
  }
  reportEvent("bank.credentials_released", { scope: "bank", organizationId, detail: { released: refs.length } });
  return { ok: true, released: refs.length };
}

// ── Linking an external account to a Countorra account ──────────────────

export type LinkAccountResult = { kind: "applied"; reconciled: number } | { kind: "refused"; reason: Exclude<LinkOutcome, "APPLIED"> };

export async function linkExternalAccount(
  deps: Pick<ServiceDependencies, "store" | "now">,
  input: { organizationId: string; linkedAccountId: string; accountId: string | null; importMode: "IMPORT" | "IGNORE"; actorId: string },
): Promise<LinkAccountResult> {
  const linked = await deps.store.getLinkedAccount(input.organizationId, input.linkedAccountId);
  if (!linked) return { kind: "refused", reason: "NOT_FOUND" };
  // Plaid-first (0054): a bank account is imported only as the kind it is,
  // and only if that kind is supported. A person may still point one at an
  // account they kept by hand before connecting — of the same kind — so that
  // history carries over; never at a cash account, never a loan at anything.
  if (input.importMode === "IMPORT") {
    const expected = importedAccountKind(linked.accountType, linked.accountSubtype);
    if (!expected) return { kind: "refused", reason: "UNSUPPORTED_ACCOUNT_TYPE" };
    if (input.accountId) {
      const kind = await deps.store.getAccountKind(input.organizationId, input.accountId);
      if (kind === null) return { kind: "refused", reason: "NOT_FOUND" };
      if (kind !== expected) return { kind: "refused", reason: "ACCOUNT_KIND_MISMATCH" };
    }
  }
  const outcome = await deps.store.linkAccount({ organizationId: input.organizationId, linkedAccountId: linked.id, accountId: input.importMode === "IMPORT" ? input.accountId : null, importMode: input.importMode, actorId: input.actorId });
  if (outcome !== "APPLIED") return { kind: "refused", reason: outcome };

  // What was waiting on this decision is reconciled now — no provider call
  // is needed for that, only the rows already recorded.
  const counts = await reconcileConnection(deps, { organizationId: input.organizationId, connectionId: linked.connectionId, runId: null, budget: { remaining: 1_000 } });
  return { kind: "applied", reconciled: counts.reconciled };
}

/**
 * "Import as a new account": the person's choice when the workspace already
 * has an account of that kind they kept by hand, and this bank account is a
 * different one. Creates the Countorra account from the bank account and
 * reconciles what was waiting on it — the same path the automatic import
 * takes (bank_import_linked_account, 0054).
 */
export async function importExternalAccountAsNew(
  deps: Pick<ServiceDependencies, "store" | "now">,
  input: { organizationId: string; linkedAccountId: string; actorId: string },
): Promise<LinkAccountResult> {
  const linked = await deps.store.getLinkedAccount(input.organizationId, input.linkedAccountId);
  if (!linked) return { kind: "refused", reason: "NOT_FOUND" };
  const outcome = await deps.store.importLinkedAccount({ organizationId: input.organizationId, linkedAccountId: linked.id, actorId: input.actorId });
  if (outcome !== "APPLIED") return { kind: "refused", reason: outcome };
  const counts = await reconcileConnection(deps, { organizationId: input.organizationId, connectionId: linked.connectionId, runId: null, budget: { remaining: 1_000 } });
  return { kind: "applied", reconciled: counts.reconciled };
}

// ── A person resolving a review ─────────────────────────────────────────

export type ResolveReviewResult = { kind: "applied" } | { kind: "refused"; reason: "NOT_FOUND" | "NOT_UNDER_REVIEW" | "NOT_APPLICABLE" | "UNSUPPORTED_CURRENCY" | "NOT_A_CANDIDATE" | Exclude<ReconcileOutcome, "APPLIED"> };

export async function resolveBankReview(
  deps: Pick<ServiceDependencies, "store" | "now">,
  input: { organizationId: string; externalId: string; resolution: ReviewResolution; actorId: string },
): Promise<ResolveReviewResult> {
  const row = await deps.store.getReconciliationRow(input.organizationId, input.externalId);
  if (!row) return { kind: "refused", reason: "NOT_FOUND" };

  let candidates = null;
  if (input.resolution.kind === "MATCH_TO" && row.account) {
    const fields = ledgerFieldsFor(row.external, row.account.id);
    candidates = fields ? await deps.store.matchCandidates(input.organizationId, candidateQueryFor(fields)) : [];
  }

  const decided = decideReviewResolution({ ...row, candidates }, input.resolution);
  if (!decided.ok) return { kind: "refused", reason: decided.reason };

  const outcome = await deps.store.reconcile({
    organizationId: input.organizationId,
    externalId: row.external.id,
    expectedRevision: row.external.revision,
    decision: decided.decision,
    acknowledged: decided.acknowledged,
    runId: null,
    actorId: input.actorId,
    resolution: true,
  });
  return outcome === "APPLIED" ? { kind: "applied" } : { kind: "refused", reason: outcome };
}

export type { ProviderSecretStore };
