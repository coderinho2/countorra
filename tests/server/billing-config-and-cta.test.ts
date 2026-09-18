import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PlanTier } from "@/types/database";

/**
 * Two things that are easy to get quietly wrong.
 *
 * 1. Stripe CONFIGURATION. A half-configured deployment can take payments it
 *    can never hear about, leaving customers charged and un-upgraded — worse
 *    than either extreme, so it must fail loudly rather than partially work.
 *
 * 2. What each pricing card OFFERS. The CTA is the only place a purchase can
 *    start, and showing "Upgrade" to someone already paying, or a purchase
 *    button when billing is not connected, are both real defects that no
 *    type checks.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    signedIn: true,
    owned: [] as { organizationId: string; planId: string; status: string }[],
    billingConfigured: true,
  };
});

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));

vi.mock("@/server/auth/session", () => ({
  getSession: async () => (state.signedIn ? { id: "user-1", email: "a@example.test" } : null),
}));

vi.mock("@/server/db/repositories/subscriptions", () => ({
  listOwnedOrganizationSubscriptions: async () => ({
    organizationIds: state.owned.map((o) => o.organizationId),
    subscriptions: state.owned.map((o) => ({ planId: o.planId, status: o.status, stripeCustomerId: null })),
  }),
}));

vi.mock("@/server/billing/stripe-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/billing/stripe-config")>();
  return { ...actual, isBillingConfigured: () => state.billingConfigured };
});

const { ctaModeFor, resolveBillingViewer } = await import("@/server/billing/viewer-context");
const { stripeConfig, resetStripeConfigCache, planForPriceId, priceIdForPlan } = await import("@/server/billing/stripe-config");

const STRIPE_VARS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PREMIUM_PRICE_ID", "STRIPE_BUSINESS_PRICE_ID"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  state.signedIn = true;
  state.owned = [];
  state.billingConfigured = true;
  for (const key of STRIPE_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetStripeConfigCache();
});

afterEach(() => {
  for (const key of STRIPE_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetStripeConfigCache();
});

function configure(overrides: Partial<Record<(typeof STRIPE_VARS)[number], string>> = {}) {
  const values = {
    STRIPE_SECRET_KEY: "sk_test_abc",
    STRIPE_WEBHOOK_SECRET: "whsec_abc",
    STRIPE_PREMIUM_PRICE_ID: "price_premium",
    STRIPE_BUSINESS_PRICE_ID: "price_business",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === "") delete process.env[key];
    else process.env[key] = value;
  }
  resetStripeConfigCache();
}

describe("Stripe configuration", () => {
  it("is null when nothing is set, so the product runs without billing", () => {
    expect(stripeConfig()).toBeNull();
  });

  it("loads a complete configuration", () => {
    configure();
    const config = stripeConfig();

    expect(config?.priceIds).toEqual({ premium: "price_premium", business: "price_business" });
    expect(config?.testMode).toBe(true);
  });

  it.each(STRIPE_VARS)("REFUSES a configuration missing %s", (missing) => {
    // Half-configured is the dangerous state, not the safe one: a deployment
    // with a secret key and no webhook secret charges cards and never learns
    // the outcome.
    configure({ [missing]: "" });
    expect(() => stripeConfig()).toThrow(new RegExp(missing));
  });

  it("never puts a secret VALUE in the error it throws", () => {
    configure({ STRIPE_WEBHOOK_SECRET: "" });
    try {
      stripeConfig();
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).toContain("STRIPE_WEBHOOK_SECRET");
      expect((error as Error).message).not.toContain("sk_test_abc");
      expect((error as Error).message).not.toContain("price_premium");
    }
  });

  it("refuses two plans sharing one price id", () => {
    // The reverse lookup would be ambiguous, and an upgrade would be
    // indistinguishable from a no-op.
    configure({ STRIPE_BUSINESS_PRICE_ID: "price_premium" });
    expect(() => stripeConfig()).toThrow(/distinct/i);
  });

  it("recognises a live key as not test mode", () => {
    configure({ STRIPE_SECRET_KEY: "sk_live_abc" });
    expect(stripeConfig()?.testMode).toBe(false);
  });
});

describe("the price allowlist works in both directions", () => {
  beforeEach(() => configure());

  it("resolves a plan to its configured price", () => {
    expect(priceIdForPlan("premium")).toBe("price_premium");
    expect(priceIdForPlan("business")).toBe("price_business");
  });

  it("resolves a configured price back to its plan", () => {
    expect(planForPriceId("price_premium")).toBe("premium");
    expect(planForPriceId("price_business")).toBe("business");
  });

  it.each(["price_from_another_product", "price_", "", "premium", "PRICE_PREMIUM", null, undefined])(
    "refuses to map the unknown price %s to any plan",
    (priceId) => {
      // A webhook carrying an unconfigured price must change nothing.
      expect(planForPriceId(priceId)).toBeNull();
    },
  );

  it("maps nothing at all when billing is unconfigured", () => {
    resetStripeConfigCache();
    for (const key of STRIPE_VARS) delete process.env[key];
    expect(planForPriceId("price_premium")).toBeNull();
    expect(priceIdForPlan("premium")).toBeNull();
  });
});

describe("no Stripe secret is reachable from the browser", () => {
  const ROOT = process.cwd();
  const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

  it("never names a Stripe variable with a NEXT_PUBLIC_ prefix", () => {
    // The one mistake that would put a secret key in the client bundle.
    for (const file of [".env.example", "src/server/billing/stripe-config.ts", "src/lib/env.ts"]) {
      expect(read(file), file).not.toMatch(/NEXT_PUBLIC_STRIPE/);
    }
  });

  it("keeps the config and client modules server-only", () => {
    for (const file of ["src/server/billing/stripe-config.ts", "src/server/billing/stripe-client.ts", "src/server/billing/viewer-context.ts"]) {
      expect(read(file), file).toMatch(/^import "server-only";/m);
    }
  });

  it("does not read a Stripe secret from any client component", () => {
    for (const file of ["src/components/billing/plan-cta.tsx", "src/components/billing/manage-billing-button.tsx"]) {
      const source = read(file);
      expect(source, file).toContain('"use client"');
      expect(source, file).not.toMatch(/STRIPE_|sk_live|sk_test|whsec_/);
      // The client names a PLAN, never a price.
      expect(source, file).not.toMatch(/price_/);
    }
  });
});

/** Sets up a viewer owning the given workspaces. */
function owning(...plans: { organizationId: string; planId: PlanTier; status?: string }[]) {
  state.owned = plans.map((p) => ({ organizationId: p.organizationId, planId: p.planId, status: p.status ?? "active" }));
}

