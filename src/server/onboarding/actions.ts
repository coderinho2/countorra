"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { requireUser } from "@/server/auth/session";
import { createOrganization } from "@/server/db/repositories/organizations";
import { listOwnedOrganizationSubscriptions } from "@/server/db/repositories/subscriptions";
import { canCreateOrganization, formatOrganizationAllowance, organizationAllowance } from "@/domain/billing/entitlements";
import { createOrganizationSchema } from "@/validation/schemas/organization";

export interface OnboardingActionResult {
  error?: string;
}

/**
 * Progressive onboarding (product spec §23): collects only entity type +
 * name + country/currency, nothing else — no giant form, no tax/legal
 * detail up front. The organizations.entity_type value chosen here is
 * what src/app/app/[orgId]/layout.tsx reads to decide which navigation
 * items and dashboard layout to show (product spec §24–§26).
 *
 * This is also the ONLY path that creates an organization, which makes it
 * the only place the plan's organization allowance can be enforced. It was
 * not enforced at all: `maxOrganizations: 1` existed on the Free plan and in
 * the database's plan row, nothing read either, and `/onboarding` stays
 * reachable by URL after you already have a workspace — so a Free account
 * could create workspaces without limit, against a published page promising
 * one. The check below is server-side and unconditional; the UI does not get
 * a vote, and there is no client-supplied plan or count anywhere in it.
 */
export async function completeOnboarding(_prev: OnboardingActionResult, formData: FormData): Promise<OnboardingActionResult> {
  const user = await requireUser();

  const parsed = createOrganizationSchema.safeParse({
    name: formData.get("name"),
    entityType: formData.get("entityType"),
    country: formData.get("country") || undefined,
    baseCurrency: formData.get("baseCurrency") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const client = await createClient();

  // Both inputs are derived server-side: the count from organizations this
  // user actually owns, the allowance from those organizations' real
  // subscription rows (which only the bootstrap trigger and a future billing
  // webhook can write — never a client).
  const { organizationIds, subscriptions } = await listOwnedOrganizationSubscriptions(client, user.id);
  const allowance = organizationAllowance(subscriptions);
  if (!canCreateOrganization(organizationIds.length, allowance)) {
    return {
      error: `Your plan includes ${formatOrganizationAllowance(allowance)}. Upgrade to add another workspace.`,
    };
  }

  const organization = await createOrganization(client, {
    name: parsed.data.name,
    entityType: parsed.data.entityType as "personal" | "freelancer" | "business",
    country: parsed.data.country,
    baseCurrency: parsed.data.baseCurrency,
    createdBy: user.id,
  });

  redirect(`/app/${organization.id}/dashboard`);
}
