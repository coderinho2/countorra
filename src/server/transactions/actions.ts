"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { requireOrgMembership } from "@/server/auth/session";
import { can } from "@/domain/organizations/permissions";
import {
  bulkCategorizeTransactions,
  categorizeTransaction,
  createTransaction,
  deleteTransaction,
  markReviewed,
} from "@/server/db/repositories/transactions";
import { findOrCreateMerchant } from "@/server/db/repositories/merchants";
import { listAccounts } from "@/server/db/repositories/accounts";
import { recordAuditEvent, AUDIT_ACTIONS } from "@/domain/audit/audit-log";
import { createTransactionSchema } from "@/validation/schemas/transaction";
import { fromMajorUnits } from "@/domain/money/money";
import type { CurrencyCode } from "@/domain/money/currency";
import { enforceRateLimit } from "@/server/security/rate-limit";

export interface TransactionActionResult {
  error?: string;
  success?: boolean;
}

export async function createTransactionAction(_prev: TransactionActionResult, formData: FormData): Promise<TransactionActionResult> {
  const parsed = createTransactionSchema.safeParse({
    organizationId: formData.get("organizationId"),
    accountId: formData.get("accountId"),
    categoryId: formData.get("categoryId") || undefined,
    kind: formData.get("kind"),
    transferAccountId: formData.get("transferAccountId") || undefined,
    amount: formData.get("amount"),
    currency: formData.get("currency"),
    occurredOn: formData.get("occurredOn"),
    description: formData.get("description") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { user, membership } = await requireOrgMembership(parsed.data.organizationId);
  if (!can(membership.role, "financial:write")) return { error: "You don't have permission to add transactions." };

  // Bounded after authorization, so the limiter is keyed on an identity that
  // has already been verified (rate-limit-policy.ts: recordMutationPerUser).
  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const client = await createClient();

  // Both sides of a transfer must be accounts of THIS organization. RLS
  // already refuses a foreign account, but it refuses by returning nothing —
  // which would surface as a confusing constraint error rather than an
  // explanation. Checking here names the problem.
  if (parsed.data.kind === "transfer") {
    const accounts = await listAccounts(client, parsed.data.organizationId);
    const source = accounts.find((a) => a.id === parsed.data.accountId);
    const destination = accounts.find((a) => a.id === parsed.data.transferAccountId);

    if (!source || !destination) return { error: "Both accounts in a transfer must belong to this workspace." };
    if (source.currency !== destination.currency) {
      // Countorra does not convert currencies anywhere (ARCHITECTURE.md), so
      // a cross-currency transfer has no single correct amount. Refusing is
      // the honest answer; inventing a rate is not.
      return { error: "Both accounts in a transfer must use the same currency." };
    }
    if (parsed.data.currency !== source.currency) {
      return { error: `This transfer must be recorded in ${source.currency}, the accounts' own currency.` };
    }
  }

  const merchantName = (formData.get("merchantName") as string | null)?.trim();
  const merchant = merchantName ? await findOrCreateMerchant(client, parsed.data.organizationId, merchantName) : null;

  const transaction = await createTransaction(client, {
    organizationId: parsed.data.organizationId,
    accountId: parsed.data.accountId,
    categoryId: parsed.data.categoryId ?? null,
    merchantId: merchant?.id ?? null,
    kind: parsed.data.kind,
    transferAccountId: parsed.data.transferAccountId ?? null,
    // src/domain/money is the only code allowed to convert or do
    // arithmetic on amounts (ARCHITECTURE.md "Money").
    // `Math.round(parseFloat(x) * 100)` was neither exact ("8.165" lost a
    // cent) nor currency-aware (it hardcodes a two-decimal minor unit).
    amountMinor: fromMajorUnits(parsed.data.amount, parsed.data.currency as CurrencyCode).amountMinor,
    currency: parsed.data.currency,
    occurredOn: parsed.data.occurredOn,
    description: parsed.data.description ?? null,
    source: "manual",
    createdBy: user.id,
  });

  await recordAuditEvent(client, {
    organizationId: parsed.data.organizationId,
    action: AUDIT_ACTIONS.transactionCreated,
    resourceType: "transaction",
    resourceId: transaction.id,
  });

  revalidatePath(`/app/${parsed.data.organizationId}/transactions`);
  revalidatePath(`/app/${parsed.data.organizationId}/dashboard`);
  return { success: true };
}

export async function categorizeTransactionAction(organizationId: string, transactionId: string, categoryId: string | null) {
  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "financial:write")) throw new Error("You don't have permission to categorize transactions.");
  // Bounded after authorization, so the limiter is keyed on an identity that
  // has already been verified (rate-limit-policy.ts: recordMutationPerUser).
  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) throw new Error(limited.message);


  const client = await createClient();
  await categorizeTransaction(client, { organizationId, transactionId, categoryId, categorizedBy: "user" });
  await recordAuditEvent(client, { organizationId, action: AUDIT_ACTIONS.transactionUpdated, resourceType: "transaction", resourceId: transactionId });
  revalidatePath(`/app/${organizationId}/transactions`);
}

