import type Stripe from "stripe";
import { createAdminClient } from "@/server/supabase/admin";
import { stripeClient } from "@/server/billing/stripe-client";
import { planForPriceId, stripeConfig } from "@/server/billing/stripe-config";
import { toLocalSubscriptionStatus } from "@/domain/billing/stripe-subscription";
import { reportError, reportEvent } from "@/lib/observability";

/**
 * The Stripe webhook. This endpoint is how an organization's plan actually
 * changes — nothing else in the product may grant a paid tier.
 *
 * WHY THE BROWSER REDIRECT IS NOT TRUSTED
 *
 * Checkout sends the customer back to `?checkout=success`, and it would be
 * easy to upgrade them there. That URL is just a link: anyone can visit it,
 * including someone who abandoned payment. Entitlements move here, on a
 * signed server-to-server event, and the success page only says "we're
 * processing" — see the Settings plan section.
 *
 * SIGNATURE VERIFICATION NEEDS THE RAW BODY
 *
 * Stripe signs the exact bytes it sent. `await request.text()` is used and
 * the string is handed to `constructEvent` untouched — parsing it first and
 * re-serialising would change key order and whitespace, and every signature
 * would fail. Nothing reads `request.json()` anywhere in this file.
 *
 * WHAT A NON-2xx MEANS
 *
 * Stripe retries on any non-2xx, with backoff, for days. So the status codes
 * here are a contract, not decoration:
 *
 *   400 — the request is not from Stripe, or is unparseable. Never retry.
 *   503 — Stripe is not configured on this deployment, or the database was
 *         unreachable. RETRY: the event is real and we simply could not
 *         handle it yet.
 *   200 — handled, deliberately ignored, or a duplicate. Do not send again.
 *
 * Returning 200 for events we do not act on is intentional. An unhandled
 * event type is not a failure, and answering 400 would make Stripe retry
 * something that will never succeed.
 */

/**
 * Node runtime, stated rather than inherited. `constructEvent` verifies the
 * signature with node's crypto; on the edge runtime it throws and the async
 * variant is required instead. This is the default today, and pinning it
 * means a future edge migration fails loudly here rather than silently
 * rejecting every real Stripe delivery.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stripe events that carry subscription state worth synchronising. */
const SUBSCRIPTION_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
  "invoice.paid",
]);

