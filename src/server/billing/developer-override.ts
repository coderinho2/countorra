import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, PlanTier } from "@/types/database";
import { serverEnv } from "@/lib/server-env";
import { getSubscription } from "@/server/db/repositories/subscriptions";
import { entitlementsFor, organizationAllowance, type PlanEntitlements, type SubscriptionState } from "@/domain/billing/entitlements";
import { developerAccounts, isDeveloperAccount, type PlanSource } from "@/domain/billing/developer-override";

type Client = SupabaseClient<Database>;

/**
 * THE EFFECTIVE PLAN: what a workspace may DO, as opposed to what it pays for.
 *
 * Everything that gates a feature asks this. It returns the real
 * subscription's entitlements, except where a developer of this deployment
 * has set a test plan on the workspace — in which case it returns that plan's
 * entitlements and says so.
 *
 * WHERE THIS IS *NOT* USED, AND WHY THAT MATTERS
 *
 *   Stripe Checkout (src/server/billing/actions.ts) reads the real
 *   subscription, deliberately. If it read the effective plan, a developer
 *   testing as Premium would be told "this workspace is already on that plan"
 *   and could not complete a genuine upgrade — a test mechanism breaking the
 *   thing it exists to test.
 *
 *   The pricing page's viewer context reads the real subscription too. What
 *   somebody is billed for is a fact about their account, and a test plan
 *   must not make the marketing page claim a purchase that did not happen.
 *
 * WHY THE ALLOWLIST IS CHECKED ON EVERY READ, NOT JUST ON WRITES
 *
 * A row in `developer_plan_overrides` grants nothing by itself. If the
 * deployment's `DEVELOPER_ACCOUNTS` is unset or no longer lists the person,
 * the row is ignored. So removing an address from that list revokes every
 * override that address ever set, immediately and everywhere, without a
 * migration or a cleanup job — and a row restored from a backup onto a
 * deployment with no developer list does nothing at all.
 */

export interface EffectivePlan {
  entitlements: PlanEntitlements;
  /** Where these entitlements came from. */
  source: PlanSource;
  /** What the real subscription says, whatever the override says. Shown
   *  beside the effective plan so the two are never confused. */
  billedTier: PlanTier;
}

/** The configured developer accounts, or none when the deployment has not
 *  been configured for this. Never throws: a half-configured environment must
 *  not become an error on a page that only wanted to render a plan name. */
function configuredDeveloperAccounts(): readonly string[] {
  try {
    return developerAccounts(serverEnv().DEVELOPER_ACCOUNTS);
  } catch {
    return [];
  }
}

/**
 * Whether this session belongs to a developer of this deployment.
 *
 * The email and its confirmed flag come from `supabase.auth.getUser()`, which
 * validates the session server-side — not from a cookie the browser wrote, a
 * form field or a header.
 */
export function isDeveloperSession(user: { email?: string | null; email_confirmed_at?: string | null } | null | undefined): boolean {
  if (!user) return false;
  return isDeveloperAccount({ email: user.email, emailConfirmed: Boolean(user.email_confirmed_at) }, configuredDeveloperAccounts());
}

/** The test plan set on a workspace, or null. Readable by any member under
 *  RLS; acted on only when a developer is asking. */
export async function readPlanOverride(client: Client, organizationId: string): Promise<PlanTier | null> {
  const { data, error } = await client.from("developer_plan_overrides").select("plan_id").eq("organization_id", organizationId).maybeSingle();
  // A deployment whose migration has not run yet, or a member whose RLS
  // returns nothing, simply has no override. Never an error on a feature gate.
  if (error) return null;
  return data?.plan_id ?? null;
}

/**
 * What this workspace may do, for the person making the request.
 *
 * `user` is the session. It is required rather than optional because the
 * override applies only while a developer is signed in: a background worker,
 * a webhook or a cron run passes null and gets the real subscription, which
 * is what those callers must act on.
 */
