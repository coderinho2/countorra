"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { requireUser, requireOrgMembership } from "@/server/auth/session";
import { can } from "@/domain/organizations/permissions";
import { updateProfile } from "@/server/db/repositories/profiles";
import { updateOrganization } from "@/server/db/repositories/organizations";
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
   * USPS two-letter state code, and the only thing that puts a workspace
   * into a state tax engine. Uppercased before it is stored so that "ca"
   * and "CA" behave identically — a lowercase value that silently failed to
   * match would look exactly like "California isn't supported".
   *
   * An empty field clears it, which is the correct state for a workspace
   * with no state income tax. It is never inferred from anything else.
   */
  stateRegion: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Use the two-letter state code, or leave it blank.")
    .optional(),
  baseCurrency: currencySchema,
  taxIdentifier: z.string().max(50).optional(),
  taxIdentifierType: z.enum(["ein", "ssn", "itin", "other"]).optional(),
});

export async function updateOrganizationAction(_prev: SettingsActionResult, formData: FormData): Promise<SettingsActionResult> {
  const parsed = organizationSchema.safeParse({
    organizationId: formData.get("organizationId"),
    name: formData.get("name"),
    country: formData.get("country"),
    stateRegion: formData.get("stateRegion") || undefined,
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
  await updateOrganization(client, parsed.data.organizationId, {
    name: parsed.data.name,
    country: parsed.data.country,
    stateRegion: parsed.data.stateRegion ?? null,
    baseCurrency: parsed.data.baseCurrency,
    taxIdentifier: parsed.data.taxIdentifier ?? null,
    taxIdentifierType: parsed.data.taxIdentifierType,
  });

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
