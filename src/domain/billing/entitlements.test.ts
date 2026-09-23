import { describe, expect, it } from "vitest";
import {
  FEATURE_IMPLEMENTED,
  PLAN_ENTITLEMENTS,
  PLAN_TIERS,
  canCreateOrganization,
  entitlementsFor,
  formatAiMessageLimit,
  formatOrganizationAllowance,
  getAiMessageLimit,
  hasFeature,
  organizationAllowance,
  type GatedFeature,
} from "./entitlements";

/**
 * The canonical entitlement model.
 *
 * Every number here was previously defined in up to four disagreeing places,
 * three of which nothing executed. These tests pin the reconciled values so a
 * future edit to one tier cannot quietly contradict the published page again.
 */

const active = (planId: "free" | "premium" | "business") => ({ planId, status: "active" });
const GATED = Object.keys(FEATURE_IMPLEMENTED) as GatedFeature[];

describe("plan definitions", () => {
  it("defines exactly the three tiers the schema allows", () => {
    expect(Object.keys(PLAN_ENTITLEMENTS).sort()).toEqual(["business", "free", "premium"]);
    expect([...PLAN_TIERS].sort()).toEqual(["business", "free", "premium"]);
  });

  it("Free: $0, 1 organization, assistant included, 3 messages a day, nothing else", () => {
    expect(PLAN_ENTITLEMENTS.free).toMatchObject({
      priceMinorMonthly: 0,
      maxOrganizations: 1,
      aiAssistant: true,
      aiMessagesPerDay: 3,
      documentProcessing: false,
      advancedTaxTools: false,
      bankConnections: false,
      prioritySupport: false,
    });
  });

  it("Premium: $19/mo, 3 organizations, 100 messages a day, everything but priority support", () => {
    expect(PLAN_ENTITLEMENTS.premium).toMatchObject({
      priceMinorMonthly: 1_900,
      maxOrganizations: 3,
      aiAssistant: true,
      aiMessagesPerDay: 100,
      documentProcessing: true,
      advancedTaxTools: true,
      bankConnections: true,
      prioritySupport: false,
    });
  });

  it("Business: $49/mo, unlimited organizations, 500 messages a day, everything", () => {
    expect(PLAN_ENTITLEMENTS.business).toMatchObject({
      priceMinorMonthly: 4_900,
      maxOrganizations: null,
      aiAssistant: true,
      aiMessagesPerDay: 500,
      documentProcessing: true,
      advancedTaxTools: true,
      bankConnections: true,
      prioritySupport: true,
    });
  });

  it("caps EVERY tier's AI usage — no plan is unlimited", () => {
    // Business used to carry `null`, and the enforcement site read that as
    // "skip the meter" rather than "a high ceiling": the most expensive tier
    // counted nothing at all. A finite number on every tier is what keeps the
    // counter running everywhere.
    for (const tier of PLAN_TIERS) {
      const limit = PLAN_ENTITLEMENTS[tier].aiMessagesPerDay;
      expect(typeof limit, tier).toBe("number");
      expect(Number.isFinite(limit), tier).toBe(true);
      expect(limit, tier).toBeGreaterThan(0);
    }
  });

  it("keeps unlimited ORGANIZATIONS on Business, which costs a row rather than a provider call", () => {
    expect(PLAN_ENTITLEMENTS.business.maxOrganizations).toBeNull();
  });

  /**
   * The reconciled contradiction. The dead flag said Free had no assistant;
   * the live limiter, the published page and the Settings usage meter all say
   * it has one. If anyone sets this back to false, Free silently loses its
   * headline feature — so it is asserted explicitly.
   */
  it("gives Free a working assistant, which the dead flag denied", () => {
    expect(PLAN_ENTITLEMENTS.free.aiAssistant).toBe(true);
    expect(PLAN_ENTITLEMENTS.free.aiMessagesPerDay).toBe(3);
  });

  it("never sells a tier that cannot use the assistant", () => {
    for (const tier of PLAN_TIERS) expect(PLAN_ENTITLEMENTS[tier].aiAssistant).toBe(true);
  });

  it("increases what you get as the price rises", () => {
    expect(PLAN_ENTITLEMENTS.free.priceMinorMonthly).toBeLessThan(PLAN_ENTITLEMENTS.premium.priceMinorMonthly);
    expect(PLAN_ENTITLEMENTS.premium.priceMinorMonthly).toBeLessThan(PLAN_ENTITLEMENTS.business.priceMinorMonthly);
    expect(getAiMessageLimit("free")).toBeLessThan(getAiMessageLimit("premium"));
    expect(getAiMessageLimit("premium")).toBeLessThan(getAiMessageLimit("business"));
  });

  it("formats limits the way the pricing page renders them", () => {
    expect(formatAiMessageLimit("free")).toBe("3/day");
    expect(formatAiMessageLimit("premium")).toBe("100/day");
    expect(formatAiMessageLimit("business")).toBe("500/day");
  });

  it("returns a number from getAiMessageLimit for every tier, never null", () => {
    for (const tier of PLAN_TIERS) expect(getAiMessageLimit(tier), tier).toBeTypeOf("number");
  });
});