export async function effectivePlan(
  client: Client,
  organizationId: string,
  user: { email?: string | null; email_confirmed_at?: string | null } | null | undefined,
): Promise<EffectivePlan> {
  const subscription = await getSubscription(client, organizationId);
  const billed = entitlementsFor(subscription);

  if (!isDeveloperSession(user)) return { entitlements: billed, source: "subscription", billedTier: billed.tier };

  const override = await readPlanOverride(client, organizationId);
  if (!override) return { entitlements: billed, source: "subscription", billedTier: billed.tier };

  return { entitlements: PLANS[override], source: "developer_override", billedTier: billed.tier };
}

/**
 * How many workspaces this person may own, with their test plans counted.
 *
 * WHY THIS IS SEPARATE FROM `effectivePlan`. Every other gate asks about ONE
 * workspace, so it can resolve one workspace's plan. The organization
 * allowance is the exception: it is a fact about the PERSON, taken as the best
 * allowance across every workspace they own (`organizationAllowance`), and
 * asked at the moment they are creating a workspace that does not exist yet.
 *
 * It was therefore the one enforcement point the override did not reach —
 * Business grants unlimited workspaces, and a developer testing as Business
 * was still held to Free's single workspace, because this path reads
 * subscription rows and nothing else.
 *
 * The override rows are folded in as the tiers they name and passed through
 * the SAME `organizationAllowance`, so:
 *   - an override can never LOWER the allowance a real subscription gives;
 *   - it can never grant more than a purchasable plan grants, because the
 *     tier is looked up in the same entitlements table;
 *   - a non-developer, or a deployment with no DEVELOPER_ACCOUNTS, gets
 *     exactly the previous answer, computed the previous way.
 */
export async function effectiveOrganizationAllowance(
  client: Client,
  input: { organizationIds: readonly string[]; subscriptions: SubscriptionState[] },
  user: { email?: string | null; email_confirmed_at?: string | null } | null | undefined,
): Promise<number | null> {
  const billed = organizationAllowance(input.subscriptions);
  if (!isDeveloperSession(user) || input.organizationIds.length === 0) return billed;

  const { data, error } = await client.from("developer_plan_overrides").select("plan_id").in("organization_id", [...input.organizationIds]);
  // Same rule as `readPlanOverride`: a failure here is "no override", never an
  // error on a path whose job is to create a workspace.
  if (error || !data || data.length === 0) return billed;

  // `organizationAllowance` already takes the best across states and treats
  // null as unlimited, so the overrides are simply more states.
  return organizationAllowance([...input.subscriptions, ...data.map((row) => ({ planId: row.plan_id, status: "active" as const }))]);
}

/** Entitlements by tier, without a subscription in hand. Uses the same table
 *  every other caller does, so a test plan and a paid plan are the same
 *  object — an override cannot grant something no purchasable plan grants. */
const PLANS: Record<PlanTier, PlanEntitlements> = {
  free: entitlementsFor({ planId: "free", status: "active" }),
  premium: entitlementsFor({ planId: "premium", status: "active" }),
  business: entitlementsFor({ planId: "business", status: "active" }),
};

// ── Writing ─────────────────────────────────────────────────────────────

/**
 * Sets or clears a workspace's test plan.
 *
 * Takes an ADMIN client, and the caller must have established BOTH conditions
 * first — developer session, and ownership of this workspace. There is no RLS
 * policy that would let a browser role reach this table, so the service role
 * is the only way in; that is deliberate, and it is why this function is not
 * exported to anything but the action beside it.
 */
export async function writePlanOverride(admin: Client, input: { organizationId: string; planId: PlanTier | null; actorId: string }): Promise<void> {
  if (input.planId === null) {
    const { error } = await admin.from("developer_plan_overrides").delete().eq("organization_id", input.organizationId);
    if (error) throw error;
    return;
  }

  const { error } = await admin
    .from("developer_plan_overrides")
    .upsert({ organization_id: input.organizationId, plan_id: input.planId, created_by: input.actorId }, { onConflict: "organization_id" });
  if (error) throw error;
}
