import "server-only";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, SubscriptionStatus } from "@/types/database";
import { toLocalSubscriptionStatus } from "@/domain/billing/stripe-subscription";
import { reportEvent } from "@/lib/observability";
import { stripeClient } from "./stripe-client";

/**
 * BILLING SAFETY FOR DELETION — the one gate every destructive path passes.
 *
 * An organization must not be deleted while Stripe may still be charging for
 * it. `subscriptions` cascades with the organization, so once the row is gone
 * nothing in Countorra remembers the Stripe subscription, and nothing would
 * ever cancel it.
 *
 * So before any workspace is deleted, `secureBillingForDeletion`:
 *
 *   1. Takes a per-organization teardown lock (migration 0050). A second
 *      deletion of the same workspace is refused rather than interleaved, and
 *      Checkout refuses to open a new subscription while it is held.
 *   2. Reads the Stripe customer and subscription from OUR row — never from
 *      the request. A browser cannot point this at another customer.
 *   3. Asks Stripe, not our copy, what exists: every subscription on the
 *      customer (all statuses) plus the one we recorded. Open Checkout
 *      sessions are expired first, so a payment page left open in another tab
 *      cannot create a subscription after the check.
 *   4. Cancels every subscription that is not already canceled or expired —
 *      immediately, with no proration or final invoice (the refund policy is
 *      a business decision that has not been made; see LEGAL_FACTS).
 *   5. Lists again, and repeats up to three rounds. It succeeds only when
 *      Stripe itself reports nothing live and no open Checkout session.
 *   6. Records the terminal state locally, stamped with Stripe's cancellation
 *      time, so a late webhook older than the cancellation is stale.
 *
 * If ANY of that cannot be established — Stripe unreachable, unconfigured
 * while a customer exists, a subscription id Stripe does not recognise — the
 * result is a refusal, every lock is released, and nothing has been deleted.
 * A subscription that was canceled before the failure stays canceled: that is
 * what the person asked for, and it is never charged again.
 *
 * IDEMPOTENCY AND RACES
 *
 * Every Stripe write carries an idempotency key scoped to this attempt, so a
 * network retry inside one attempt cannot cancel or expire twice. Keys are
 * per-attempt rather than permanent because Stripe replays the first result
 * for a key for 24 hours — including a transient 5xx — and a permanent key
 * would turn one blip into a day-long block. Two attempts cannot overlap: the
 * lock serializes them. A repeated attempt after success finds nothing live
 * and cancels nothing.
 *
 * Webhooks cannot restore paid access: the webhook re-reads the Subscription
 * from Stripe (which now says canceled), and any event created before the
 * cancellation is discarded as stale by `apply_stripe_subscription_event`.
 * The database guard in 0050 refuses to delete an organization whose row
 * still records a live Stripe subscription, whoever issues the delete.
 */

/** Stripe statuses that can never bill again. Everything else — including
 *  `incomplete`, `past_due`, `unpaid` and `paused` — can, and is canceled. */
const TERMINAL_STRIPE_STATUSES: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);

export function isTerminalStripeStatus(status: string): boolean {
  return TERMINAL_STRIPE_STATUSES.has(status);
}

const MAX_ROUNDS = 3;

// ── Ports ──────────────────────────────────────────────────────────────────

export interface RemoteSubscription {
  id: string;
  status: string;
  /** Unix seconds, as Stripe reports it. */
  canceledAt: number | null;
}

/** The Stripe calls this needs, and no others. Implemented over the one
 *  shared SDK client by `stripeBillingGateway`. */
export interface StripeBillingGateway {
  listCustomerSubscriptions(customerId: string): Promise<RemoteSubscription[]>;
  /** `null` when Stripe says the subscription does not exist. */
  retrieveSubscription(subscriptionId: string): Promise<RemoteSubscription | null>;
  cancelSubscription(subscriptionId: string, idempotencyKey: string): Promise<RemoteSubscription>;
  listOpenCheckoutSessionIds(customerId: string): Promise<string[]>;
  expireCheckoutSession(sessionId: string, idempotencyKey: string): Promise<void>;
}

export interface LocalBillingLink {
  stripeCustomerId: string | null;
  /** Set only when the row's provider is Stripe. */
  stripeSubscriptionId: string | null;
}

export interface BillingTeardownStore {
  /** False when another attempt holds a live lock on this organization. */
  acquire(organizationId: string, attemptId: string): Promise<boolean>;
  release(organizationId: string, attemptId: string): Promise<void>;
  read(organizationId: string): Promise<LocalBillingLink | null>;
  recordTerminal(organizationId: string, subscriptionId: string, status: SubscriptionStatus, canceledAt: string): Promise<void>;
}

