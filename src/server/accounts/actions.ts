"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { requireOrgMembership } from "@/server/auth/session";
import { can } from "@/domain/organizations/permissions";
import { archiveAccount, createAccount } from "@/server/db/repositories/accounts";
import { recordAuditEvent, AUDIT_ACTIONS } from "@/domain/audit/audit-log";
import { currencySchema } from "@/validation/schemas/money";
import { fromMajorUnits } from "@/domain/money/money";
import type { CurrencyCode } from "@/domain/money/currency";
import { z } from "zod";
import { enforceRateLimit } from "@/server/security/rate-limit";

const createAccountSchema = z.object({
  organizationId: z.uuid(),
  name: z.string().min(1).max(200),
  kind: z.enum(["cash", "bank", "credit_card", "wallet", "other"]),
  currency: currencySchema,
  openingBalance: z.string().regex(/^-?\d+(\.\d{1,2})?$/).optional(),
});

export interface AccountActionResult {
  error?: string;
  success?: boolean;
}

export async function createAccountAction(_prev: AccountActionResult, formData: FormData): Promise<AccountActionResult> {
  const parsed = createAccountSchema.safeParse({
    organizationId: formData.get("organizationId"),
    name: formData.get("name"),
    kind: formData.get("kind"),
    currency: formData.get("currency"),
    openingBalance: formData.get("openingBalance") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { user, membership } = await requireOrgMembership(parsed.data.organizationId);
  if (!can(membership.role, "financial:write")) return { error: "You don't have permission to add accounts." };

  // Bounded after authorization, so the limiter is keyed on an identity that
  // has already been verified (rate-limit-policy.ts: recordMutationPerUser).
  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const client = await createClient();
  const account = await createAccount(client, {
    organizationId: parsed.data.organizationId,
    name: parsed.data.name,
    kind: parsed.data.kind,
    currency: parsed.data.currency,
    openingBalanceMinor: parsed.data.openingBalance
      ? fromMajorUnits(parsed.data.openingBalance, parsed.data.currency as CurrencyCode).amountMinor
      : 0,
  });

  await recordAuditEvent(client, { organizationId: parsed.data.organizationId, action: AUDIT_ACTIONS.accountCreated, resourceType: "account", resourceId: account.id });

  revalidatePath(`/app/${parsed.data.organizationId}/accounts`);
  return { success: true };
}

export async function archiveAccountAction(organizationId: string, accountId: string) {
  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "financial:delete")) throw new Error("You don't have permission to archive accounts.");

  // Bounded after authorization, so the limiter is keyed on an identity that
  // has already been verified (rate-limit-policy.ts: recordMutationPerUser).
  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) throw new Error(limited.message);

  const client = await createClient();
  // The org predicate is inside archiveAccount now, so a mismatched
  // (organizationId, accountId) pair is a reportable miss instead of a
  // silent no-op that still writes an audit entry.
  const archived = await archiveAccount(client, accountId, organizationId);
  if (!archived) throw new Error("Account not found.");
  await recordAuditEvent(client, { organizationId, action: AUDIT_ACTIONS.accountArchived, resourceType: "account", resourceId: accountId });
  revalidatePath(`/app/${organizationId}/accounts`);
}
