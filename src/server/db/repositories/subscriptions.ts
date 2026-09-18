import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Client = SupabaseClient<Database>;
type SubscriptionRow = Database["public"]["Tables"]["subscriptions"]["Row"];
type PlanRow = Database["public"]["Tables"]["plans"]["Row"];

export interface Subscription {
  planId: SubscriptionRow["plan_id"];
  status: SubscriptionRow["status"];
  currentPeriodEnd: string | null;
  currentPeriodStart: string | null;
  /** Set once the organization has reached Checkout. Required by the Customer
   *  Portal, and the key the webhook resolves an organization by. */
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  /** Stripe will not renew at the end of the current period. The plan stays
   *  entitled until then — this is a scheduled end, not an immediate one. */
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
}

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    planId: row.plan_id,
    status: row.status,
    currentPeriodEnd: row.current_period_end,
    currentPeriodStart: row.current_period_start,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.external_provider === "stripe" ? row.external_subscription_id : null,
    stripePriceId: row.stripe_price_id,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    canceledAt: row.canceled_at,
  };
}

export interface Plan {
  id: PlanRow["id"];
  name: string;
  priceMinor: number | null;
  currency: string;
  entitlements: PlanRow["entitlements"];
}

/** Read-only — writes to `subscriptions` only ever happen via the
 *  org-bootstrap trigger (initial 'free' row) or a future service-role
 *  billing webhook, never a client mutation (see the RLS comment on
 *  0011_rls_policies.sql's subscriptions policies, and
 *  tests/rls/tenant-isolation.test.ts's billing-tamper-resistance test). */
export async function getSubscription(client: Client, organizationId: string): Promise<Subscription | null> {
  const { data, error } = await client.from("subscriptions").select("*").eq("organization_id", organizationId).maybeSingle();
  if (error) throw error;
  return data ? toSubscription(data) : null;
}

export async function listPlans(client: Client): Promise<Plan[]> {
  const { data, error } = await client.from("plans").select("*");
  if (error) throw error;
  return data.map((p) => ({ id: p.id, name: p.name, priceMinor: p.price_minor, currency: p.currency, entitlements: p.entitlements }));
}

/**
 * Every subscription belonging to an organization this user OWNS.
 *
 * The organization allowance is a per-user question and `subscriptions` is
 * keyed per organization, so answering "may this person create another
 * workspace?" means gathering the plans of the ones they already own. See
 * `organizationAllowance` in src/domain/billing/entitlements.ts for how those
 * are combined, and why ownership rather than membership is the unit.
 *
 * Two RLS-scoped reads, not a service-role join: `memberships` and
 * `subscriptions` both restrict to organizations the caller belongs to, so
 * this cannot see another user's workspaces even though it is asking a
 * user-shaped question. `userId` comes from the authenticated session at the
 * call site, never from a request payload.
 */
export async function listOwnedOrganizationSubscriptions(
  client: Client,
  userId: string,
): Promise<{ organizationIds: string[]; subscriptions: Subscription[] }> {
  const { data: memberships, error: membershipError } = await client
    .from("memberships")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("role", "owner");
  if (membershipError) throw membershipError;

  const organizationIds = (memberships ?? []).map((m) => m.organization_id);
  if (organizationIds.length === 0) return { organizationIds: [], subscriptions: [] };

  const { data, error } = await client
    .from("subscriptions")
    .select("*")
    .in("organization_id", organizationIds);
  if (error) throw error;

  return { organizationIds, subscriptions: (data ?? []).map(toSubscription) };
}
