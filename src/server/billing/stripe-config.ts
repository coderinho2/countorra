import "server-only";
import { z } from "zod";
import type { PlanTier } from "@/types/database";
import { PURCHASABLE_PLANS, type PurchasablePlan } from "@/domain/billing/stripe-subscription";

/**
 * Stripe configuration. SERVER ONLY — none of these may reach a bundle.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *
 * The browser never names a Stripe price. It names a PLAN — "premium" — and
 * the server looks up which price id that means. A client that could supply a
 * price id could subscribe an organization to a $0 price it found in the
 * Stripe docs, or to another merchant's, and the webhook would then map that
 * price back to whatever plan it resolves to.
 *
 * So the mapping is one-directional and lives here: plan → price id for
 * Checkout, price id → plan for the webhook. Both read the same table, so a
 * price the server did not configure is unknown in both directions.
 *
 * WHY NOT VALIDATED AT MODULE LOAD
 *
 * `src/lib/env.ts` validates the app's required secrets eagerly, because the
 * app cannot function without them. Billing is different: the product runs
 * perfectly well with Stripe unconfigured — every organization is on Free,
 * and the pricing page says billing is not available yet. Throwing at import
 * would take the whole app down to punish an unconfigured optional feature.
 *
 * Instead `stripeConfig()` returns null when unconfigured, and every caller
 * has to decide what that means. The pricing page shows "billing not
 * available"; Checkout refuses; the webhook returns 503 so Stripe retries
 * later rather than treating the delivery as consumed.
 */

const configSchema = z.object({
  secretKey: z.string().min(1),
  webhookSecret: z.string().min(1),
  priceIds: z.record(z.string(), z.string().min(1)),
});

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  /** plan tier → Stripe Price id. Only purchasable plans appear. */
  priceIds: Readonly<Record<PurchasablePlan, string>>;
  /** True when the configured secret key is a test-mode key (`sk_test_…`). */
  testMode: boolean;
}

/** One env var per purchasable plan, derived so a new tier cannot be added to
 *  the canonical model without this failing to find its price. */
const PRICE_ENV_VAR: Record<PurchasablePlan, string> = {
  premium: "STRIPE_PREMIUM_PRICE_ID",
  business: "STRIPE_BUSINESS_PRICE_ID",
};

let cached: StripeConfig | null | undefined;

/**
 * The Stripe configuration, or `null` when billing is not set up.
 *
 * Returns null only when NOTHING is configured. A PARTIAL configuration
 * throws: a deployment with a secret key but no webhook secret would happily
 * take payments it could never hear about, leaving customers charged and
 * un-upgraded. That is worse than either extreme, so it fails loudly.
 */
export function stripeConfig(): StripeConfig | null {
  if (cached !== undefined) return cached;

  if (typeof window !== "undefined") {
    throw new Error("stripeConfig() must never be called from the client.");
  }

  const raw = {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    priceIds: Object.fromEntries(
      PURCHASABLE_PLANS.map((plan) => [plan, process.env[PRICE_ENV_VAR[plan]] ?? ""]).filter(([, value]) => value !== ""),
    ),
  };

  const anySet = raw.secretKey !== "" || raw.webhookSecret !== "" || Object.keys(raw.priceIds).length > 0;
  if (!anySet) {
    cached = null;
    return cached;
  }

  const missing: string[] = [];
  if (!raw.secretKey) missing.push("STRIPE_SECRET_KEY");
  if (!raw.webhookSecret) missing.push("STRIPE_WEBHOOK_SECRET");
  for (const plan of PURCHASABLE_PLANS) {
    if (!raw.priceIds[plan]) missing.push(PRICE_ENV_VAR[plan]);
  }

  if (missing.length > 0) {
    // Names only. A value here would put a live secret in a log.
    throw new Error(
      `Stripe is partially configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Set all of them, or none of them to run without billing.`,
    );
  }

  const parsed = configSchema.parse(raw);

  const priceValues = Object.values(parsed.priceIds);
  if (new Set(priceValues).size !== priceValues.length) {
    // Two plans on one price would make the webhook's reverse lookup
    // ambiguous, and an upgrade indistinguishable from a no-op.
    throw new Error("Stripe price ids must be distinct: two plans are configured with the same price id.");
  }

  cached = {
    secretKey: parsed.secretKey,
    webhookSecret: parsed.webhookSecret,
    priceIds: parsed.priceIds as Record<PurchasablePlan, string>,
    testMode: parsed.secretKey.startsWith("sk_test_"),
  };
  return cached;
}

/** Test seam. Never called by application code. */
export function resetStripeConfigCache(): void {
  cached = undefined;
}

/** Whether billing is available at all. Safe to call anywhere on the server. */
export function isBillingConfigured(): boolean {
  return stripeConfig() !== null;
}

/**
 * The Stripe price for a plan the SERVER chose.
 *
 * Takes a `PurchasablePlan`, so a caller cannot pass "free" or an arbitrary
 * string without the type system objecting — and the runtime check behind it
 * is `isPurchasablePlan`, applied to the request before this is reached.
 */
export function priceIdForPlan(plan: PurchasablePlan): string | null {
  return stripeConfig()?.priceIds[plan] ?? null;
}

/**
 * The reverse lookup, for the webhook: which plan did Stripe just bill for?
 *
 * `null` for any price this deployment did not configure — a price from
 * another product in the same Stripe account, a deleted price, or a
 * hand-crafted event. The webhook records those and changes nothing, rather
 * than guessing a tier.
 */
export function planForPriceId(priceId: string | null | undefined): PlanTier | null {
  if (!priceId) return null;
  const config = stripeConfig();
  if (!config) return null;

  for (const plan of PURCHASABLE_PLANS) {
    if (config.priceIds[plan] === priceId) return plan;
  }
  return null;
}
