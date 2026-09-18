import type { PlanTier, SubscriptionStatus } from "@/types/database";
import { PLAN_ENTITLEMENTS } from "./entitlements";

/**
 * The ONE place Stripe's vocabulary is translated into this product's.
 *
 * Stripe owns billing state. `entitlementsFor()` owns what a state is worth.
 * Those two sentences are the whole architecture, and this module is the seam
 * between them — deliberately pure, with no Stripe SDK import and no database
 * access, so every mapping decision is testable as a table rather than
 * reachable only through a live webhook.
 *
 * NOTHING HERE GRANTS ANYTHING.
 *
 * A status maps to a status. Whether that status confers Premium's limits is
 * decided by `ENTITLED_STATUSES` in entitlements.ts, which is `{active,
 * trialing}` and is not referenced here. That separation is why a new Stripe
 * state cannot accidentally become a free upgrade: the worst a bad mapping
 * can do is record the wrong status, and every status outside those two
 * resolves to Free.
 */

/** Stripe's `Subscription.status` values, as of API version 2024+. */
export type StripeSubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

/**
 * Stripe status → local status.
 *
 * Every arm is spelled out rather than passed through, because "the strings
 * happen to match" is not a decision anyone made and would silently absorb
 * whatever Stripe adds next.
 *
 * The product decisions embedded here, stated plainly:
 *
 *   - `past_due` keeps the subscription but NOT the entitlements. Stripe is
 *     still retrying the invoice, so the customer may yet pay; the row stays
 *     so the retry can restore them, while `entitlementsFor` serves Free in
 *     the meantime. Grace periods are a policy this product has not defined,
 *     and inventing one here would hand out paid features on an unpaid
 *     invoice.
 *   - `unpaid` is the same shape after Stripe has given up retrying.
 *   - `incomplete_expired` and `paused` likewise resolve to non-entitled
 *     states rather than to `canceled`, so the reason a workspace lost access
 *     is still legible afterwards.
 */
export function toLocalSubscriptionStatus(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "unpaid":
      return "unpaid";
    case "incomplete":
      return "incomplete";
    case "incomplete_expired":
      return "incomplete_expired";
    case "paused":
      return "paused";
    default:
      // An unrecognised status must never be treated as entitled. `incomplete`
      // is the safe landing spot: it means "not yet a working subscription",
      // resolves to Free, and is recoverable if Stripe later sends a status
      // this switch does know.
      return "incomplete";
  }
}

/** Statuses in which the subscription still exists at Stripe and may yet
 *  become entitled again without a new Checkout. Used only for UI wording. */
export function isRecoverableStatus(status: SubscriptionStatus): boolean {
  return status === "past_due" || status === "unpaid" || status === "incomplete";
}

/**
 * The plans that can be BOUGHT.
 *
 * Free is not purchasable — it is what an organization has when it is paying
 * for nothing. Deriving this from `PLAN_ENTITLEMENTS` rather than listing it
 * means a fourth tier added there is automatically purchasable, and a tier
 * whose price drops to zero automatically stops being.
 */
export type PurchasablePlan = Exclude<PlanTier, "free">;

export function isPurchasablePlan(value: unknown): value is PurchasablePlan {
  return (
    typeof value === "string" &&
    value in PLAN_ENTITLEMENTS &&
    PLAN_ENTITLEMENTS[value as PlanTier].priceMinorMonthly > 0
  );
}

export const PURCHASABLE_PLANS: readonly PurchasablePlan[] = (Object.keys(PLAN_ENTITLEMENTS) as PlanTier[]).filter(
  (tier): tier is PurchasablePlan => tier !== "free" && PLAN_ENTITLEMENTS[tier].priceMinorMonthly > 0,
);

/**
 * Where an organization currently sits, for deciding what a pricing card
 * should offer. Pure: the caller supplies the resolved plan.
 */
export type PlanRelation = "current" | "upgrade" | "downgrade" | "unavailable";

/**
 * How `target` relates to the plan the organization is on.
 *
 * Ordered by price, from the canonical model — not by a hardcoded ladder, so
 * this cannot disagree with what the plans actually cost.
 *
 * `downgrade` is deliberately distinct from `upgrade`: a Business customer
 * looking at Premium is not being offered a purchase, and a card that said
 * "Upgrade" there would be plainly wrong. Downgrades are handled in the
 * Stripe Customer Portal, where proration and period end are Stripe's job.
 */
export function planRelation(current: PlanTier, target: PlanTier): PlanRelation {
  if (current === target) return "current";

  const currentPrice = PLAN_ENTITLEMENTS[current].priceMinorMonthly;
  const targetPrice = PLAN_ENTITLEMENTS[target].priceMinorMonthly;

  if (targetPrice > currentPrice) return "upgrade";
  // Moving to a cheaper paid tier, or back to Free.
  return "downgrade";
}
