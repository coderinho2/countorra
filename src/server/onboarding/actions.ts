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
 * Progressive onboarding (product spec §23): collects only a name, the US
 * state the person lives in, and a currency — no giant form, no identity or
 * tax detail up front. The state is required: it selects the workspace's
 * state tax rules (src/domain/tax/supported-states.ts), and it is validated
 * here and constrained in the database (0052), never defaulted.
 *
 * Every workspace is personal at launch (src/domain/organizations/launch-
 * scope.ts). The entity type is no longer asked for: the schema defaults it
 * to `personal`, and refuses a request that names anything else. The
 * database refuses it too (supabase/migrations/0051_personal_launch_scope.sql).
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
    entityType: formData.get("entityType") || undefined,
    country: formData.get("country") || undefined,
    stateRegion: formData.get("stateRegion") ?? undefined,
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
    entityType: parsed.data.entityType,
    country: parsed.data.country,
    stateRegion: parsed.data.stateRegion,
    baseCurrency: parsed.data.baseCurrency,
    createdBy: user.id,
  });

  redirect(`/app/${organization.id}/dashboard`);
}
