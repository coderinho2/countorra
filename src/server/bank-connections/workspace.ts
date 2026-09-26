import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { resolveBankProvider, type BankConnectionProvider } from "@/domain/bank-connections/provider";
import { listAccounts } from "@/server/db/repositories/accounts";
import { effectivePlan } from "@/server/billing/developer-override";
import {
  countExternalTransactions,
  listBankConnections,
  listLatestSyncJobs,
  listLinkedAccounts,
  listReviewItems,
  type BankConnectionView,
  type LinkedAccountView,
  type ReviewItemView,
  type SyncJobView,
} from "@/server/db/repositories/bank-connections";

type Client = SupabaseClient<Database>;

export interface BankConnectionsWorkspace {
  provider: { configured: boolean; name: string | null; message: string | null; environment: string | null };
  /**
   * Two independent facts, never merged: whether this deployment HAS a bank
   * provider, and whether this workspace's plan includes bank connections.
   * A paid plan does not conjure a provider, and a configured provider does
   * not grant a Free workspace the feature.
   */
  access: { entitled: boolean; planName: string; canConnect: boolean };
  connections: (BankConnectionView & {
    linkedAccounts: (LinkedAccountView & { accountName: string | null })[];
    latestJob: SyncJobView | null;
    reviewCount: number;
    pendingCount: number;
    transactionCount: number;
  })[];
  reviewItems: ReviewItemView[];
  manualAccounts: { id: string; name: string; currency: string; kind: string; bankFed: boolean }[];
}

/**
 * Everything the Bank connections page shows, read through the member's own
 * RLS-scoped client and only the columns granted to members. Bounded: at most
 * 100 connections, and counts rather than rows for their transactions.
 */
export async function loadBankConnectionsWorkspace(
  client: Client,
  organizationId: string,
  providers: readonly BankConnectionProvider[],
  /** The session, so a developer's test plan applies here exactly as it does
   *  at the action that enforces it. Omitted by any caller without one, which
   *  then sees the real subscription. */
  user?: { email?: string | null; email_confirmed_at?: string | null } | null,
): Promise<BankConnectionsWorkspace> {
  const availability = resolveBankProvider(providers);
  const [connections, accounts, plan] = await Promise.all([
    listBankConnections(client, organizationId),
    listAccounts(client, organizationId, { includeArchived: false }),
    effectivePlan(client, organizationId, user),
  ]);
  const entitlements = plan.entitlements;
  const connectionIds = connections.map((connection) => connection.id);

  const [linked, jobs, reviewItems, counts] = await Promise.all([
    listLinkedAccounts(client, organizationId, connectionIds),
    listLatestSyncJobs(client, organizationId, connectionIds),
    connectionIds.length > 0 ? listReviewItems(client, organizationId) : Promise.resolve([]),
    Promise.all(
      connections.map(async (connection) => ({
        id: connection.id,
        review: await countExternalTransactions(client, organizationId, connection.id, "NEEDS_REVIEW"),
        pending: await countExternalTransactions(client, organizationId, connection.id, "PENDING_SETTLEMENT"),
        total: await countExternalTransactions(client, organizationId, connection.id),
      })),
    ),
  ]);

  const accountName = new Map(accounts.map((account) => [account.id, account.name]));
  const countsById = new Map(counts.map((entry) => [entry.id, entry]));
  const fed = new Set(linked.filter((account) => account.accountId && !account.detached).map((account) => account.accountId));

  return {
    provider: availability.available
      ? { configured: true, name: availability.provider.displayName, message: null, environment: availability.provider.environment ?? null }
      : { configured: false, name: null, message: availability.message, environment: null },
    access: { entitled: entitlements.bankConnections, planName: entitlements.name, canConnect: availability.available && entitlements.bankConnections },
    connections: connections.map((connection) => ({
      ...connection,
      linkedAccounts: linked.filter((account) => account.connectionId === connection.id).map((account) => ({ ...account, accountName: account.accountId ? (accountName.get(account.accountId) ?? null) : null })),
      latestJob: jobs.get(connection.id) ?? null,
      reviewCount: countsById.get(connection.id)?.review ?? 0,
      pendingCount: countsById.get(connection.id)?.pending ?? 0,
      transactionCount: countsById.get(connection.id)?.total ?? 0,
    })),
    reviewItems,
    manualAccounts: accounts.map((account) => ({ id: account.id, name: account.name, currency: account.currency, kind: account.kind, bankFed: fed.has(account.id) })),
  };
}

/**
 * What the assistant may know about bank connections: whether a provider is
 * configured, and each connection's status in words. No provider identifier,
 * no balance reported by a bank, no transaction — the assistant's financial
 * answers come from the ledger, and nothing here can be mistaken for it.
 */
export async function bankConnectionStatusForAssistant(client: Client, organizationId: string, providers: readonly BankConnectionProvider[]) {
  const workspace = await loadBankConnectionsWorkspace(client, organizationId, providers);
  return {
    providerConfigured: workspace.provider.configured,
    providerEnvironment: workspace.provider.environment,
    planIncludesBankConnections: workspace.access.entitled,
    providerNote: workspace.provider.configured
      ? `Bank connections use ${workspace.provider.name}${workspace.provider.environment === "sandbox" ? " in its SANDBOX environment, where all bank data is fictional test data — never describe it as the person's real money" : ""}.`
      : "No bank connection provider is configured for this workspace's deployment. Nothing is imported from any bank; every transaction was entered by hand, by a file import or drafted by the assistant and confirmed.",
    connections: workspace.connections.map((connection) => ({
      institution: connection.institutionName ?? "Unnamed institution",
      status: connection.status,
      statusReason: connection.statusReason,
      lastSuccessfulImportAt: connection.lastSuccessfulSyncAt,
      disconnectedAt: connection.disconnectedAt,
      transactionsNeedingReview: connection.reviewCount,
      pendingAtBank: connection.pendingCount,
      bankAccounts: connection.linkedAccounts.map((account) => ({
        name: account.displayName,
        lastFour: account.mask,
        currency: account.currency,
        importMode: account.importMode,
        feedsCountorraAccount: account.accountName,
        disconnected: account.detached,
      })),
    })),
    guidance:
      "This is connection STATUS only. Use the ledger tools for balances and transactions. Never describe a bank as connected unless a connection here has status ACTIVE, and never state a balance from a bank.",
  };
}