export async function POST(request: Request): Promise<Response> {
  const config = stripeConfig();
  const stripe = stripeClient();

  if (!config || !stripe) {
    // Real event, unconfigured deployment. 503 so Stripe keeps it queued.
    return new Response("Billing is not configured", { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  // RAW body. Never `request.json()`.
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret);
  } catch (error) {
    // Bad signature, wrong secret, or a replay outside Stripe's tolerance
    // window. Deliberately not reported with the body attached: an attacker
    // controls it, and it would end up in logs verbatim.
    reportEvent("billing.webhook_signature_rejected", { scope: "billing", detail: { hasSignature: true } }, "warning");
    void error;
    return new Response("Invalid signature", { status: 400 });
  }

  if (!SUBSCRIPTION_EVENTS.has(event.type)) {
    // Acknowledged, not acted on. Stripe sends far more than this product
    // needs, and retrying them forever helps nobody.
    return new Response(JSON.stringify({ received: true, handled: false }), { status: 200 });
  }

  try {
    const outcome = await synchronizeSubscription(stripe, event);
    return new Response(JSON.stringify({ received: true, outcome }), { status: 200 });
  } catch (error) {
    // Something on OUR side failed — the database, or Stripe on a follow-up
    // read. The event is valid and unprocessed, so ask for it again.
    reportError(error, { scope: "billing", detail: { step: "synchronize_subscription", eventType: event.type } });
    return new Response("Temporarily unable to process", { status: 503 });
  }
}

type SyncOutcome = "applied" | "duplicate" | "stale" | "unknown_customer" | "unknown_price" | "no_subscription";

/**
 * Resolves the Stripe subscription behind an event and writes it locally.
 *
 * Every event type is reduced to the same question — "what does Stripe
 * currently say this subscription is?" — by re-reading the Subscription
 * object rather than trusting whatever partial shape the event carried. That
 * is what makes out-of-order delivery survivable: two events arriving
 * backwards both describe the same authoritative object, and the older one is
 * then discarded on its timestamp by `apply_stripe_subscription_event`.
 */
async function synchronizeSubscription(stripe: Stripe, event: Stripe.Event): Promise<SyncOutcome> {
  const subscriptionId = await resolveSubscriptionId(event);
  if (!subscriptionId) return "no_subscription";

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  const item = subscription.items.data[0];
  const priceId = item?.price?.id ?? null;
  const plan = planForPriceId(priceId);

  if (!plan) {
    // A price this deployment did not configure: another product in the same
    // Stripe account, a deleted price, or a subscription created by hand in
    // the dashboard. Recorded and ignored — guessing a tier here is how a
    // customer ends up on Business for a $1 price.
    reportEvent(
      "billing.webhook_unknown_price",
      { scope: "billing", detail: { eventType: event.type, hasPrice: Boolean(priceId) } },
      "warning",
    );
    return "unknown_price";
  }

  const organizationId =
    typeof subscription.metadata?.organization_id === "string" ? subscription.metadata.organization_id : null;

  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("apply_stripe_subscription_event", {
    p_event_id: event.id,
    p_event_type: event.type,
    p_event_created: new Date(event.created * 1000).toISOString(),
    p_organization_id: organizationId,
    p_stripe_customer_id: customerId,
    p_stripe_subscription_id: subscription.id,
    p_stripe_price_id: priceId,
    p_plan_id: plan,
    p_status: toLocalSubscriptionStatus(subscription.status),
    p_current_period_start: periodStart(item),
    p_current_period_end: periodEnd(item),
    p_cancel_at_period_end: subscription.cancel_at_period_end ?? false,
    p_canceled_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000).toISOString() : null,
  });

  if (error) throw error;

  const outcome = (data as SyncOutcome | null) ?? "unknown_customer";

  reportEvent(
    "billing.webhook_processed",
    { scope: "billing", organizationId: organizationId ?? undefined, detail: { eventType: event.type, outcome, plan } },
    outcome === "unknown_customer" ? "warning" : "info",
  );

  return outcome;
}

/**
 * The Stripe subscription id an event refers to.
 *
 * Different event types carry it in different places, and a Checkout session
 * in `payment` mode carries none at all — which is why this returns null
 * rather than throwing.
 */
async function resolveSubscriptionId(event: Stripe.Event): Promise<string | null> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "subscription") return null;
      return typeof session.subscription === "string" ? session.subscription : (session.subscription?.id ?? null);
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      return (event.data.object as Stripe.Subscription).id;
    }
    case "invoice.payment_failed":
    case "invoice.payment_succeeded":
    case "invoice.paid": {
      // An invoice's subscription lives on its line items in current API
      // versions. Either shape is accepted so this keeps working across the
      // version bump rather than silently finding nothing.
      const invoice = event.data.object as Stripe.Invoice & { subscription?: string | { id: string } | null };
      if (typeof invoice.subscription === "string") return invoice.subscription;
      if (invoice.subscription && typeof invoice.subscription === "object") return invoice.subscription.id;

      for (const line of invoice.lines?.data ?? []) {
        const parent = (line as unknown as { parent?: { subscription_item_details?: { subscription?: string } } }).parent;
        const fromLine = parent?.subscription_item_details?.subscription;
        if (typeof fromLine === "string") return fromLine;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Billing period moved onto the subscription ITEM in recent API versions. */
function periodStart(item: Stripe.SubscriptionItem | undefined): string | null {
  return item?.current_period_start ? new Date(item.current_period_start * 1000).toISOString() : null;
}

function periodEnd(item: Stripe.SubscriptionItem | undefined): string | null {
  return item?.current_period_end ? new Date(item.current_period_end * 1000).toISOString() : null;
}
