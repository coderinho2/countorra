"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/server/supabase/server";
import { requireOrgMembership, requireUser } from "@/server/auth/session";
import { can } from "@/domain/organizations/permissions";
import { recordAuditEvent, AUDIT_ACTIONS } from "@/domain/audit/audit-log";
import { enforceRateLimit } from "@/server/security/rate-limit";
import { reportError } from "@/lib/observability";
import { getSubscription } from "@/server/db/repositories/subscriptions";
import { entitlementsFor } from "@/domain/billing/entitlements";
import { BANK_PROVIDER_NOT_CONFIGURED_MESSAGE } from "@/domain/bank-connections/provider";
import { CONNECTION_STATUS_PRESENTATION, SYNC_FAILURE_TEXT } from "@/domain/bank-connections/presentation";
import { bankLinkStateKeyset, configuredBankProviders } from "./providers";
import { clearBankLinkStateCookie, openBankLinkState, readBankLinkStateCookie, sealBankLinkState, writeBankLinkStateCookie } from "./link-state";
import { productionBankDependencies } from "./runtime";
import { completeBankLink, completeBankReauth, createBankLinkSession, disconnectBankConnection, linkExternalAccount, requestBankSync, resolveBankReview, type LinkAccountResult, type ResolveReviewResult } from "./service";

/**
 * Bank-connection Server Actions.
 *
 * The order every mutation in this codebase follows: validate the form,
 * authenticate and authorize against the organization in the request (which
 * `requireOrgMembership` re-derives from the session — the browser cannot name
 * an organization it does not belong to), rate limit, then act. Only ids and a
 * small enum ever come from the browser. A connection's status, its provider,
 * an amount, an account's currency — all of it is read server-side.
 *
 * With no provider configured, connecting and syncing return the honest "not
 * configured" answer. Linking accounts, resolving reviews and disconnecting
 * still work on connections that exist, because none of those need a provider.
 */

export interface BankActionResult {
  error?: string;
  success?: boolean;
  message?: string;
  /** Handed to the provider's own browser component. Short-lived, carries no
   *  credential, and never stored. */
  linkToken?: string;
  /** Whether that token opens a new connection or repairs an existing one. */
  mode?: "connect" | "reauthenticate";
  /** Only ever the SERVER's answer, after a bank OAuth return, about which
   *  organization the resumed session belongs to — so the page can go back
   *  there. Never read from the browser. */
  organizationId?: string;
}

const GENERIC_FAILURE = "That couldn't be completed, and nothing was changed. Please try again.";

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

/**
 * Two separate facts, checked in this order and never conflated.
 *
 * Whether a bank provider EXISTS on this deployment is not a question about
 * the customer's plan, and no purchase changes it — so an unconfigured
 * deployment says exactly that, to everyone. Only when a provider does exist
 * does the plan decide, from the canonical entitlement model (a lapsed
 * subscription is Free there, so it is Free here).
 */
async function bankAccess(client: Awaited<ReturnType<typeof createClient>>, organizationId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (configuredBankProviders().length === 0) return { ok: false, error: BANK_PROVIDER_NOT_CONFIGURED_MESSAGE };
  const entitlements = entitlementsFor(await getSubscription(client, organizationId));
  if (!entitlements.bankConnections) {
    return { ok: false, error: `Bank connections are part of Premium and Business. This workspace is on ${entitlements.name}.` };
  }
  return { ok: true };
}

function revalidateBankPages(organizationId: string, ledgerChanged: boolean) {
  revalidatePath(`/app/${organizationId}/bank-connections`);
  if (ledgerChanged) {
    revalidatePath(`/app/${organizationId}/transactions`);
    revalidatePath(`/app/${organizationId}/accounts`);
    revalidatePath(`/app/${organizationId}/dashboard`);
  }
}

// ── Connect ─────────────────────────────────────────────────────────────

const startLinkSchema = z.object({ organizationId: z.uuid(), connectionId: z.uuid().optional() });

/**
 * Creates the Link token the provider's browser component needs.
 *
 * The token is the only provider value that ever reaches a browser: it is
 * short-lived, scoped to this person and this organization by the server, and
 * carries no credential. With `connectionId` it re-opens an existing
 * connection for re-authentication, and the stored access token is read
 * server-side — the browser neither sends nor sees it.
 */
