"use server";

import { createClient } from "@/server/supabase/server";
import { createAdminClient } from "@/server/supabase/admin";
import { requireOrgMembership } from "@/server/auth/session";
import { can } from "@/domain/organizations/permissions";
import { publicEnv } from "@/lib/env";
import { reportError, reportEvent } from "@/lib/observability";
import { enforceRateLimit } from "@/server/security/rate-limit";
import { recordAuditEvent, AUDIT_ACTIONS } from "@/domain/audit/audit-log";
import { getSubscription } from "@/server/db/repositories/subscriptions";
import { getOrganization } from "@/server/db/repositories/organizations";
import { isPurchasablePlan, planRelation } from "@/domain/billing/stripe-subscription";
import { entitlementsFor } from "@/domain/billing/entitlements";
import { priceIdForPlan, stripeConfig } from "./stripe-config";
import { stripeClient } from "./stripe-client";
import { isBillingTeardownLocked } from "./deletion-safety";

/**
 * Checkout and the Customer Portal.
 *
 * THE INVARIANT EVERY FUNCTION HERE SHARES
 *
 * The browser supplies exactly two things: an organization id and a plan
 * NAME. It never supplies a price id, a customer id, a subscription id, or an
 * amount. Each of those is resolved server-side from configuration or from a
 * row the caller has already been authorized against.
 *
 * That is the whole defence against the obvious attacks. A caller cannot
 * check out against a $0 price they found in Stripe's docs, cannot open the
 * portal for another merchant's customer, and cannot upgrade an organization
 * they are not an admin of — because none of those values travel in the
 * request at all.
 *
 * The organization id DOES come from the client, and is therefore not trusted:
 * `requireOrgMembership` resolves the caller's membership of that specific
 * organization from their session, and a non-member gets the same refusal as
 * a non-admin.
 */

export interface BillingActionResult {
  error?: string;
  /** Stripe-hosted URL the browser should be sent to. */
  url?: string;
  /** True when Stripe is not configured — the UI says so rather than
   *  pretending a purchase is possible. */
  billingUnavailable?: boolean;
}

const NOT_CONFIGURED: BillingActionResult = {
  billingUnavailable: true,
  error: "Billing isn't set up yet. Payments will be available once Stripe is connected.",
};

const GENERIC_FAILURE = "We couldn't start that. Please try again in a moment.";

/** A deletion is canceling this workspace's billing (see deletion-safety.ts).
 *  Opening a new subscription now would race it. */
const DELETION_IN_PROGRESS = "This workspace is being deleted, so its plan can't be changed.";

/**
 * Creates a Stripe Checkout Session for a plan the SERVER selected.
 *
 * Order is deliberate and matches the rest of the codebase: authenticate,
 * authorize, rate limit, then act. The limiter sits after authorization so a
 * caller who cannot pass the role check never spends a budget, and so the
 * budget is keyed on an identity that has already been verified.
 */
export async function createCheckoutSession(input: { organizationId: string; plan: string }): Promise<BillingActionResult> {
  // A plan the canonical model does not sell is refused before anything else
  // happens — including "free", which is not something you buy.
  if (!isPurchasablePlan(input.plan)) return { error: "That plan can't be purchased." };

  const { user, membership } = await requireOrgMembership(input.organizationId);
  if (!can(membership.role, "billing:manage")) {
    return { error: "Only an owner or admin can change this workspace's plan." };
  }

  const limited = await enforceRateLimit("privilegedMutation", { privilegedMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const config = stripeConfig();
  const stripe = stripeClient();
  if (!config || !stripe) return NOT_CONFIGURED;

  const priceId = priceIdForPlan(input.plan);
  if (!priceId) return NOT_CONFIGURED;

  const client = await createClient();
  const organization = await getOrganization(client, input.organizationId);
  if (!organization) return { error: "Workspace not found." };

  const subscription = await getSubscription(client, input.organizationId);
  if (isBillingTeardownLocked(subscription?.deletionLockedAt ?? null)) return { error: DELETION_IN_PROGRESS };
  const currentPlan = entitlementsFor(subscription).tier;

  // Already on this plan: sending them to Checkout would create a SECOND
  // subscription and bill them twice. Plan changes for an existing subscriber
  // belong in the portal, where Stripe handles proration.
  const relation = planRelation(currentPlan, input.plan);
  if (relation === "current") return { error: "This workspace is already on that plan." };
  if (relation === "downgrade") {
    return { error: "Use Manage billing to move to a different plan." };
  }

  try {
    const customerId = await ensureStripeCustomer({
      organizationId: input.organizationId,
      organizationName: organization.name,
      email: user.email ?? undefined,
      existingCustomerId: subscription?.stripeCustomerId ?? null,
    });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // Both derive from the canonical app URL (src/lib/env.ts), which a
      // deployment cannot leave pointing at localhost.
      success_url: `${publicEnv.NEXT_PUBLIC_APP_URL}/app/${input.organizationId}/settings?checkout=success#plan`,
      cancel_url: `${publicEnv.NEXT_PUBLIC_APP_URL}/pricing?checkout=cancelled`,
      client_reference_id: input.organizationId,
      // The webhook resolves the organization by customer id; this is the
      // fallback for the very first event, and a cross-check afterwards.
      subscription_data: { metadata: { organization_id: input.organizationId } },
      metadata: { organization_id: input.organizationId, plan: input.plan },
      allow_promotion_codes: true,
    });

    if (!session.url) throw new Error("Stripe returned a session with no URL");

    // A deletion may have started — or finished — between the check above
    // and this session existing. Deletion expires the open sessions it can
    // see; this closes the one it could not have seen yet. Read with the
    // service role, because a deleted workspace is invisible to the caller.
    const { data: after } = await createAdminClient()
      .from("subscriptions")
      .select("deletion_locked_at")
      .eq("organization_id", input.organizationId)
      .maybeSingle();
    if (!after || isBillingTeardownLocked(after.deletion_locked_at)) {
      await stripe.checkout.sessions.expire(session.id);
      return { error: DELETION_IN_PROGRESS };
    }

    await recordAuditEvent(client, {
      organizationId: input.organizationId,
      action: AUDIT_ACTIONS.billingCheckoutStarted,
      resourceType: "subscription",
      metadata: { plan: input.plan },
    });

    return { url: session.url };
  } catch (error) {
    reportError(error, { scope: "billing", organizationId: input.organizationId, userId: user.id, detail: { step: "create_checkout_session" } });
    return { error: GENERIC_FAILURE };
  }
}

