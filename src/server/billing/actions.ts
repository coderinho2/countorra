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

  // Which call is in flight, so a failure can be attributed without logging
  // the (redacted) message. Updated before each await below.
  let call = "ensure_customer";
  try {
    const customerId = await ensureStripeCustomer({
      organizationId: input.organizationId,
      organizationName: organization.name,
      email: user.email ?? undefined,
      existingCustomerId: subscription?.stripeCustomerId ?? null,
    });

    call = "checkout_sessions_create";
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

    call = "deletion_lock_recheck";
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

    call = "audit_event";
    await recordAuditEvent(client, {
      organizationId: input.organizationId,
      action: AUDIT_ACTIONS.billingCheckoutStarted,
      resourceType: "subscription",
      metadata: { plan: input.plan },
    });

    return { url: session.url };
  } catch (error) {
    reportError(error, {
      scope: "billing",
      organizationId: input.organizationId,
      userId: user.id,
      detail: { step: "create_checkout_session", call, plan: input.plan, ...stripeErrorFields(error) },
    });
    return { error: GENERIC_FAILURE };
  }
}

/**
 * The structured, non-sensitive part of a Stripe SDK error.
 *
 * `observability.describe()` deliberately drops any error message over 200
 * characters, and Stripe's most actionable messages (a restricted key missing
 * a permission, a customer that exists only in the other mode) are longer than
 * that — so without this the log says only "Error / [redacted]". None of these
 * fields carries a key, an id of a customer, or a message: `type` and `code`
 * are enum-like, `param` names the offending request field ("customer",
 * "line_items[0][price]"), and `requestId` lets Stripe's own log be found.
 */
function stripeErrorFields(error: unknown): Record<string, string | number> {
  if (typeof error !== "object" || error === null) return {};
  const e = error as { type?: unknown; code?: unknown; statusCode?: unknown; param?: unknown; requestId?: unknown };
  if (typeof e.type !== "string" || !e.type.startsWith("Stripe")) return {};

  const fields: Record<string, string | number> = { stripeType: e.type };
  if (typeof e.code === "string") fields.stripeCode = e.code.slice(0, 80);
  if (typeof e.statusCode === "number") fields.stripeStatus = e.statusCode;
  if (typeof e.param === "string") fields.stripeParam = e.param.slice(0, 80);
  if (typeof e.requestId === "string") fields.stripeRequestId = e.requestId.slice(0, 80);
  return fields;
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
 * Whether a Stripe error means "this object does not exist for the key that
 * asked".
 *
 * `resource_missing` is the only code that may lead to replacing a stored
 * customer. Everything else — a rate limit, a network failure, a revoked key,
 * a permission the restricted key lacks — must propagate, because treating
 * those as "missing" would create a NEW customer on every retry and quietly
 * multiply customers for one organization.
 */
function isResourceMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { type?: unknown; code?: unknown; statusCode?: unknown };
  return typeof e.type === "string" && e.type.startsWith("Stripe") && e.code === "resource_missing" && e.statusCode === 404;
}

/**
 * Whether the stored customer can actually be used by the key in hand.
 *
 * THE PROBLEM THIS SOLVES. A Stripe customer id belongs to ONE mode. A
 * `cus_…` created in test mode does not exist for a live key, and Stripe says
 * so with `resource_missing` ("a similar object exists in test mode, but a
 * live mode key was used"). Countorra stores that id on the organization's
 * subscription row, and that row survives the switch from test keys to live
 * ones. So on the first live Checkout the stored id is handed to Stripe, the
 * call fails, and — because the id is never re-derived — it fails FOREVER for
 * that organization, with no path out from the product.
 *
 * Checked with a retrieve rather than discovered from a failed Checkout: one
 * extra call on a rare, human-initiated action, in exchange for the failure
 * being impossible rather than recovered from. It also catches the other
 * unusable case, which no error reports at all — a DELETED customer retrieves
 * successfully with `deleted: true`, and Checkout then refuses it.
 */
async function storedCustomerIsUsable(stripe: NonNullable<ReturnType<typeof stripeClient>>, customerId: string): Promise<boolean> {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return !(customer as { deleted?: boolean }).deleted;
  } catch (error) {
    if (isResourceMissing(error)) return false;
    throw error;
  }
}

/**
 * Repoints an organization at a replacement customer, but only while the row
 * still names the one just proven unusable.
 *
 * `bind_stripe_customer` cannot do this: it writes only when the column is
 * NULL, which is exactly the guard that stops a concurrent Checkout from
 * repointing an organization. So the replacement is a service-role update
 * with its own narrower guard — `stripe_customer_id = <the stale id>` — which
 * keeps the same property: two requests racing to replace the same stale id
 * produce one winner, and the loser adopts the winner's customer instead of
 * overwriting it.
 *
 * Returns the id the row ends up holding.
 */
async function replaceStoredCustomer(params: { organizationId: string; staleCustomerId: string; replacementCustomerId: string }): Promise<string> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("subscriptions")
    .update({ stripe_customer_id: params.replacementCustomerId, external_provider: "stripe" })
    .eq("organization_id", params.organizationId)
    .eq("stripe_customer_id", params.staleCustomerId);
  if (error) throw error;

  const { data } = await admin.from("subscriptions").select("stripe_customer_id").eq("organization_id", params.organizationId).maybeSingle();
  return data?.stripe_customer_id ?? params.replacementCustomerId;
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
 *
 * A STORED ID IS VERIFIED BEFORE IT IS TRUSTED — see `storedCustomerIsUsable`.
 * An id from the other Stripe mode, or a customer deleted in the Dashboard, is
 * replaced with a fresh one for the current mode. The old customer is left
 * alone in Stripe: it may hold real billing history for whoever owns that
 * mode, so it is dereferenced, never deleted.
 */
async function ensureStripeCustomer(params: {
  organizationId: string;
  organizationName: string;
  email: string | undefined;
  existingCustomerId: string | null;
}): Promise<string> {
  const stripe = stripeClient();
  if (!stripe) throw new Error("Stripe is not configured");

  let staleCustomerId: string | null = null;
  if (params.existingCustomerId) {
    if (await storedCustomerIsUsable(stripe, params.existingCustomerId)) return params.existingCustomerId;
    staleCustomerId = params.existingCustomerId;
    // Names no customer id: an id is not a secret, but this line ends up in
    // logs and the organization is enough to find the row.
    reportEvent("billing.stored_customer_unusable", { scope: "billing", organizationId: params.organizationId }, "warning");
  }

  const customer = await stripe.customers.create({
    name: params.organizationName,
    email: params.email,
    metadata: { organization_id: params.organizationId },
  });

  // Replacing an unusable id, or binding the first one. Both end with a
  // re-read, because a concurrent request may have won.
  if (staleCustomerId) {
    const bound = await replaceStoredCustomer({ organizationId: params.organizationId, staleCustomerId, replacementCustomerId: customer.id });
    if (bound !== customer.id) reportEvent("billing.duplicate_customer_abandoned", { scope: "billing", organizationId: params.organizationId }, "warning");
    return bound;
  }

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