export async function startBankLinkAction(_prev: BankActionResult, formData: FormData): Promise<BankActionResult> {
  const parsed = startLinkSchema.safeParse({ organizationId: field(formData, "organizationId"), connectionId: field(formData, "connectionId") || undefined });
  if (!parsed.success) return { error: "That request isn't valid." };
  const { organizationId, connectionId } = parsed.data;

  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "bank:manage")) return { error: "Only an owner or admin can connect a bank." };
  const limited = await enforceRateLimit("bankLinkSession", { bankLinkSessionPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const client = await createClient();
  const access = await bankAccess(client, organizationId);
  if (!access.ok) return { error: access.error };

  try {
    const outcome = await createBankLinkSession(productionBankDependencies(), { organizationId, userId: user.id, connectionId });
    switch (outcome.kind) {
      case "not_configured":
        return { error: outcome.message };
      case "not_found":
        return { error: "That bank connection wasn't found." };
      case "credential_unavailable":
        return { error: "This connection's stored access can't be read, so it can't be repaired. Disconnect it and connect the bank again." };
      case "provider_failed":
        return { error: SYNC_FAILURE_TEXT[outcome.category] };
      case "created": {
        // Sealed now, while every fact in it has just been verified: this is
        // what an OAuth bank's redirect comes back to, instead of a URL that
        // names an organization.
        const keyset = bankLinkStateKeyset();
        if (keyset) {
          await writeBankLinkStateCookie(
            sealBankLinkState({ userId: user.id, organizationId, connectionId: connectionId ?? null, mode: outcome.mode, linkToken: outcome.linkToken }, keyset, new Date()),
          );
        }
        await recordAuditEvent(client, {
          organizationId,
          action: AUDIT_ACTIONS.bankLinkStarted,
          resourceType: connectionId ? "bank_connection" : "organization",
          resourceId: connectionId ?? organizationId,
          metadata: { mode: outcome.mode },
        });
        return { success: true, linkToken: outcome.linkToken, mode: outcome.mode };
      }
    }
  } catch (error) {
    reportError(error, { scope: "bank", organizationId, userId: user.id, detail: { step: "start_link", mode: connectionId ? "reauthenticate" : "connect" } });
    return { error: GENERIC_FAILURE };
  }
}

// The provider is NOT a client input: the deployment has one, and the server
// knows which. A public token is meaningless to any other provider anyway.
const completeLinkSchema = z.object({
  organizationId: z.uuid(),
  publicToken: z.string().min(1).max(2048),
});

export async function completeBankLinkAction(_prev: BankActionResult, formData: FormData): Promise<BankActionResult> {
  const parsed = completeLinkSchema.safeParse({ organizationId: field(formData, "organizationId"), publicToken: field(formData, "publicToken") });
  if (!parsed.success) return { error: "That request isn't valid." };
  const { organizationId } = parsed.data;

  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "bank:manage")) return { error: "Only an owner or admin can connect a bank." };
  const limited = await enforceRateLimit("bankLinkSession", { bankLinkSessionPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const client = await createClient();
  const access = await bankAccess(client, organizationId);
  if (!access.ok) return { error: access.error };

  const result = await finishLink(client, organizationId, user.id, parsed.data.publicToken);
  // Finished in the page, without a bank redirect: the sealed session has
  // nothing left to resume, so it goes.
  if (result.success) await clearBankLinkStateCookie();
  return result;
}

/**
 * Exchanges a public token for a connection in an organization that has
 * ALREADY been authorized by the caller — membership, permission, rate limit
 * and entitlement. Shared by the in-page completion and the OAuth return, so
 * both paths reach the provider through exactly the same code.
 */
async function finishLink(client: Awaited<ReturnType<typeof createClient>>, organizationId: string, userId: string, publicToken: string): Promise<BankActionResult> {
  const providerId = configuredBankProviders()[0]?.id;
  if (!providerId) return { error: BANK_PROVIDER_NOT_CONFIGURED_MESSAGE };

  try {
    const outcome = await completeBankLink(productionBankDependencies(), { organizationId, userId, providerId, publicToken });
    switch (outcome.kind) {
      case "not_configured":
        return { error: outcome.message };
      case "secret_store_unavailable":
        return { error: "Bank connections can't store access securely on this deployment, so nothing was connected." };
      case "provider_failed":
        return { error: SYNC_FAILURE_TEXT[outcome.category] };
      case "belongs_elsewhere":
        return { error: "That bank connection can't be added to this workspace." };
      case "already_connected":
        return { success: true, message: "That bank is already connected." };
      case "failed":
        return { error: "The bank was reached, but its access couldn't be stored. Nothing will be imported from it." };
      case "connected":
        await recordAuditEvent(client, {
          organizationId,
          action: AUDIT_ACTIONS.bankConnectionConnected,
          resourceType: "bank_connection",
          resourceId: outcome.connectionId,
          metadata: { provider: providerId },
        });
        revalidateBankPages(organizationId, false);
        return { success: true, message: "Connected. Choose which account each bank account feeds before anything is imported." };
    }
  } catch (error) {
    reportError(error, { scope: "bank", organizationId, userId, detail: { step: "complete_link" } });
    return { error: GENERIC_FAILURE };
  }
}

/**
 * Finishes a re-authentication.
 *
 * Deliberately takes no evidence from the browser beyond the ids: the server
 * asks the provider whether the connection actually works now, so a closed
 * dialog or a forged call cannot mark a broken connection active.
 */
export async function completeBankReauthAction(_prev: BankActionResult, formData: FormData): Promise<BankActionResult> {
  const parsed = connectionSchema.safeParse({ organizationId: field(formData, "organizationId"), connectionId: field(formData, "connectionId") });
  if (!parsed.success) return { error: "That request isn't valid." };
  const { organizationId, connectionId } = parsed.data;

  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "bank:manage")) return { error: "Only an owner or admin can repair a bank connection." };
  const limited = await enforceRateLimit("bankLinkSession", { bankLinkSessionPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const client = await createClient();
  const access = await bankAccess(client, organizationId);
  if (!access.ok) return { error: access.error };

  const result = await finishReauth(client, organizationId, user.id, connectionId);
  if (result.success) await clearBankLinkStateCookie();
  return result;
}

/** The repair, for an organization the caller has already been authorized
 *  in. Shared by the in-page path and the OAuth return. */
async function finishReauth(client: Awaited<ReturnType<typeof createClient>>, organizationId: string, userId: string, connectionId: string): Promise<BankActionResult> {
  try {
    const outcome = await completeBankReauth(productionBankDependencies(), { organizationId, connectionId, userId });
    switch (outcome.kind) {
      case "not_found":
        return { error: "That bank connection wasn't found." };
      case "not_configured":
        return { error: outcome.message };
      case "credential_unavailable":
        return { error: "This connection's stored access can't be read. Disconnect it and connect the bank again." };
      case "provider_failed":
        return { error: SYNC_FAILURE_TEXT[outcome.category] };
      case "still_requires_reauth":
        return { error: "The bank still needs you to sign in. Nothing was changed." };
      case "revoked":
        return { error: "Access was withdrawn at the bank, so this connection can't be repaired. Transactions already imported stay in your books." };
      case "provider_error":
        return { error: "The connection still reports a problem. Nothing was changed." };
      case "reconnected":
        await recordAuditEvent(client, {
          organizationId,
          action: AUDIT_ACTIONS.bankConnectionReauthenticated,
          resourceType: "bank_connection",
          resourceId: connectionId,
          metadata: { jobId: outcome.jobId },
        });
        revalidateBankPages(organizationId, true);
        return { success: true, message: "Reconnected. Importing again from where it left off." };
    }
  } catch (error) {
    reportError(error, { scope: "bank", organizationId, userId, detail: { step: "complete_reauth", connectionId } });
    return { error: GENERIC_FAILURE };
  }
}

// ── OAuth return ────────────────────────────────────────────────────────
//
// A bank that signs the customer in on its own site sends them back to ONE
// fixed path (BANK_OAUTH_RETURN_PATH) for every organization. Neither action
// below accepts an organization, a connection or a mode from the browser —
// they come only from the session sealed when Link started — and neither
// trusts that seal on its own: the session user must be the sealed user, and
// membership, permission, entitlement and rate limits are checked again.

const NO_SESSION_TO_RESUME = "There's no bank sign-in to finish here. Start again from Bank connections.";

type SealedSession = NonNullable<ReturnType<typeof openBankLinkState>>;

/** Opens the sealed session and checks it still belongs to whoever is signed
 *  in now. A seal that is missing, forged, expired or someone else's is the
 *  same answer: nothing to resume. */
async function sealedSessionForCaller(): Promise<{ ok: true; state: SealedSession } | { ok: false; error: string }> {
  const keyset = bankLinkStateKeyset();
  const state = keyset ? openBankLinkState(await readBankLinkStateCookie(), keyset, new Date()) : null;
  if (!state) return { ok: false, error: NO_SESSION_TO_RESUME };

  const user = await requireUser();
  if (user.id !== state.userId) {
    // Another person's session left in this browser. Theirs to finish, not
    // this user's — and it cannot be finished now, so it goes.
    await clearBankLinkStateCookie();
    return { ok: false, error: NO_SESSION_TO_RESUME };
  }
  return { ok: true, state };
}

/**
 * Called by the fixed return page to re-open the SAME Link session the
 * customer started. Returns the Link token (to the page's memory only — it is
 * never stored in the browser) and the organization the server sealed.
 */
export async function resumeBankOauthAction(): Promise<BankActionResult> {
  const sealed = await sealedSessionForCaller();
  if (!sealed.ok) return { error: sealed.error };
  const { state } = sealed;

  const { membership } = await requireOrgMembership(state.organizationId);
  if (!can(membership.role, "bank:manage")) {
    await clearBankLinkStateCookie();
    return { error: state.mode === "reauthenticate" ? "Only an owner or admin can repair a bank connection." : "Only an owner or admin can connect a bank." };
  }

  return { success: true, linkToken: state.linkToken, mode: state.mode, organizationId: state.organizationId };
}

const completeOauthSchema = z.object({ publicToken: z.string().min(1).max(2048).optional() });

/**
 * Finishes the Link session after a bank OAuth return. The organization, the
 * connection and the mode are the sealed ones; anything else in the request —
 * an `organizationId` included — is not even read.
 */
export async function completeBankOauthAction(_prev: BankActionResult, formData: FormData): Promise<BankActionResult> {
  const parsed = completeOauthSchema.safeParse({ publicToken: field(formData, "publicToken") || undefined });
  if (!parsed.success) return { error: "That request isn't valid." };

  const sealed = await sealedSessionForCaller();
  if (!sealed.ok) return { error: sealed.error };
  const { state } = sealed;
  const { organizationId } = state;

  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "bank:manage")) {
    await clearBankLinkStateCookie();
    return { error: state.mode === "reauthenticate" ? "Only an owner or admin can repair a bank connection." : "Only an owner or admin can connect a bank." };
  }
  // Refused but retryable: the seal stays until it expires.
  const limited = await enforceRateLimit("bankLinkSession", { bankLinkSessionPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const client = await createClient();
  const access = await bankAccess(client, organizationId);
  if (!access.ok) {
    await clearBankLinkStateCookie();
    return { error: access.error };
  }

  let result: BankActionResult;
  if (state.mode === "reauthenticate" && state.connectionId) {
    result = await finishReauth(client, organizationId, user.id, state.connectionId);
  } else {
    if (!parsed.data.publicToken) return { error: "The bank didn't return anything to complete. Nothing was connected." };
    result = await finishLink(client, organizationId, user.id, parsed.data.publicToken);
  }

  // One use. A public token is single-use at the provider, so a failed
  // exchange cannot be retried with this seal either: the customer starts again.
  await clearBankLinkStateCookie();
  return { ...result, organizationId };
}

// ── Sync ────────────────────────────────────────────────────────────────

const connectionSchema = z.object({ organizationId: z.uuid(), connectionId: z.uuid() });

export async function requestBankSyncAction(_prev: BankActionResult, formData: FormData): Promise<BankActionResult> {
  const parsed = connectionSchema.safeParse({ organizationId: field(formData, "organizationId"), connectionId: field(formData, "connectionId") });
  if (!parsed.success) return { error: "That request isn't valid." };
  const { organizationId, connectionId } = parsed.data;

  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "bank:sync")) return { error: "You don't have permission to refresh bank connections." };
  const limited = await enforceRateLimit("bankSync", { bankSyncPerUser: user.id, bankSyncPerConnection: `${organizationId}:${connectionId}` });
  if (!limited.allowed) return { error: limited.message };

  try {
    const outcome = await requestBankSync(productionBankDependencies(), { organizationId, connectionId, userId: user.id, runInline: true, inlinePages: 3 });
    await recordAuditEvent(await createClient(), {
      organizationId,
      action: AUDIT_ACTIONS.bankSyncRequested,
      resourceType: "bank_connection",
      resourceId: connectionId,
      metadata: { outcome: outcome.kind, runOutcome: outcome.kind === "queued" ? (outcome.run?.kind ?? null) : null },
    });

    switch (outcome.kind) {
      case "not_found":
        return { error: "That bank connection wasn't found." };
      case "not_configured":
        return { error: outcome.message };
      case "not_syncable":
        return { error: `This connection can't import right now: ${CONNECTION_STATUS_PRESENTATION[outcome.status].label.toLowerCase()}.` };
      case "already_active":
        return { success: true, message: "An import is already in progress for this connection." };
      case "recently_synced":
        return { error: `This connection imported moments ago. Try again in about ${Math.max(1, Math.ceil(outcome.retryAfterSeconds / 60))} minutes.` };
      case "queued": {
        revalidateBankPages(organizationId, true);
        const run = outcome.run;
        if (run?.kind === "failed") return { error: SYNC_FAILURE_TEXT[run.category] };
        if (run?.kind === "succeeded") {
          return {
            success: true,
            message: run.hasMore
              ? "Imported the first pages. The rest is queued, and will import when background imports are enabled for this deployment."
              : "Imported. Anything that needs you is listed under Review.",
          };
        }
        return { success: true, message: "Import queued." };
      }
    }
  } catch (error) {
    reportError(error, { scope: "bank", organizationId, userId: user.id, detail: { step: "request_sync", connectionId } });
    return { error: GENERIC_FAILURE };
  }
}

