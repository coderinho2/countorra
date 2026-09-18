import type { PlanTier } from "@/types/database";

/**
 * The canonical entitlement model. One definition, server-side, typed.
 *
 * WHY THIS FILE EXISTS
 *
 * Entitlements were defined in four places that did not agree:
 *
 *   1. `PLAN_ENTITLEMENTS` in plans.ts — never called by anything.
 *   2. `PLAN_LIMITS` in limits.ts — the only one actually enforced.
 *   3. `plans.entitlements` jsonb in the database — read only to render a
 *      plan name in Settings.
 *   4. `FEATURE_FLAGS` in domain/config/feature-flags.ts — never called.
 *
 * Three of the four were dead. The one that was live covered only AI message
 * counts, so `maxOrganizations: 1` on Free was a number nothing checked: a
 * Free account could create organizations without limit, against a published
 * page that said "1 organization".
 *
 * This module replaces all four as the source of truth. limits.ts re-exports
 * from here rather than defining anything, so there is no second competing
 * model to drift.
 *
 * NO PLAN IS UNLIMITED FOR AI, AND THAT IS ENFORCED BY THE TYPE
 *
 * `aiMessagesPerDay` used to be `number | null`, with `null` meaning
 * "unlimited", and Business used it. Two consequences followed, and both were
 * real:
 *
 *   - Every enforcement site had to remember to handle `null`, and the check
 *     in `sendAiMessage` was written as `if (dailyLimit !== null)`. A tier
 *     whose limit was null therefore skipped metering entirely — not
 *     "a very high ceiling", but *no ceiling at all*, on the most expensive
 *     resource in the product.
 *   - The provider bill had no product-level bound. `provider-budget.ts`
 *     bounds a SINGLE request; nothing bounded the number of requests.
 *
 * Business is now capped at 500/day. The type is `number`, so "unlimited"
 * cannot be expressed for AI at all — reintroducing it would not compile,
 * rather than silently disabling a meter.
 *
 * `maxOrganizations` keeps `number | null`, because unlimited organizations
 * costs a row, not an Anthropic call.
 */

export interface PlanEntitlements {
  readonly tier: PlanTier;
  readonly name: string;
  /** Monthly price in minor units. Recorded for Stripe; the pricing page
   *  publishes these but no payment provider exists yet. */
  readonly priceMinorMonthly: number;
  readonly currency: "USD";
  /** Organizations one user may OWN. `null` = unlimited. Ownership, not
   *  membership: being invited into somebody else's workspace does not spend
   *  your allowance. */
  readonly maxOrganizations: number | null;
  /** Whether the assistant is available at all on this plan. */
  readonly aiAssistant: boolean;
  /**
   * User-initiated AI messages per organization per rolling 24h.
   *
   * Deliberately NOT nullable — see the module header. Every tier has a
   * number, every number is metered, and the meter has no branch that can be
   * skipped.
   */
  readonly aiMessagesPerDay: number;
  /** OCR / automatic extraction from uploaded documents. */
  readonly documentProcessing: boolean;
  /** Advanced tax tooling beyond the storage-and-configuration that exists. */
  readonly advancedTaxTools: boolean;
  /** Plaid / automatic bank connections. */
  readonly bankConnections: boolean;
  /** Priority support queue. */
  readonly prioritySupport: boolean;
}

export const PLAN_ENTITLEMENTS: Record<PlanTier, PlanEntitlements> = {
  free: {
    tier: "free",
    name: "Free",
    priceMinorMonthly: 0,
    currency: "USD",
    maxOrganizations: 1,
    aiAssistant: true,
    // 3/day. Lowered from 20 because 20 free Anthropic requests per
    // organization per day, times an unbounded number of free
    // organizations, is a cost structure with no floor under it.
    aiMessagesPerDay: 3,
    documentProcessing: false,
    advancedTaxTools: false,
    bankConnections: false,
    prioritySupport: false,
  },
  premium: {
    tier: "premium",
    name: "Premium",
    priceMinorMonthly: 1_900,
    currency: "USD",
    maxOrganizations: 3,
    aiAssistant: true,
    aiMessagesPerDay: 100,
    documentProcessing: true,
    advancedTaxTools: true,
    bankConnections: true,
    prioritySupport: false,
  },
  business: {
    tier: "business",
    name: "Business",
    priceMinorMonthly: 4_900,
    currency: "USD",
    maxOrganizations: null,
    aiAssistant: true,
    aiMessagesPerDay: 500,
    documentProcessing: true,
    advancedTaxTools: true,
    bankConnections: true,
    prioritySupport: true,
  },
};

export const PLAN_TIERS: readonly PlanTier[] = ["free", "premium", "business"];