export interface BillingTeardownDependencies {
  store: BillingTeardownStore;
  /** `null` when Stripe is not configured (or is misconfigured). */
  gateway: StripeBillingGateway | null;
  /** Injected for tests; defaults to a random UUID. */
  newAttemptId?: () => string;
}

// ── Result ─────────────────────────────────────────────────────────────────

export type BillingTeardownFailure =
  /** Another deletion of the same workspace is running. */
  | "in_progress"
  /** A Stripe customer exists but Stripe is not configured here. */
  | "billing_unavailable"
  /** A Stripe call failed. */
  | "provider_error"
  /** Stripe answered, but still reports something live after every round —
   *  or does not recognise a subscription we recorded. */
  | "not_verified"
  /** Our own database could not be read or written. */
  | "store_error";

export type BillingTeardown =
  | {
      ok: true;
      /** Subscriptions this attempt canceled (0 when none were live). */
      canceled: number;
      /** Releases the locks. Call it when a LATER deletion step fails, so the
       *  surviving workspace can be billed again if its owner chooses. */
      release: () => Promise<void>;
    }
  | { ok: false; reason: BillingTeardownFailure; message: string };

/** What the person is told. No provider text, no ids, no amounts. */
const MESSAGES: Record<BillingTeardownFailure, string> = {
  in_progress: "A deletion is already in progress for one of your workspaces. Please wait a few minutes and try again. Nothing was deleted.",
  billing_unavailable:
    "We couldn't confirm that your subscription is canceled, so nothing was deleted. Please contact support to finish deleting your account.",
  provider_error:
    "We couldn't confirm with our payment provider that your subscription is canceled, so nothing was deleted. Please try again in a few minutes.",
  not_verified:
    "We couldn't confirm with our payment provider that your subscription is canceled, so nothing was deleted. Please try again in a few minutes, or contact support.",
  store_error: "We couldn't check your subscription, so nothing was deleted. Please try again in a few minutes.",
};

class TeardownError extends Error {
  constructor(
    readonly reason: BillingTeardownFailure,
    readonly step: string,
    readonly cause?: unknown,
  ) {
    super(reason);
  }
}

// ── The primitive ──────────────────────────────────────────────────────────

/**
 * Establishes that no workspace in `organizationIds` can be billed again.
 *
 * `organizationIds` must already be authorized by the caller — this function
 * trusts the list, and nothing else from the request. On success the locks
 * stay held; the caller proceeds to delete, or calls `release()` on failure.
 */
export async function secureBillingForDeletion(deps: BillingTeardownDependencies, organizationIds: readonly string[]): Promise<BillingTeardown> {
  const attemptId = (deps.newAttemptId ?? randomUUID)();
  const locked: string[] = [];

  const release = async () => {
    for (const organizationId of locked) {
      try {
        await deps.store.release(organizationId, attemptId);
      } catch {
        // A lock that cannot be released expires on its own (15 minutes).
      }
    }
  };

  try {
    for (const organizationId of organizationIds) {
      let acquired: boolean;
      try {
        acquired = await deps.store.acquire(organizationId, attemptId);
      } catch (error) {
        throw new TeardownError("store_error", "acquire_lock", error);
      }
      if (!acquired) throw new TeardownError("in_progress", "acquire_lock");
      locked.push(organizationId);
    }

    let canceled = 0;
    for (const organizationId of organizationIds) {
      canceled += await settleOrganization(deps, organizationId, attemptId);
    }

    if (canceled > 0) {
      reportEvent("billing.deletion_subscriptions_canceled", { scope: "billing", detail: { canceled, organizations: organizationIds.length } });
    }
    return { ok: true, canceled, release };
  } catch (error) {
    await release();
    const failure = error instanceof TeardownError ? error : new TeardownError("store_error", "unexpected", error);
    reportEvent(
      "billing.deletion_blocked",
      { scope: "billing", detail: { reason: failure.reason, step: failure.step, ...providerErrorShape(failure.cause) } },
      failure.reason === "in_progress" ? "warning" : "error",
    );
    return { ok: false, reason: failure.reason, message: MESSAGES[failure.reason] };
  }
}