// ── Disconnect ──────────────────────────────────────────────────────────

const disconnectSchema = connectionSchema.extend({ confirm: z.literal("disconnect") });

export async function disconnectBankConnectionAction(_prev: BankActionResult, formData: FormData): Promise<BankActionResult> {
  const parsed = disconnectSchema.safeParse({ organizationId: field(formData, "organizationId"), connectionId: field(formData, "connectionId"), confirm: field(formData, "confirm") });
  if (!parsed.success) return { error: "Confirm that you want to disconnect this bank." };
  const { organizationId, connectionId } = parsed.data;

  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "bank:manage")) return { error: "Only an owner or admin can disconnect a bank." };
  const limited = await enforceRateLimit("bankDisconnect", { bankDisconnectPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  try {
    const outcome = await disconnectBankConnection(productionBankDependencies(), { organizationId, connectionId, actorId: user.id });
    switch (outcome.kind) {
      case "not_found":
        return { error: "That bank connection wasn't found." };
      case "already_disconnected":
        return { success: true, message: "That connection was already disconnected." };
      case "secret_store_unavailable":
      case "credential_destroy_failed":
        return { error: "The bank's stored access couldn't be removed, so the connection was left as it was. Please try again." };
      case "disconnected":
        await recordAuditEvent(await createClient(), {
          organizationId,
          action: AUDIT_ACTIONS.bankConnectionDisconnected,
          resourceType: "bank_connection",
          resourceId: connectionId,
          metadata: { previousStatus: outcome.previousStatus, providerRevoked: outcome.providerRevoked },
        });
        revalidateBankPages(organizationId, false);
        return { success: true, message: "Disconnected. Transactions already imported stay in your books." };
    }
  } catch (error) {
    reportError(error, { scope: "bank", organizationId, userId: user.id, detail: { step: "disconnect", connectionId } });
    return { error: GENERIC_FAILURE };
  }
}

// ── Link an external account ────────────────────────────────────────────

const linkSchema = z.object({
  organizationId: z.uuid(),
  linkedAccountId: z.uuid(),
  target: z.union([z.literal("ignore"), z.uuid()]),
});

const LINK_REFUSALS: Record<Extract<LinkAccountResult, { kind: "refused" }>["reason"], string> = {
  NOT_FOUND: "That account wasn't found in this workspace.",
  DETACHED: "That bank account belongs to a disconnected connection.",
  INVALID: "Choose an account to import into.",
  CURRENCY_UNKNOWN: "The bank didn't report a currency for this account, so nothing can be imported from it.",
  CURRENCY_MISMATCH: "That account uses a different currency. Countorra never converts currencies.",
  HAS_IMPORTED_HISTORY: "Transactions from this bank account are already in another account's books, so it stays linked there.",
  ACCOUNT_ALREADY_LINKED: "That account is already fed by another bank account.",
};

export async function linkExternalAccountAction(_prev: BankActionResult, formData: FormData): Promise<BankActionResult> {
  const parsed = linkSchema.safeParse({ organizationId: field(formData, "organizationId"), linkedAccountId: field(formData, "linkedAccountId"), target: field(formData, "target") });
  if (!parsed.success) return { error: "Choose an account, or choose not to import." };
  const { organizationId, linkedAccountId, target } = parsed.data;

  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "bank:manage")) return { error: "Only an owner or admin can decide what a bank account feeds." };
  const limited = await enforceRateLimit("bankAccountLink", { bankAccountLinkPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  try {
    const importMode = target === "ignore" ? "IGNORE" : "IMPORT";
    const outcome = await linkExternalAccount(productionBankDependencies(), { organizationId, linkedAccountId, accountId: importMode === "IMPORT" ? target : null, importMode, actorId: user.id });
    if (outcome.kind === "refused") return { error: LINK_REFUSALS[outcome.reason] };
    await recordAuditEvent(await createClient(), {
      organizationId,
      action: AUDIT_ACTIONS.bankAccountLinked,
      resourceType: "bank_linked_account",
      resourceId: linkedAccountId,
      metadata: { importMode, accountId: importMode === "IMPORT" ? target : null, reconciled: outcome.reconciled },
    });
    revalidateBankPages(organizationId, true);
    return { success: true, message: importMode === "IGNORE" ? "Nothing from this bank account will be imported." : "Linked. Posted transactions are matched to your entries or imported." };
  } catch (error) {
    reportError(error, { scope: "bank", organizationId, userId: user.id, detail: { step: "link_account", linkedAccountId } });
    return { error: GENERIC_FAILURE };
  }
}

// ── Resolve a review ────────────────────────────────────────────────────

const reviewSchema = z.object({
  organizationId: z.uuid(),
  externalId: z.uuid(),
  resolution: z.enum(["KEEP_BOOKS", "IMPORT_AS_NEW", "DO_NOT_IMPORT"]),
});

const REVIEW_REFUSALS: Record<Extract<ResolveReviewResult, { kind: "refused" }>["reason"], string> = {
  NOT_FOUND: "That item wasn't found.",
  NOT_UNDER_REVIEW: "That item no longer needs review.",
  NOT_APPLICABLE: "That choice doesn't apply to this item.",
  UNSUPPORTED_CURRENCY: "That transaction's currency can't be held in Countorra.",
  NOT_A_CANDIDATE: "That transaction isn't a match for this one.",
  STALE: "The bank changed this transaction while you were looking at it. Review it again.",
  INVALID: "That choice can't be applied to this transaction any more.",
  CONFLICT: "That transaction was just matched to another bank transaction.",
  LEDGER_EDITED: "The transaction in your books changed. Review it again.",
};

export async function resolveBankReviewAction(_prev: BankActionResult, formData: FormData): Promise<BankActionResult> {
  const parsed = reviewSchema.safeParse({ organizationId: field(formData, "organizationId"), externalId: field(formData, "externalId"), resolution: field(formData, "resolution") });
  if (!parsed.success) return { error: "That request isn't valid." };
  const { organizationId, externalId, resolution } = parsed.data;

  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "financial:write")) return { error: "You don't have permission to change the books." };
  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  try {
    const outcome = await resolveBankReview(productionBankDependencies(), { organizationId, externalId, resolution: { kind: resolution }, actorId: user.id });
    if (outcome.kind === "refused") return { error: REVIEW_REFUSALS[outcome.reason] };
    await recordAuditEvent(await createClient(), {
      organizationId,
      action: AUDIT_ACTIONS.bankReviewResolved,
      resourceType: "bank_external_transaction",
      resourceId: externalId,
      metadata: { resolution },
    });
    revalidateBankPages(organizationId, true);
    return { success: true, message: "Done." };
  } catch (error) {
    reportError(error, { scope: "bank", organizationId, userId: user.id, detail: { step: "resolve_review", externalId } });
    return { error: GENERIC_FAILURE };
  }
}