describe("gated features", () => {
  it("gates OCR to the paid tiers", () => {
    expect(PLAN_ENTITLEMENTS.free.documentProcessing).toBe(false);
    expect(PLAN_ENTITLEMENTS.premium.documentProcessing).toBe(true);
    expect(PLAN_ENTITLEMENTS.business.documentProcessing).toBe(true);
  });

  it("gates advanced tax tools and bank connections to the paid tiers", () => {
    for (const feature of ["advancedTaxTools", "bankConnections"] as const) {
      expect(PLAN_ENTITLEMENTS.free[feature], feature).toBe(false);
      expect(PLAN_ENTITLEMENTS.premium[feature], feature).toBe(true);
      expect(PLAN_ENTITLEMENTS.business[feature], feature).toBe(true);
    }
  });

  it("gives priority support to Business alone", () => {
    expect(PLAN_ENTITLEMENTS.free.prioritySupport).toBe(false);
    expect(PLAN_ENTITLEMENTS.premium.prioritySupport).toBe(false);
    expect(PLAN_ENTITLEMENTS.business.prioritySupport).toBe(true);
  });

  it("reports a gated feature as usable only once it is actually built", () => {
    // The honesty check. `hasFeature` requires BOTH the entitlement and an
    // implementation, so a paid tier can never be told it has something the
    // product cannot actually do. Each flag flips in the same commit that
    // ships the feature and its gate — bank connections did so in Task 12,
    // and document processing when Amazon Textract shipped (OCR for scans and
    // photos, AnalyzeExpense for receipts, AnalyzeID for identity documents).
    const built = ["bankConnections", "documentProcessing"];
    for (const feature of built) expect(hasFeature("business", feature as (typeof GATED)[number]), feature).toBe(true);
    for (const feature of GATED.filter((candidate) => !built.includes(candidate))) {
      expect(hasFeature("business", feature), feature).toBe(false);
    }
  });

  it("never reports a feature as usable for a tier that is not entitled to it", () => {
    for (const feature of GATED) expect(hasFeature("free", feature), feature).toBe(false);
  });

  it("covers every gated entitlement with an implementation flag", () => {
    // A new paid feature added to the entitlements without an entry here
    // would render as a checkmark on the pricing page by default. This makes
    // that omission a failing test instead of a false advertisement.
    for (const feature of GATED) expect(FEATURE_IMPLEMENTED[feature], feature).toBeTypeOf("boolean");
    expect(GATED.sort()).toEqual(["advancedTaxTools", "bankConnections", "documentProcessing", "prioritySupport"]);
  });
});

