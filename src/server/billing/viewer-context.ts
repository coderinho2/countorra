import "server-only";
import { createClient } from "@/server/supabase/server";
import { getSession } from "@/server/auth/session";
import { listOwnedOrganizationSubscriptions } from "@/server/db/repositories/subscriptions";
import { entitlementsFor } from "@/domain/billing/entitlements";
import { planRelation } from "@/domain/billing/stripe-subscription";
import { isBillingConfigured } from "./stripe-config";
import type { PlanCtaMode } from "@/components/billing/plan-cta";
import type { PlanTier } from "@/types/database";

/**
 * What the pricing page needs to know about whoever is looking at it.
 *
 * Resolved on the SERVER, from the session — never from a prop, a query
 * parameter or a cookie the page could be handed. The result decides what
 * each card's button SAYS; what the button is allowed to DO is re-checked
 * inside `createCheckoutSession` regardless.
 *
 * WHICH WORKSPACE GETS CHARGED
 *
 * Subscriptions are per organization, and a person can own several. "Upgrade
 * to Premium" is therefore ambiguous for anyone with more than one workspace,
 * and guessing means putting a real recurring charge on the wrong one.
 *
 * So: exactly one owned workspace → the card checks out directly. More than
 * one → the card sends them to pick, and the upgrade happens in that
 * workspace's own Settings where there is no ambiguity left. None → they are
 * signed out, or a member of someone else's workspace and not the person who
 * pays for it.
 *
 * The plan shown as "current" is the best plan among the workspaces they own,
 * matching how `organizationAllowance` already answers the same
 * one-person-many-workspaces question.
 */
export interface BillingViewer {
  signedIn: boolean;
  /** Best entitled plan across owned workspaces; "free" when there are none. */
  currentPlan: PlanTier;
  /** Set only when the viewer owns exactly one workspace. */
  checkoutOrganizationId: string | null;
  ownedOrganizationCount: number;
  billingConfigured: boolean;
}

export async function resolveBillingViewer(): Promise<BillingViewer> {
  const billingConfigured = isBillingConfigured();
  const user = await getSession();

  if (!user) {
    return { signedIn: false, currentPlan: "free", checkoutOrganizationId: null, ownedOrganizationCount: 0, billingConfigured };
  }

  const client = await createClient();
  const { organizationIds, subscriptions } = await listOwnedOrganizationSubscriptions(client, user.id);

  // `entitlementsFor` applies the status rule, so a cancelled Premium
  // workspace counts as Free here exactly as it does at every enforcement
  // point. The pricing page cannot show someone as Premium while the server
  // treats them as Free.
  let currentPlan: PlanTier = "free";
  for (const subscription of subscriptions) {
    const tier = entitlementsFor(subscription).tier;
    if (planRelation(currentPlan, tier) === "upgrade") currentPlan = tier;
  }

  return {
    signedIn: true,
    currentPlan,
    checkoutOrganizationId: organizationIds.length === 1 ? organizationIds[0] : null,
    ownedOrganizationCount: organizationIds.length,
    billingConfigured,
  };
}

/** How a given plan's card should behave for this viewer. */
export function ctaModeFor(viewer: BillingViewer, plan: PlanTier): PlanCtaMode {
  // Signed out FIRST. A visitor with no account is not "on" the Free plan —
  // they have no plan at all — so labelling Free as their current one is both
  // wrong and leaves that card with no call to action, which is the one thing
  // every card must have.
  if (!viewer.signedIn) return { kind: "signed-out" };

  if (plan === viewer.currentPlan) return { kind: "current" };

  // A cheaper plan than the one they are on is never a purchase.
  if (planRelation(viewer.currentPlan, plan) === "downgrade") {
    return { kind: "downgrade", href: viewer.checkoutOrganizationId ? `/app/${viewer.checkoutOrganizationId}/settings#plan` : null };
  }

  if (!viewer.billingConfigured) return { kind: "unavailable" };

  if (!viewer.checkoutOrganizationId) {
    return { kind: "choose-workspace", href: "/app" };
  }

  return { kind: "checkout", organizationId: viewer.checkoutOrganizationId };
}