describe("pricing CTA behaviour", () => {
  it("offers signup on EVERY card to a signed-out visitor", async () => {
    // Including Free. A visitor with no account is not "on" the Free plan,
    // and labelling it as their current one left that card with no call to
    // action at all — which the pricing redesign exists to prevent.
    state.signedIn = false;
    const viewer = await resolveBillingViewer();

    for (const plan of ["free", "premium", "business"] as const) {
      expect(ctaModeFor(viewer, plan), plan).toEqual({ kind: "signed-out" });
    }
  });

  it("never shows a signed-out visitor a 'current plan' label", async () => {
    state.signedIn = false;
    const viewer = await resolveBillingViewer();

    for (const plan of ["free", "premium", "business"] as const) {
      expect(ctaModeFor(viewer, plan).kind, plan).not.toBe("current");
    }
  });

  describe("a Free user", () => {
    beforeEach(() => owning({ organizationId: ORG, planId: "free" }));

    it("sees Free as their current plan", async () => {
      const viewer = await resolveBillingViewer();
      expect(ctaModeFor(viewer, "free")).toEqual({ kind: "current" });
    });

    it("can upgrade to Premium and to Business", async () => {
      const viewer = await resolveBillingViewer();
      expect(ctaModeFor(viewer, "premium")).toEqual({ kind: "checkout", organizationId: ORG });
      expect(ctaModeFor(viewer, "business")).toEqual({ kind: "checkout", organizationId: ORG });
    });
  });

  describe("a Premium user", () => {
    beforeEach(() => owning({ organizationId: ORG, planId: "premium" }));

    it("sees Premium as their current plan", async () => {
      const viewer = await resolveBillingViewer();
      expect(ctaModeFor(viewer, "premium")).toEqual({ kind: "current" });
    });

    it("can upgrade to Business", async () => {
      const viewer = await resolveBillingViewer();
      expect(ctaModeFor(viewer, "business")).toEqual({ kind: "checkout", organizationId: ORG });
    });

    it("is not offered Free as a purchase", async () => {
      const viewer = await resolveBillingViewer();
      expect(ctaModeFor(viewer, "free").kind).toBe("downgrade");
    });
  });

  describe("a Business user", () => {
    beforeEach(() => owning({ organizationId: ORG, planId: "business" }));

    it("sees Business as their current plan", async () => {
      const viewer = await resolveBillingViewer();
      expect(ctaModeFor(viewer, "business")).toEqual({ kind: "current" });
    });

    it("is never told a cheaper plan is an upgrade", async () => {
      const viewer = await resolveBillingViewer();
      for (const plan of ["free", "premium"] as const) {
        expect(ctaModeFor(viewer, plan).kind, plan).toBe("downgrade");
      }
    });

    it("is sent to the portal to change plan, not to a second checkout", async () => {
      const viewer = await resolveBillingViewer();
      const mode = ctaModeFor(viewer, "premium");
      expect(mode).toMatchObject({ kind: "downgrade", href: `/app/${ORG}/settings#plan` });
    });
  });

  describe("a lapsed subscriber", () => {
    it("is treated as Free, and can buy again", async () => {
      owning({ organizationId: ORG, planId: "premium", status: "canceled" });
      const viewer = await resolveBillingViewer();

      expect(viewer.currentPlan).toBe("free");
      expect(ctaModeFor(viewer, "premium")).toEqual({ kind: "checkout", organizationId: ORG });
    });

    it.each(["past_due", "unpaid", "incomplete", "incomplete_expired", "paused"])("is treated as Free while %s", async (status) => {
      owning({ organizationId: ORG, planId: "business", status });
      const viewer = await resolveBillingViewer();
      expect(viewer.currentPlan).toBe("free");
    });
  });

  describe("someone who owns several workspaces", () => {
    beforeEach(() => owning({ organizationId: ORG, planId: "free" }, { organizationId: OTHER_ORG, planId: "free" }));

    it("is asked which one to upgrade rather than having one chosen", async () => {
      // Guessing would put a real recurring charge on the wrong workspace.
      const viewer = await resolveBillingViewer();
      expect(viewer.checkoutOrganizationId).toBeNull();
      expect(ctaModeFor(viewer, "premium")).toEqual({ kind: "choose-workspace", href: "/app" });
    });

    it("shows the best plan among them as current", async () => {
      owning({ organizationId: ORG, planId: "free" }, { organizationId: OTHER_ORG, planId: "business" });
      const viewer = await resolveBillingViewer();

      expect(viewer.currentPlan).toBe("business");
      expect(ctaModeFor(viewer, "business")).toEqual({ kind: "current" });
    });
  });

  describe("when Stripe is not connected", () => {
    beforeEach(() => {
      state.billingConfigured = false;
      owning({ organizationId: ORG, planId: "free" });
    });

    it("says setup is required instead of offering a purchase", async () => {
      const viewer = await resolveBillingViewer();
      expect(ctaModeFor(viewer, "premium")).toEqual({ kind: "unavailable" });
      expect(ctaModeFor(viewer, "business")).toEqual({ kind: "unavailable" });
    });

    it("still shows the current plan correctly", async () => {
      const viewer = await resolveBillingViewer();
      expect(ctaModeFor(viewer, "free")).toEqual({ kind: "current" });
    });
  });
});
