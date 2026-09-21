"use server";

import { DEFERRED_MODULE_MESSAGE, isModuleEnabled } from "@/domain/organizations/launch-scope";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { requireOrgMembership } from "@/server/auth/session";
import { can } from "@/domain/organizations/permissions";
import { createCustomer } from "@/server/db/repositories/customers";
import { recordAuditEvent, AUDIT_ACTIONS } from "@/domain/audit/audit-log";
import { z } from "zod";
import { enforceRateLimit } from "@/server/security/rate-limit";

const createCustomerSchema = z.object({
  organizationId: z.uuid(),
  displayName: z.string().min(1).max(200),
  email: z.email().optional().or(z.literal("")),
  taxId: z.string().max(50).optional(),
});

export interface CustomerActionResult {
  error?: string;
  success?: boolean;
}

export async function createCustomerAction(_prev: CustomerActionResult, formData: FormData): Promise<CustomerActionResult> {
  // Invoicing is deferred at launch (src/domain/organizations/launch-scope.ts).
  if (!isModuleEnabled("invoicing")) return { error: DEFERRED_MODULE_MESSAGE };
  const parsed = createCustomerSchema.safeParse({
    organizationId: formData.get("organizationId"),
    displayName: formData.get("displayName"),
    email: formData.get("email") || undefined,
    taxId: formData.get("taxId") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { user, membership } = await requireOrgMembership(parsed.data.organizationId);
  if (!can(membership.role, "financial:write")) return { error: "You don't have permission to add customers." };

  // Bounded after authorization, so the limiter is keyed on an identity that
  // has already been verified (rate-limit-policy.ts: recordMutationPerUser).
  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const client = await createClient();
  const customer = await createCustomer(client, {
    organizationId: parsed.data.organizationId,
    displayName: parsed.data.displayName,
    email: parsed.data.email || null,
    taxId: parsed.data.taxId || null,
  });

  await recordAuditEvent(client, { organizationId: parsed.data.organizationId, action: AUDIT_ACTIONS.customerCreated, resourceType: "customer", resourceId: customer.id });

  revalidatePath(`/app/${parsed.data.organizationId}/customers`);
  return { success: true };
}