async function settleOrganization(deps: BillingTeardownDependencies, organizationId: string, attemptId: string): Promise<number> {
  let link: LocalBillingLink | null;
  try {
    link = await deps.store.read(organizationId);
  } catch (error) {
    throw new TeardownError("store_error", "read_billing_link", error);
  }

  // Never reached Checkout: there is nothing in Stripe to cancel.
  if (!link || (!link.stripeCustomerId && !link.stripeSubscriptionId)) return 0;

  // A customer exists, and this deployment cannot ask Stripe about it. The
  // local row cannot prove a negative — a completed Checkout whose webhook
  // never arrived looks exactly like "no subscription" — so refuse.
  const gateway = deps.gateway;
  if (!gateway) throw new TeardownError("billing_unavailable", "stripe_unconfigured");

  const key = (action: string, id: string) => `countorra:delete-org:${organizationId}:${attemptId}:${action}:${id}`;
  let canceled = 0;
  let snapshot: RemoteSubscription[] = [];

  for (let round = 1; round <= MAX_ROUNDS + 1; round++) {
    // Close any payment page first, so nothing can complete after the list.
    let openSessions: string[] = [];
    if (link.stripeCustomerId) {
      openSessions = await call("list_checkout_sessions", () => gateway.listOpenCheckoutSessionIds(link.stripeCustomerId!));
    }

    snapshot = await remoteSubscriptions(gateway, link);
    const live = snapshot.filter((s) => !isTerminalStripeStatus(s.status));

    if (live.length === 0 && openSessions.length === 0) break;
    // The extra round only verifies; it never acts. Still live → refuse.
    if (round > MAX_ROUNDS) throw new TeardownError("not_verified", "verify_after_cancel");

    for (const sessionId of openSessions) {
      await call("expire_checkout_session", () => gateway.expireCheckoutSession(sessionId, key("expire", sessionId)));
    }

    for (const subscription of live) {
      try {
        const result = await gateway.cancelSubscription(subscription.id, key("cancel", subscription.id));
        if (isTerminalStripeStatus(result.status)) canceled += 1;
      } catch (error) {
        // Canceled by someone else in between (the portal, another tab,
        // Stripe itself) is success. Anything else is a failure.
        const now = await call("retrieve_after_cancel_error", () => gateway.retrieveSubscription(subscription.id)).catch(() => null);
        if (!now || !isTerminalStripeStatus(now.status)) throw new TeardownError("provider_error", "cancel_subscription", error);
      }
    }
  }

  // Our recorded subscription is now terminal in Stripe. Say so locally, so
  // the row stops granting paid access and the 0050 guard lets it go.
  if (link.stripeSubscriptionId) {
    const recorded = snapshot.find((s) => s.id === link.stripeSubscriptionId);
    if (!recorded) throw new TeardownError("not_verified", "recorded_subscription_missing");
    const canceledAt = new Date((recorded.canceledAt ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
    try {
      await deps.store.recordTerminal(organizationId, recorded.id, toLocalSubscriptionStatus(recorded.status), canceledAt);
    } catch (error) {
      throw new TeardownError("store_error", "record_terminal", error);
    }
  }

  return canceled;
}

/** Every subscription Stripe knows for this workspace: the customer's, plus
 *  the one we recorded if it is somehow not on that customer. */
async function remoteSubscriptions(gateway: StripeBillingGateway, link: LocalBillingLink): Promise<RemoteSubscription[]> {
  const found = link.stripeCustomerId ? await call("list_subscriptions", () => gateway.listCustomerSubscriptions(link.stripeCustomerId!)) : [];

  if (link.stripeSubscriptionId && !found.some((s) => s.id === link.stripeSubscriptionId)) {
    const recorded = await call("retrieve_subscription", () => gateway.retrieveSubscription(link.stripeSubscriptionId!));
    // We recorded a subscription this Stripe account has never heard of —
    // most likely a test-mode id under live keys or the reverse. It may be
    // billing in the other account; we cannot say it is not.
    if (!recorded) throw new TeardownError("not_verified", "recorded_subscription_unknown");
    found.push(recorded);
  }
  return found;
}

async function call<T>(step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof TeardownError) throw error;
    throw new TeardownError("provider_error", step, error);
  }
}

/** The machine-readable shape of a Stripe error, for logs. Never the message:
 *  Stripe's messages quote customer and subscription ids verbatim. */
function providerErrorShape(error: unknown): Record<string, string> {
  if (!error || typeof error !== "object") return {};
  const e = error as { type?: unknown; code?: unknown; statusCode?: unknown };
  const out: Record<string, string> = {};
  if (typeof e.type === "string") out.providerErrorType = e.type.slice(0, 64);
  if (typeof e.code === "string") out.providerErrorCode = e.code.slice(0, 64);
  if (typeof e.statusCode === "number") out.providerStatus = String(e.statusCode);
  return out;
}

