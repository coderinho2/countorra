"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/server/supabase/server";
import { createAdminClient } from "@/server/supabase/admin";
import { requireOrgMembership } from "@/server/auth/session";
import { enforceRateLimit } from "@/server/security/rate-limit";
import { recordAuditEvent, AUDIT_ACTIONS } from "@/domain/audit/audit-log";
import { reportError, reportEvent } from "@/lib/observability";
import { isDeveloperPlanTier } from "@/domain/billing/developer-override";
import { isDeveloperSession, writePlanOverride } from "./developer-override";

/**
 * SETTING A TEST PLAN — the only writer, and the only place both conditions
 * are checked.
 *
 * THE TWO CONDITIONS, neither of which lives in the database:
 *
 *   1. DEVELOPER SESSION. The signed-in user's CONFIRMED email is listed in
 *      the deployment's `DEVELOPER_ACCOUNTS`. Read server-side from
 *      `supabase.auth.getUser()`, never from a cookie the browser wrote, a
 *      form field or a header. A deployment that has not set that variable
 *      refuses everybody, which is the default.
 *   2. OWNERSHIP. `requireOrgMembership(id, ["owner"])` — the membership is
 *      re-derived from the session, so the browser cannot name a workspace it
 *      does not own. A developer of this deployment still cannot change a
 *      workspace that is not theirs.
 *
 * Both are checked on every call. Failing either returns the SAME answer a
 * non-developer gets, so the action does not confirm to a prober that a
 * developer mechanism exists.
 *
 * WHAT IT WRITES
 *
 * One row in `developer_plan_overrides`, which affects ENTITLEMENTS ONLY.
 * `subscriptions` is not touched, no Stripe customer or subscription is
 * created or modified, and no invoice is produced. Clearing the override
 * deletes the row and the workspace returns to whatever Stripe says it is.
 */

const schema = z.object({
  organizationId: z.uuid(),
  /** A tier, or "off" to clear the override entirely. */
  plan: z.union([z.literal("off"), z.string().min(1).max(16)]),
});

export interface DeveloperPlanResult {
  error?: string;
  success?: boolean;
  message?: string;
}

/** Deliberately identical for "not a developer" and "not an owner". */
const REFUSED = "That isn't available.";

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

export async function setDeveloperPlanAction(_prev: DeveloperPlanResult, formData: FormData): Promise<DeveloperPlanResult> {
  const parsed = schema.safeParse({ organizationId: field(formData, "organizationId"), plan: field(formData, "plan") });
  if (!parsed.success) return { error: "That request isn't valid." };
  const { organizationId } = parsed.data;

  // Ownership first: it redirects for a workspace this person is not in, so a
  // prober learns nothing about the developer mechanism from a workspace that
  // is not theirs.
  const { user } = await requireOrgMembership(organizationId, ["owner"]);

  if (!isDeveloperSession(user)) {
    reportEvent("billing.developer_override_refused", { scope: "security", organizationId, detail: { reason: "not_a_developer" } }, "warning");
    return { error: REFUSED };
  }

  const limited = await enforceRateLimit("privilegedMutation", { privilegedMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const plan = parsed.data.plan === "off" ? null : parsed.data.plan;
  if (plan !== null && !isDeveloperPlanTier(plan)) return { error: "That isn't a plan." };

  try {
    await writePlanOverride(createAdminClient(), { organizationId, planId: plan, actorId: user.id });
  } catch (error) {
    reportError(error, { scope: "billing", organizationId, detail: { step: "write_developer_override" } });
    return { error: "That couldn't be saved, and nothing was changed." };
  }

  const client = await createClient();
  await recordAuditEvent(client, {
    organizationId,
    action: AUDIT_ACTIONS.developerPlanOverrideChanged,
    resourceType: "organization",
    resourceId: organizationId,
    // The tier and nothing else. No email, no allowlist, no billing detail.
    metadata: { plan: plan ?? "off" },
  }).catch((error) => reportError(error, { scope: "billing", organizationId, detail: { step: "audit_developer_override" } }));

  reportEvent("billing.developer_override_changed", { scope: "billing", organizationId, detail: { plan: plan ?? "off" } });

  // Every surface whose content depends on the plan. Entitlements are read
  // server-side per request, so these are what make the change visible at
  // once rather than after a hard reload.
  for (const path of ["settings", "bank-connections", "documents", "dashboard", "assistant"]) {
    revalidatePath(`/app/${organizationId}/${path}`);
  }
  revalidatePath(`/app/${organizationId}`, "layout");

  return { success: true, message: plan === null ? "Test override off. This workspace is back on its real plan." : `Testing as ${plan}. Billing is unchanged.` };
}