/**
 * Opens the Stripe Customer Portal for the caller's own organization.
 *
 * The customer id is read from the organization's subscription row — never
 * accepted from the request. A caller who supplies someone else's customer id
 * has nowhere to put it.
 */
export async function createBillingPortalSession(input: { organizationId: string }): Promise<BillingActionResult> {
  const { user, membership } = await requireOrgMembership(input.organizationId);
  if (!can(membership.role, "billing:manage")) {
    return { error: "Only an owner or admin can manage this workspace's billing." };
  }

  const limited = await enforceRateLimit("privilegedMutation", { privilegedMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const stripe = stripeClient();
  if (!stripe) return NOT_CONFIGURED;

  const client = await createClient();
  const subscription = await getSubscription(client, input.organizationId);

  // No customer means this organization has never reached Checkout. There is
  // nothing to manage, and creating a customer here would produce an empty
  // portal that looks broken.
  if (!subscription?.stripeCustomerId) {
    return { error: "This workspace doesn't have a billing account yet. Choose a plan first." };
  }
  if (isBillingTeardownLocked(subscription.deletionLockedAt)) return { error: DELETION_IN_PROGRESS };

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: `${publicEnv.NEXT_PUBLIC_APP_URL}/app/${input.organizationId}/settings#plan`,
    });

    return { url: session.url };
  } catch (error) {
    reportError(error, { scope: "billing", organizationId: input.organizationId, userId: user.id, detail: { step: "create_portal_session" } });
    return { error: GENERIC_FAILURE };
  }
}

/**
 * Finds or creates the organization's Stripe Customer, and records it.
 *
 * Created BEFORE Checkout rather than letting Stripe create one implicitly,
 * for one reason: the webhook resolves an organization by customer id, and a
 * customer that exists only inside a completed Checkout Session cannot be
 * looked up if the first event to arrive is `customer.subscription.created`.
 * Binding it first removes that ordering dependency entirely.
 *
 * `bind_stripe_customer` writes only when the column is still null, so a
 * concurrent second Checkout cannot repoint an organization at a new customer.
 */
async function ensureStripeCustomer(params: {
  organizationId: string;
  organizationName: string;
  email: string | undefined;
  existingCustomerId: string | null;
}): Promise<string> {
  if (params.existingCustomerId) return params.existingCustomerId;

  const stripe = stripeClient();
  if (!stripe) throw new Error("Stripe is not configured");

  const customer = await stripe.customers.create({
    name: params.organizationName,
    email: params.email,
    metadata: { organization_id: params.organizationId },
  });

  // Service role: `subscriptions` has no UPDATE policy for `authenticated`
  // by design (0011), so a member's own session cannot write its billing row.
  const admin = createAdminClient();
  const { error } = await admin.rpc("bind_stripe_customer", {
    p_organization_id: params.organizationId,
    p_stripe_customer_id: customer.id,
  });
  if (error) throw error;

  // Re-read rather than assume: if a concurrent request bound a different
  // customer first, that one is authoritative and this one is abandoned.
  const { data } = await admin.from("subscriptions").select("stripe_customer_id").eq("organization_id", params.organizationId).maybeSingle();
  const bound = data?.stripe_customer_id ?? customer.id;

  if (bound !== customer.id) {
    reportEvent("billing.duplicate_customer_abandoned", { scope: "billing", organizationId: params.organizationId }, "warning");
  }

  return bound;
}