export async function bulkCategorizeAction(organizationId: string, transactionIds: string[], categoryId: string | null) {
  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "financial:write")) throw new Error("You don't have permission to categorize transactions.");

  // Bounded after authorization, so the limiter is keyed on an identity that
  // has already been verified (rate-limit-policy.ts: recordMutationPerUser).
  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) throw new Error(limited.message);

  const client = await createClient();
  const count = await bulkCategorizeTransactions(client, { organizationId, transactionIds, categoryId, categorizedBy: "user" });
  await recordAuditEvent(client, {
    organizationId,
    action: AUDIT_ACTIONS.transactionUpdated,
    resourceType: "transaction",
    metadata: { bulkCount: count, transactionIds },
  });
  revalidatePath(`/app/${organizationId}/transactions`);
  return count;
}

/** Marking a transaction reviewed is a write to a financial record, so it
 *  needs the same `financial:write` gate every other mutation has — it was
 *  previously reachable by a `viewer`, whose update RLS then silently
 *  dropped with no error and no feedback. */
export async function markReviewedAction(organizationId: string, transactionIds: string[]) {
  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "financial:write")) throw new Error("You don't have permission to review transactions.");
  // Bounded after authorization, so the limiter is keyed on an identity that
  // has already been verified (rate-limit-policy.ts: recordMutationPerUser).
  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) throw new Error(limited.message);


  const client = await createClient();
  const count = await markReviewed(client, organizationId, transactionIds);
  revalidatePath(`/app/${organizationId}/transactions`);
  return count;
}

/**
 * Deletion is a `financial:delete`-gated, explicit, single-record action —
 * never exposed as an easy bulk operation (product spec §9: "Do not make
 * bulk destructive operations easy to perform accidentally"). The
 * confirmation UI itself lives in the client component that calls this.
 */
export async function deleteTransactionAction(organizationId: string, transactionId: string) {
  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "financial:delete")) throw new Error("You don't have permission to delete transactions.");

  // Bounded after authorization, so the limiter is keyed on an identity that
  // has already been verified (rate-limit-policy.ts: recordMutationPerUser).
  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) throw new Error(limited.message);

  const client = await createClient();
  const deleted = await deleteTransaction(client, transactionId, organizationId);
  // Only record the audit event if something was actually deleted —
  // otherwise a request pairing this organizationId with another
  // organization's transaction id wrote a `transaction.deleted` entry for a
  // deletion that never happened.
  if (!deleted) throw new Error("Transaction not found.");
  await recordAuditEvent(client, { organizationId, action: AUDIT_ACTIONS.transactionDeleted, resourceType: "transaction", resourceId: transactionId });
  revalidatePath(`/app/${organizationId}/transactions`);
}
