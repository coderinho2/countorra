import type { PlanTier } from "@/types/database";
import {
  FEATURE_IMPLEMENTED,
  PLAN_ENTITLEMENTS,
  formatOrganizationAllowance,
  type GatedFeature,
} from "./entitlements";

/**
 * How a plan is DESCRIBED, derived entirely from what it actually grants.
 *
 * The pricing cards, the comparison table and the Settings billing panel all
 * render from this one list, so they cannot drift from each other or from the
 * server. Nothing here is written by hand: "100 AI requests/day" is
 * `PLAN_ENTITLEMENTS.premium.aiMessagesPerDay`, and if that number changes the
 * marketing copy changes with it.
 *
 * THREE STATES, NOT TWO
 *
 * A feature line is `included`, `excluded`, or `coming-soon`. The third exists
 * because the paid tiers are ENTITLED to OCR, tax tooling, bank connections
 * and priority support, and none of those are built. A checkmark would be
 * selling something undeliverable; a dash would understate what the plan will
 * be. `FEATURE_IMPLEMENTED` — declared beside the entitlements, not here —
 * decides which, so the day a feature ships one boolean flips and every
 * surface starts telling the truth about it at once.
 */

export type FeatureState = "included" | "excluded" | "coming-soon";

export interface PlanFeatureLine {
  label: string;
  state: FeatureState;
}

/** The gated features, in the order they are presented everywhere. */
const GATED_FEATURE_LABELS: ReadonlyArray<{ feature: GatedFeature; label: string }> = [
  { feature: "documentProcessing", label: "OCR" },
  { feature: "advancedTaxTools", label: "Advanced tax tools" },
  { feature: "bankConnections", label: "Plaid / bank connections" },
  { feature: "prioritySupport", label: "Priority support" },
];

export function gatedFeatureState(tier: PlanTier, feature: GatedFeature): FeatureState {
  if (!PLAN_ENTITLEMENTS[tier][feature]) return "excluded";
  return FEATURE_IMPLEMENTED[feature] ? "included" : "coming-soon";
}

/**
 * Every line shown for a plan, in a fixed order so the three cards read as
 * columns of the same list rather than three different lists.
 */
export function planFeatureLines(tier: PlanTier): PlanFeatureLine[] {
  const plan = PLAN_ENTITLEMENTS[tier];

  return [
    {
      label: plan.maxOrganizations === null ? "Unlimited organizations" : formatOrganizationAllowance(plan.maxOrganizations),
      state: "included",
    },
    { label: `${plan.aiMessagesPerDay} AI requests/day`, state: "included" },
    { label: "AI assistant", state: plan.aiAssistant ? "included" : "excluded" },
    ...GATED_FEATURE_LABELS.map(({ feature, label }) => ({ label, state: gatedFeatureState(tier, feature) })),
  ];
}

/** `$19`, `$0`. Minor units, so no floating point reaches a price. */
export function formatPlanPrice(tier: PlanTier): string {
  const minor = PLAN_ENTITLEMENTS[tier].priceMinorMonthly;
  return `$${minor / 100}`;
}

/** The period wording beside the price. Free is not billed, so it does not
 *  claim to be "per month". */
export function planPriceNote(tier: PlanTier): string {
  return PLAN_ENTITLEMENTS[tier].priceMinorMonthly === 0 ? "forever" : "per month";
}
