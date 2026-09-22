"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { requireUser, requireOrgMembership } from "@/server/auth/session";
import { can } from "@/domain/organizations/permissions";
import { updateProfile } from "@/server/db/repositories/profiles";
import { getOrganization, updateOrganization } from "@/server/db/repositories/organizations";
import { supportedStateSchema } from "@/domain/tax/supported-states";
import { createCategory } from "@/server/db/repositories/categories";
import { recordAuditEvent, AUDIT_ACTIONS } from "@/domain/audit/audit-log";
import { currencySchema } from "@/validation/schemas/money";
import { z } from "zod";
import { enforceRateLimit } from "@/server/security/rate-limit";

export interface SettingsActionResult {
  error?: string;
  success?: boolean;
}

const profileSchema = z.object({ fullName: z.string().min(1).max(200) });

export async function updateProfileAction(_prev: SettingsActionResult, formData: FormData): Promise<SettingsActionResult> {
  const parsed = profileSchema.safeParse({ fullName: formData.get("fullName") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const user = await requireUser();
  const client = await createClient();
  await updateProfile(client, user.id, { fullName: parsed.data.fullName });
  revalidatePath("/app", "layout");
  return { success: true };
}

const organizationSchema = z.object({
  organizationId: z.uuid(),
  name: z.string().min(1).max(200),
  country: z.string().length(2),
  /**
   * The state the workspace lives in, and the only thing that selects its
   * state tax rules. Required, and one of the supported states
   * (src/domain/tax/supported-states.ts) — Texas and Florida included, whose
   * answer is "no individual income tax". It cannot be cleared: a blank would
   * mean "unknown", not "no state tax". Never inferred from anything else.
   */
  stateRegion: supportedStateSchema,
  baseCurrency: currencySchema,
  taxIdentifier: z.string().max(50).optional(),
  taxIdentifierType: z.enum(["ein", "ssn", "itin", "other"]).optional(),
});

export async function updateOrganizationAction(_prev: SettingsActionResult, formData: FormData): Promise<SettingsActionResult> {
  const parsed = organizationSchema.safeParse({
    organizationId: formData.get("organizationId"),
    name: formData.get("name"),
    country: formData.get("country"),
    stateRegion: formData.get("stateRegion") ?? undefined,
    baseCurrency: formData.get("baseCurrency"),
    taxIdentifier: formData.get("taxIdentifier") || undefined,
    taxIdentifierType: formData.get("taxIdentifierType") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { user, membership } = await requireOrgMembership(parsed.data.organizationId);
  if (!can(membership.role, "org:update")) return { error: "You don't have permission to update organization settings." };
  // Bounded after authorization, so the limiter is keyed on an identity that
  // has already been verified (rate-limit-policy.ts: recordMutationPerUser).
  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };


  const client = await createClient();
  // Read before writing, under the caller's own RLS, so a state change can be
  // audited with what it replaced.
  const before = await getOrganization(client, parsed.data.organizationId);
  if (!before) return { error: "Workspace not found." };

  await updateOrganization(client, parsed.data.organizationId, {
    name: parsed.data.name,
    country: parsed.data.country,
    stateRegion: parsed.data.stateRegion,
    baseCurrency: parsed.data.baseCurrency,
    taxIdentifier: parsed.data.taxIdentifier ?? null,
    taxIdentifierType: parsed.data.taxIdentifierType,
  });

  // Changing the state changes which state tax rules every calculation uses
  // (open preparation cases are re-run under the new state — see
  // src/domain/tax-preparation/jurisdiction.ts), so it is recorded.
  if (before.stateRegion !== parsed.data.stateRegion) {
    await recordAuditEvent(client, {
      organizationId: parsed.data.organizationId,
      action: AUDIT_ACTIONS.organizationStateChanged,
      resourceType: "organization",
      resourceId: parsed.data.organizationId,
      metadata: { from: before.stateRegion, to: parsed.data.stateRegion },
    });
  }

  revalidatePath(`/app/${parsed.data.organizationId}`, "layout");
  return { success: true };
}

const categorySchema = z.object({
  organizationId: z.uuid(),
  name: z.string().min(1).max(100),
  kind: z.enum(["income", "expense"]),
});

export async function createCategoryAction(_prev: SettingsActionResult, formData: FormData): Promise<SettingsActionResult> {
  const parsed = categorySchema.safeParse({
    organizationId: formData.get("organizationId"),
    name: formData.get("name"),
    kind: formData.get("kind"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { user, membership } = await requireOrgMembership(parsed.data.organizationId);
  if (!can(membership.role, "financial:write")) return { error: "You don't have permission to add categories." };

  // Bounded after authorization, so the limiter is keyed on an identity that
  // has already been verified (rate-limit-policy.ts: recordMutationPerUser).
  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const client = await createClient();
  const category = await createCategory(client, { organizationId: parsed.data.organizationId, name: parsed.data.name, kind: parsed.data.kind });
  await recordAuditEvent(client, { organizationId: parsed.data.organizationId, action: AUDIT_ACTIONS.categoryCreated, resourceType: "category", resourceId: category.id });

  revalidatePath(`/app/${parsed.data.organizationId}/settings`);
  return { success: true };
}