describe("entitlementsFor — status is part of the entitlement", () => {
  it("gives Free to an organization with no subscription row", () => {
    expect(entitlementsFor(null).tier).toBe("free");
    expect(entitlementsFor(undefined).tier).toBe("free");
  });

  it.each(["active", "trialing"])("honours a paid tier while %s", (status) => {
    expect(entitlementsFor({ planId: "premium", status }).tier).toBe("premium");
  });

  it.each(["past_due", "canceled", "incomplete", "unpaid", "paused"])("falls back to Free when %s", (status) => {
    const entitlements = entitlementsFor({ planId: "business", status });
    expect(entitlements.tier).toBe("free");
    expect(entitlements.maxOrganizations).toBe(1);
    expect(entitlements.aiMessagesPerDay).toBe(3);
  });

  it("does not keep serving Business limits to a lapsed Business subscription", () => {
    // The downgrade path, checked across every entitlement rather than just
    // the message count — cancelling must not leave OCR or bank connections
    // switched on either.
    const lapsed = entitlementsFor({ planId: "business", status: "canceled" });
    expect(lapsed.aiMessagesPerDay).toBe(3);
    expect(lapsed.documentProcessing).toBe(false);
    expect(lapsed.advancedTaxTools).toBe(false);
    expect(lapsed.bankConnections).toBe(false);
    expect(lapsed.prioritySupport).toBe(false);
  });

  it("falls back to Free for an unrecognised tier rather than throwing", () => {
    expect(entitlementsFor({ planId: "enterprise" as "free", status: "active" }).tier).toBe("free");
  });

  it("resolves an unknown or empty tier DOWN to Free, never up", () => {
    // The resolver is the only path from a stored row to an allowance, and
    // every input it does not recognise lands on the cheapest tier. A
    // fabricated tier name cannot buy anything.
    for (const planId of ["enterprise", "", "admin", "BUSINESS", "business "] as const) {
      const entitlements = entitlementsFor({ planId: planId as "free", status: "active" });
      expect(entitlements.tier, planId).toBe("free");
      expect(entitlements.aiMessagesPerDay, planId).toBe(3);
    }
  });

  it("ignores an unrecognised status rather than treating it as entitled", () => {
    // Only `active` and `trialing` confer a tier. Anything Stripe might write
    // later that this list has not been taught about resolves to Free, which
    // is the safe direction for a paid resource.
    for (const status of ["ACTIVE", "active ", "valid", "ok", "true", ""]) {
      expect(entitlementsFor({ planId: "business", status }).tier, status).toBe("free");
    }
  });
});

describe("organizationAllowance", () => {
  it("is 1 for a user who owns nothing yet", () => {
    expect(organizationAllowance([])).toBe(1);
  });

  it("is 1 for a user whose only workspace is Free", () => {
    expect(organizationAllowance([active("free")])).toBe(1);
  });

  it("is 3 once any owned workspace is Premium", () => {
    expect(organizationAllowance([active("free"), active("premium")])).toBe(3);
  });

  it("is unlimited once any owned workspace is Business", () => {
    expect(organizationAllowance([active("free"), active("business")])).toBeNull();
  });

  it("takes the best allowance, regardless of order", () => {
    expect(organizationAllowance([active("business"), active("free")])).toBeNull();
    expect(organizationAllowance([active("premium"), active("free")])).toBe(3);
  });

  it("ignores a lapsed paid subscription when computing the allowance", () => {
    expect(organizationAllowance([{ planId: "business", status: "canceled" }])).toBe(1);
    expect(organizationAllowance([{ planId: "premium", status: "past_due" }])).toBe(1);
  });
});

describe("canCreateOrganization", () => {
  it("lets a new Free user create their first workspace", () => {
    expect(canCreateOrganization(0, 1)).toBe(true);
  });

  it("stops a Free user creating a second", () => {
    expect(canCreateOrganization(1, 1)).toBe(false);
  });

  it("lets Premium create up to three and no more", () => {
    expect(canCreateOrganization(0, 3)).toBe(true);
    expect(canCreateOrganization(2, 3)).toBe(true);
    expect(canCreateOrganization(3, 3)).toBe(false);
    expect(canCreateOrganization(4, 3)).toBe(false);
  });

  it("never stops Business", () => {
    expect(canCreateOrganization(0, null)).toBe(true);
    expect(canCreateOrganization(500, null)).toBe(true);
  });

  it("refuses when already over the allowance, as a downgrade would leave someone", () => {
    // Downgrading from Premium with 3 workspaces to Free does not delete any
    // of them; it stops you adding a fourth.
    expect(canCreateOrganization(3, 1)).toBe(false);
  });
});

describe("formatOrganizationAllowance", () => {
  it("reads naturally in the refusal message", () => {
    expect(formatOrganizationAllowance(1)).toBe("1 organization");
    expect(formatOrganizationAllowance(3)).toBe("3 organizations");
    expect(formatOrganizationAllowance(null)).toBe("an unlimited number of organizations");
  });
});