// ── Adapters ───────────────────────────────────────────────────────────────

function toRemote(subscription: Stripe.Subscription): RemoteSubscription {
  return { id: subscription.id, status: subscription.status, canceledAt: subscription.canceled_at ?? null };
}

function isResourceMissing(error: unknown): boolean {
  const e = error as { code?: unknown; statusCode?: unknown } | null;
  return Boolean(e && (e.code === "resource_missing" || e.statusCode === 404));
}

/** The gateway over the ONE shared Stripe client (`stripeClient()`). */
export function stripeBillingGateway(stripe: Stripe): StripeBillingGateway {
  return {
    async listCustomerSubscriptions(customerId) {
      const out: RemoteSubscription[] = [];
      for await (const subscription of stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 })) {
        out.push(toRemote(subscription));
      }
      return out;
    },
    async retrieveSubscription(subscriptionId) {
      try {
        return toRemote(await stripe.subscriptions.retrieve(subscriptionId));
      } catch (error) {
        if (isResourceMissing(error)) return null;
        throw error;
      }
    },
    async cancelSubscription(subscriptionId, idempotencyKey) {
      // Immediately, with no proration credit and no final invoice. Refunds
      // are a business decision (LEGAL_FACTS.refundPolicy), not this code's.
      return toRemote(await stripe.subscriptions.cancel(subscriptionId, { invoice_now: false, prorate: false }, { idempotencyKey }));
    },
    async listOpenCheckoutSessionIds(customerId) {
      const ids: string[] = [];
      for await (const session of stripe.checkout.sessions.list({ customer: customerId, status: "open", limit: 100 })) {
        ids.push(session.id);
      }
      return ids;
    },
    async expireCheckoutSession(sessionId, idempotencyKey) {
      await stripe.checkout.sessions.expire(sessionId, {}, { idempotencyKey });
    },
  };
}

/** The store over the service-role client and the 0050 functions. */
export function supabaseBillingTeardownStore(admin: SupabaseClient<Database>): BillingTeardownStore {
  return {
    async acquire(organizationId, attemptId) {
      const { data, error } = await admin.rpc("acquire_organization_billing_teardown", { p_organization_id: organizationId, p_attempt_id: attemptId });
      if (error) throw error;
      return data === true;
    },
    async release(organizationId, attemptId) {
      const { error } = await admin.rpc("release_organization_billing_teardown", { p_organization_id: organizationId, p_attempt_id: attemptId });
      if (error) throw error;
    },
    async read(organizationId) {
      const { data, error } = await admin
        .from("subscriptions")
        .select("stripe_customer_id, external_provider, external_subscription_id")
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        stripeCustomerId: data.stripe_customer_id,
        stripeSubscriptionId: data.external_provider === "stripe" ? data.external_subscription_id : null,
      };
    },
    async recordTerminal(organizationId, subscriptionId, status, canceledAt) {
      const { error } = await admin.rpc("record_stripe_subscription_terminal", {
        p_organization_id: organizationId,
        p_stripe_subscription_id: subscriptionId,
        p_status: status,
        p_canceled_at: canceledAt,
      });
      if (error) throw error;
    },
  };
}

/**
 * Production wiring. A PARTIAL Stripe configuration makes `stripeClient()`
 * throw; here that is the same as unconfigured — workspaces with no Stripe
 * customer can still be deleted, and any with one are refused.
 */
export function billingTeardownDependencies(admin: SupabaseClient<Database>): BillingTeardownDependencies {
  let stripe: Stripe | null = null;
  try {
    stripe = stripeClient();
  } catch {
    stripe = null;
  }
  return { store: supabaseBillingTeardownStore(admin), gateway: stripe ? stripeBillingGateway(stripe) : null };
}

/** How long a teardown lock blocks Checkout — mirrors the 15 minutes in 0050. */
export const BILLING_TEARDOWN_LOCK_MS = 15 * 60 * 1000;

/** Whether a workspace's billing is locked by a deletion in progress. */
export function isBillingTeardownLocked(lockedAt: string | null, now: number = Date.now()): boolean {
  if (!lockedAt) return false;
  const at = Date.parse(lockedAt);
  return Number.isFinite(at) && now - at < BILLING_TEARDOWN_LOCK_MS;
}