/**
 * Which entitlements correspond to a feature that actually SHIPS today.
 *
 * An entitlement says what a tier is allowed to do. It does not say whether
 * the thing exists. Those are different facts, and conflating them is how a
 * pricing page comes to advertise a feature nobody can use: the flag is
 * `true` on Premium, so the page renders a checkmark, so the customer
 * believes they are buying something.
 *
 * Keeping the distinction here — beside the entitlements rather than in the
 * page — means the marketing surface reads its "Coming soon" from the same
 * module that grants the permission, and a feature cannot start being
 * advertised as live until someone flips it here on purpose.
 *
 * Flip an entry to `true` in the same change that ships the feature and its
 * gate. Not before.
 */
export type GatedFeature = "documentProcessing" | "advancedTaxTools" | "bankConnections" | "prioritySupport";

export const FEATURE_IMPLEMENTED: Record<GatedFeature, boolean> = {
  // Digital-PDF text is read (src/server/documents/pdf-text-layer.ts), but no
  // OCR provider exists for scans and photos, so the plan feature is not claimed.
  documentProcessing: false,
  // Tax storage and configuration exist; the calculation engine does not.
  advancedTaxTools: false,
  // Plaid is integrated (Task 12): Link, encrypted credentials, incremental
  // transaction sync, reconciliation into the ledger, webhooks and
  // re-authentication all ship, gated by `bank:manage`/`bank:sync` and by this
  // entitlement. Whether a given DEPLOYMENT can use it is a separate fact —
  // it needs Plaid credentials — and the pricing page reads that separately
  // rather than letting this flag imply it.
  bankConnections: true,
  // No support queue exists to prioritise within.
  prioritySupport: false,
};

/** Statuses that actually confer what the plan promises. Anything else — a
 *  lapsed card, a cancellation, an incomplete checkout — falls back to Free
 *  rather than continuing to grant a paid tier indefinitely. */
const ENTITLED_STATUSES = new Set(["active", "trialing"]);

export interface SubscriptionState {
  planId: PlanTier;
  status: string;
}

/**
 * The entitlements a subscription currently confers.
 *
 * Absent subscription → Free. Lapsed subscription → Free. This is the whole
 * downgrade path today, and it is what will keep working when Stripe writes
 * `past_due` or `canceled` to the row: enforcement reads the status on every
 * request rather than trusting the tier alone, so a downgrade takes effect
 * immediately without a separate reconciliation job.
 *
 * The argument comes from a `subscriptions` row read server-side under RLS.
 * It is never assembled from a request body, a form field or a header —
 * `tests/server/entitlement-enforcement.test.ts` fires a request carrying
 * `planId=business` and asserts it changes nothing.
 */
export function entitlementsFor(subscription: SubscriptionState | null | undefined): PlanEntitlements {
  if (!subscription) return PLAN_ENTITLEMENTS.free;
  if (!ENTITLED_STATUSES.has(subscription.status)) return PLAN_ENTITLEMENTS.free;
  return PLAN_ENTITLEMENTS[subscription.planId] ?? PLAN_ENTITLEMENTS.free;
}

/** Whether a plan grants a gated feature AND that feature exists yet. Both
 *  halves are required: a gate that opens onto nothing is not a feature. */
export function hasFeature(plan: PlanTier, feature: GatedFeature): boolean {
  return PLAN_ENTITLEMENTS[plan][feature] && FEATURE_IMPLEMENTED[feature];
}

/**
 * The organization allowance a user has, given every organization they own.
 *
 * A user has no plan of their own — `subscriptions` is keyed per organization
 * — so "how many organizations may this person create?" has no direct answer
 * in the schema. The rule here is the most generous reading that uses only
 * data that already exists: your allowance is the best allowance among the
 * organizations you own. Upgrade one workspace to Premium and you may own
 * three; each new one still starts on Free.
 *
 * This is a product decision inferred from the schema rather than one the
 * product ever stated, and it is flagged as such in the phase report. It is
 * isolated in this one function so that changing it later is a single edit.
 */
export function organizationAllowance(subscriptions: SubscriptionState[]): number | null {
  let best: number | null = PLAN_ENTITLEMENTS.free.maxOrganizations;

  for (const subscription of subscriptions) {
    const allowance = entitlementsFor(subscription).maxOrganizations;
    if (allowance === null) return null; // unlimited beats everything
    if (best !== null && allowance > best) best = allowance;
  }

  return best;
}

/** Whether one more organization may be created. `owned` is a count of
 *  organizations the user already owns. */
export function canCreateOrganization(owned: number, allowance: number | null): boolean {
  if (allowance === null) return true;
  return owned < allowance;
}

/** Human-readable allowance, for an error a user can act on. */
export function formatOrganizationAllowance(allowance: number | null): string {
  if (allowance === null) return "an unlimited number of organizations";
  return allowance === 1 ? "1 organization" : `${allowance} organizations`;
}

/** Every tier has a number now, so this has no "Unlimited" branch to take. */
export function formatAiMessageLimit(plan: PlanTier): string {
  return `${PLAN_ENTITLEMENTS[plan].aiMessagesPerDay}/day`;
}

export function getAiMessageLimit(plan: PlanTier): number {
  return PLAN_ENTITLEMENTS[plan].aiMessagesPerDay;
}
