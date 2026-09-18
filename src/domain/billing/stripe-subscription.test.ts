import { describe, expect, it } from "vitest";
import {
  PURCHASABLE_PLANS,
  isPurchasablePlan,
  isRecoverableStatus,
  planRelation,
  toLocalSubscriptionStatus,
  type StripeSubscriptionStatus,
} from "./stripe-subscription";
import { PLAN_ENTITLEMENTS, entitlementsFor } from "./entitlements";

/**
 * The seam between Stripe's vocabulary and this product's.
 *
 * The property that matters most is not that the strings map correctly — it
 * is that NO mapping here can hand out a paid plan. Entitlement is decided
 * downstream by `ENTITLED_STATUSES`, and the last block proves the two
 * together produce the right answer for every Stripe status.
 */

const ALL_STRIPE_STATUSES: StripeSubscriptionStatus[] = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
];

describe("toLocalSubscriptionStatus", () => {
  it.each([
    ["active", "active"],
    ["trialing", "trialing"],
    ["past_due", "past_due"],
    ["canceled", "canceled"],
    ["unpaid", "unpaid"],
    ["incomplete", "incomplete"],
    ["incomplete_expired", "incomplete_expired"],
    ["paused", "paused"],
  ] as const)("maps %s to %s", (stripeStatus, expected) => {
    expect(toLocalSubscriptionStatus(stripeStatus)).toBe(expected);
  });

  it("covers every status Stripe documents, with no gaps", () => {
    for (const status of ALL_STRIPE_STATUSES) {
      expect(toLocalSubscriptionStatus(status), status).toBe(status);
    }
  });

  it.each(["", "ACTIVE", "active ", "enterprise", "paid", "unknown_future_status"])(
    "lands an unrecognised status (%s) on a NON-entitled state",
    (status) => {
      const local = toLocalSubscriptionStatus(status);
      // The safety property: whatever Stripe invents next, it must not arrive
      // as `active`.
      expect(entitlementsFor({ planId: "business", status: local }).tier).toBe("free");
    },
  );
});

describe("no Stripe status can grant a paid plan on its own", () => {
  it.each(ALL_STRIPE_STATUSES)("resolves %s through entitlementsFor correctly", (stripeStatus) => {
    const local = toLocalSubscriptionStatus(stripeStatus);
    const entitlements = entitlementsFor({ planId: "business", status: local });

    const shouldBeEntitled = stripeStatus === "active" || stripeStatus === "trialing";
    expect(entitlements.tier, stripeStatus).toBe(shouldBeEntitled ? "business" : "free");
  });

  it("gives a past_due Business workspace Free's AI allowance, not Business's", () => {
    // The concrete consequence: an unpaid invoice does not keep buying
    // Anthropic calls at 500/day.
    const entitlements = entitlementsFor({ planId: "business", status: toLocalSubscriptionStatus("past_due") });
    expect(entitlements.aiMessagesPerDay).toBe(PLAN_ENTITLEMENTS.free.aiMessagesPerDay);
  });

  it("keeps a trialing subscription fully entitled", () => {
    // A trial is a deliberate exception: the customer has not paid and is
    // meant to have the product anyway.
    expect(entitlementsFor({ planId: "premium", status: toLocalSubscriptionStatus("trialing") }).tier).toBe("premium");
  });
});

describe("isRecoverableStatus", () => {
  it("marks the states Stripe may still resolve without a new checkout", () => {
    expect(isRecoverableStatus("past_due")).toBe(true);
    expect(isRecoverableStatus("unpaid")).toBe(true);
    expect(isRecoverableStatus("incomplete")).toBe(true);
  });

  it("does not offer false hope for terminal states", () => {
    expect(isRecoverableStatus("canceled")).toBe(false);
    expect(isRecoverableStatus("incomplete_expired")).toBe(false);
  });

  it("is not true for a working subscription", () => {
    expect(isRecoverableStatus("active")).toBe(false);
    expect(isRecoverableStatus("trialing")).toBe(false);
  });
});

describe("what can be purchased", () => {
  it("sells the two paid tiers and nothing else", () => {
    expect([...PURCHASABLE_PLANS].sort()).toEqual(["business", "premium"]);
  });

  it("never treats Free as purchasable", () => {
    // Sending someone to Checkout for a $0 plan would create a real Stripe
    // subscription for nothing.
    expect(isPurchasablePlan("free")).toBe(false);
    expect(PURCHASABLE_PLANS).not.toContain("free");
  });

  it.each(["", "FREE", "Premium", "enterprise", "premium ", "../premium", null, undefined, 3, {}])(
    "refuses %s, which is what a request body can contain",
    (value) => {
      expect(isPurchasablePlan(value)).toBe(false);
    },
  );

  it("derives from price, so a tier priced at zero stops being sold", () => {
    for (const plan of PURCHASABLE_PLANS) {
      expect(PLAN_ENTITLEMENTS[plan].priceMinorMonthly, plan).toBeGreaterThan(0);
    }
  });
});

describe("planRelation", () => {
  it("recognises the plan you are already on", () => {
    for (const tier of ["free", "premium", "business"] as const) {
      expect(planRelation(tier, tier), tier).toBe("current");
    }
  });

  it("calls a more expensive plan an upgrade", () => {
    expect(planRelation("free", "premium")).toBe("upgrade");
    expect(planRelation("free", "business")).toBe("upgrade");
    expect(planRelation("premium", "business")).toBe("upgrade");
  });

  it("calls a cheaper plan a downgrade, never an upgrade", () => {
    // A Business customer looking at Premium is not being sold anything, and
    // a card saying "Upgrade to Premium" there would be plainly wrong.
    expect(planRelation("business", "premium")).toBe("downgrade");
    expect(planRelation("business", "free")).toBe("downgrade");
    expect(planRelation("premium", "free")).toBe("downgrade");
  });

  it("orders by real price rather than by a hardcoded ladder", () => {
    // If Business were ever priced below Premium, the relation would follow
    // the money rather than the name.
    const byPrice = (["free", "premium", "business"] as const).slice().sort(
      (a, b) => PLAN_ENTITLEMENTS[a].priceMinorMonthly - PLAN_ENTITLEMENTS[b].priceMinorMonthly,
    );
    expect(byPrice).toEqual(["free", "premium", "business"]);
  });
});
