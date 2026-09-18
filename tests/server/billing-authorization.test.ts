import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "@/types/database";

/**
 * Checkout and Customer Portal at the Server Action boundary — called
 * directly, the way an attacker does: no UI, no form, no client-side check in
 * the path.
 *
 * The properties under test are about what the SERVER decides rather than
 * what the request says. A price id never travels; a customer id never
 * travels; the organization id does travel and is therefore re-authorized
 * against the caller's own session every time.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const PREMIUM_PRICE = "price_premium_configured";
const BUSINESS_PRICE = "price_business_configured";

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    role: "owner" as OrgRole,
    /** Organizations the caller is actually a member of. */
    // Literal: `vi.hoisted` runs before the const declarations above.
    memberOf: ["11111111-1111-4111-8111-111111111111"],
    billingConfigured: true,
    subscription: null as { planId: string; status: string; stripeCustomerId: string | null } | null,
    rateLimited: false,
    /** Everything handed to Stripe, so the test can inspect it. */
    checkoutCalls: [] as Record<string, unknown>[],
    portalCalls: [] as Record<string, unknown>[],
    customersCreated: [] as Record<string, unknown>[],
    boundCustomers: [] as { organizationId: string; customerId: string }[],
    auditActions: [] as string[],
  };
});

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/observability", () => ({ reportError: () => {}, reportEvent: () => {} }));

/** `requireOrgMembership` redirects when the caller is not a member. Modelled
 *  as a throw, which is what a redirect is at this boundary. */
vi.mock("@/server/auth/session", () => ({
  requireUser: async () => ({ id: USER, email: "owner@example.test" }),
  getSession: async () => ({ id: USER, email: "owner@example.test" }),
  requireOrgMembership: async (organizationId: string) => {
    if (!state.memberOf.includes(organizationId)) throw new Error("NEXT_REDIRECT;/app");
    return { user: { id: USER, email: "owner@example.test" }, membership: { organizationId, userId: USER, role: state.role } };
  },
}));

vi.mock("@/server/security/rate-limit", () => ({
  enforceRateLimit: async () => ({ allowed: !state.rateLimited, retryAfterSeconds: 0, message: "Too many requests. Please wait.", degraded: false }),
  clientAddress: async () => "127.0.0.1",
  normalizeIdentifier: (v: string) => v,
}));

vi.mock("@/domain/audit/audit-log", () => ({
  recordAuditEvent: async (_c: unknown, event: { action: string }) => {
    state.auditActions.push(event.action);
  },
  AUDIT_ACTIONS: { billingCheckoutStarted: "billing.checkout_started" },
}));

vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/server/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, string>) => {
      if (name === "bind_stripe_customer") {
        state.boundCustomers.push({ organizationId: args.p_organization_id, customerId: args.p_stripe_customer_id });
      }
      return { error: null };
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { stripe_customer_id: state.boundCustomers.at(-1)?.customerId ?? null },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/server/db/repositories/organizations", () => ({
  getOrganization: async (_c: unknown, id: string) => ({ id, name: "Acme", entityType: "business", country: "US", baseCurrency: "USD" }),
}));

vi.mock("@/server/db/repositories/subscriptions", () => ({
  getSubscription: async () => state.subscription,
  listPlans: async () => [],
  listOwnedOrganizationSubscriptions: async () => ({ organizationIds: [], subscriptions: [] }),
}));

vi.mock("@/server/billing/stripe-config", () => ({
  stripeConfig: () =>
    state.billingConfigured
      ? { secretKey: "sk_test_x", webhookSecret: "whsec_x", priceIds: { premium: PREMIUM_PRICE, business: BUSINESS_PRICE }, testMode: true }
      : null,
  isBillingConfigured: () => state.billingConfigured,
  priceIdForPlan: (plan: "premium" | "business") =>
    state.billingConfigured ? ({ premium: PREMIUM_PRICE, business: BUSINESS_PRICE })[plan] : null,
  planForPriceId: () => null,
}));

vi.mock("@/server/billing/stripe-client", () => ({
  stripeClient: () =>
    state.billingConfigured
      ? {
          checkout: {
            sessions: {
              create: async (params: Record<string, unknown>) => {
                state.checkoutCalls.push(params);
                return { url: "https://checkout.stripe.test/session" };
              },
            },
          },
          billingPortal: {
            sessions: {
              create: async (params: Record<string, unknown>) => {
                state.portalCalls.push(params);
                return { url: "https://billing.stripe.test/portal" };
              },
            },
          },
          customers: {
            create: async (params: Record<string, unknown>) => {
              state.customersCreated.push(params);
              return { id: "cus_created" };
            },
          },
        }
      : null,
}));

const { createCheckoutSession, createBillingPortalSession } = await import("@/server/billing/actions");

/** Refused by returning an error, or by the membership redirect throwing. */
async function refused(fn: () => Promise<{ error?: string }>): Promise<boolean> {
  try {
    return Boolean((await fn()).error);
  } catch {
    return true;
  }
}

const ALL_ROLES: OrgRole[] = ["owner", "admin", "accountant", "manager", "employee", "viewer"];
const BILLING_ROLES: OrgRole[] = ["owner", "admin"];

beforeEach(() => {
  state.role = "owner";
  state.memberOf = [ORG];
  state.billingConfigured = true;
  state.subscription = { planId: "free", status: "active", stripeCustomerId: null };
  state.rateLimited = false;
  state.checkoutCalls = [];
  state.portalCalls = [];
  state.customersCreated = [];
  state.boundCustomers = [];
  state.auditActions = [];
});

describe("checkout authorization", () => {
  it.each(BILLING_ROLES)("lets %s start checkout", async (role) => {
    state.role = role;
    const result = await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(result.error).toBeUndefined();
    expect(result.url).toBe("https://checkout.stripe.test/session");
  });

  it.each(ALL_ROLES.filter((r) => !BILLING_ROLES.includes(r)))("refuses %s, reaching Stripe not at all", async (role) => {
    state.role = role;
    expect(await refused(() => createCheckoutSession({ organizationId: ORG, plan: "premium" }))).toBe(true);
    expect(state.checkoutCalls).toEqual([]);
    expect(state.customersCreated).toEqual([]);
  });

  it("refuses an organization the caller is not a member of", async () => {
    // The organization id is the ONE thing the client supplies, so it is the
    // one thing re-resolved against the session.
    state.memberOf = [ORG];
    expect(await refused(() => createCheckoutSession({ organizationId: OTHER_ORG, plan: "premium" }))).toBe(true);
    expect(state.checkoutCalls).toEqual([]);
  });

  it("refuses an owner of a DIFFERENT organization upgrading this one", async () => {
    state.memberOf = [OTHER_ORG];
    expect(await refused(() => createCheckoutSession({ organizationId: ORG, plan: "business" }))).toBe(true);
  });

  it("consumes the privileged rate-limit budget, after authorization", async () => {
    state.rateLimited = true;
    expect(await refused(() => createCheckoutSession({ organizationId: ORG, plan: "premium" }))).toBe(true);
    expect(state.checkoutCalls).toEqual([]);
  });

  it("records the intent in the audit log", async () => {
    await createCheckoutSession({ organizationId: ORG, plan: "premium" });
    expect(state.auditActions).toEqual(["billing.checkout_started"]);
  });
});

describe("the client cannot choose what it is buying", () => {
  it.each(["free", "", "enterprise", "PREMIUM", "premium ", "../premium", "price_1Xyz", "0"])(
    "refuses the plan value %s",
    async (plan) => {
      expect(await refused(() => createCheckoutSession({ organizationId: ORG, plan }))).toBe(true);
      expect(state.checkoutCalls).toEqual([]);
    },
  );

  it("sends the SERVER's price id for the named plan", async () => {
    await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(state.checkoutCalls[0].line_items).toEqual([{ price: PREMIUM_PRICE, quantity: 1 }]);
  });

  it("uses a different, equally server-chosen price for Business", async () => {
    await createCheckoutSession({ organizationId: ORG, plan: "business" });
    expect(state.checkoutCalls[0].line_items).toEqual([{ price: BUSINESS_PRICE, quantity: 1 }]);
  });

  it("ignores a price id smuggled alongside the plan", async () => {
    // There is no parameter for it, so this is really asserting the shape
    // stays that way: extra keys reach Stripe never.
    await createCheckoutSession({
      organizationId: ORG,
      plan: "premium",
      priceId: "price_attacker_controlled",
      amount: 1,
      line_items: [{ price: "price_free", quantity: 1 }],
    } as unknown as Parameters<typeof createCheckoutSession>[0]);

    expect(state.checkoutCalls[0].line_items).toEqual([{ price: PREMIUM_PRICE, quantity: 1 }]);
    expect(JSON.stringify(state.checkoutCalls[0])).not.toContain("price_attacker_controlled");
    expect(JSON.stringify(state.checkoutCalls[0])).not.toContain("price_free");
  });

  it("subscribes rather than taking a one-off payment", async () => {
    await createCheckoutSession({ organizationId: ORG, plan: "premium" });
    expect(state.checkoutCalls[0].mode).toBe("subscription");
  });

  it("binds the organization to the session for the webhook to find", async () => {
    await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(state.checkoutCalls[0].client_reference_id).toBe(ORG);
    expect(state.checkoutCalls[0].subscription_data).toEqual({ metadata: { organization_id: ORG } });
  });

  it("returns to URLs built from the canonical app URL", async () => {
    await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    // Never from a request header or a client-supplied return path — that is
    // how checkout flows become open redirects.
    expect(String(state.checkoutCalls[0].success_url)).toMatch(/^http:\/\/localhost:3000\//);
    expect(String(state.checkoutCalls[0].cancel_url)).toMatch(/^http:\/\/localhost:3000\//);
  });
});

describe("checkout refuses what would double-charge", () => {
  it("refuses the plan the workspace is already on", async () => {
    state.subscription = { planId: "premium", status: "active", stripeCustomerId: "cus_x" };
    const result = await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(result.error).toMatch(/already on that plan/i);
    expect(state.checkoutCalls).toEqual([]);
  });

  it("refuses a downgrade, which belongs in the portal", async () => {
    // A second Checkout for a cheaper plan creates a SECOND subscription and
    // bills the customer twice.
    state.subscription = { planId: "business", status: "active", stripeCustomerId: "cus_x" };
    const result = await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(result.error).toMatch(/manage billing/i);
    expect(state.checkoutCalls).toEqual([]);
  });

  it("allows an upgrade from Premium to Business", async () => {
    state.subscription = { planId: "premium", status: "active", stripeCustomerId: "cus_existing" };
    const result = await createCheckoutSession({ organizationId: ORG, plan: "business" });
    expect(result.url).toBeTruthy();
  });

  it("treats a LAPSED paid subscription as Free, so they can buy again", async () => {
    // Entitlement, not the nominal tier: a cancelled Premium workspace is on
    // Free and must be able to purchase Premium again.
    state.subscription = { planId: "premium", status: "canceled", stripeCustomerId: "cus_x" };
    const result = await createCheckoutSession({ organizationId: ORG, plan: "premium" });
    expect(result.url).toBeTruthy();
  });
});

describe("the Stripe customer", () => {
  it("is created once and reused afterwards", async () => {
    await createCheckoutSession({ organizationId: ORG, plan: "premium" });
    expect(state.customersCreated).toHaveLength(1);
    expect(state.boundCustomers).toEqual([{ organizationId: ORG, customerId: "cus_created" }]);

    state.subscription = { planId: "free", status: "active", stripeCustomerId: "cus_created" };
    state.customersCreated = [];
    await createCheckoutSession({ organizationId: ORG, plan: "business" });

    expect(state.customersCreated).toEqual([]);
    expect(state.checkoutCalls[1].customer).toBe("cus_created");
  });

  it("carries the organization id so an orphan customer can be traced", async () => {
    await createCheckoutSession({ organizationId: ORG, plan: "premium" });
    expect(state.customersCreated[0].metadata).toEqual({ organization_id: ORG });
  });
});

describe("billing that is not configured says so", () => {
  it("refuses checkout without pretending anything succeeded", async () => {
    state.billingConfigured = false;
    const result = await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(result.billingUnavailable).toBe(true);
    expect(result.error).toMatch(/isn't set up yet/i);
    expect(result.url).toBeUndefined();
  });

  it("still authorizes first, so an unauthorized caller learns nothing about setup", async () => {
    state.billingConfigured = false;
    state.role = "viewer";
    const result = await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(result.error).toMatch(/owner or admin/i);
    expect(result.billingUnavailable).toBeUndefined();
  });
});

describe("customer portal authorization", () => {
  beforeEach(() => {
    state.subscription = { planId: "premium", status: "active", stripeCustomerId: "cus_org_a" };
  });

  it.each(BILLING_ROLES)("lets %s open the portal", async (role) => {
    state.role = role;
    const result = await createBillingPortalSession({ organizationId: ORG });
    expect(result.url).toBe("https://billing.stripe.test/portal");
  });

  it.each(ALL_ROLES.filter((r) => !BILLING_ROLES.includes(r)))("refuses %s", async (role) => {
    state.role = role;
    expect(await refused(() => createBillingPortalSession({ organizationId: ORG }))).toBe(true);
    expect(state.portalCalls).toEqual([]);
  });

  it("refuses an organization the caller does not belong to", async () => {
    expect(await refused(() => createBillingPortalSession({ organizationId: OTHER_ORG }))).toBe(true);
    expect(state.portalCalls).toEqual([]);
  });

  it("uses the customer id from the organization's own row", async () => {
    await createBillingPortalSession({ organizationId: ORG });
    expect(state.portalCalls[0].customer).toBe("cus_org_a");
  });

  it("accepts no customer id from the caller", async () => {
    await createBillingPortalSession({
      organizationId: ORG,
      customer: "cus_someone_else",
      customerId: "cus_someone_else",
    } as unknown as Parameters<typeof createBillingPortalSession>[0]);

    expect(state.portalCalls[0].customer).toBe("cus_org_a");
    expect(JSON.stringify(state.portalCalls[0])).not.toContain("cus_someone_else");
  });

  it("returns to a URL built from the canonical app URL", async () => {
    await createBillingPortalSession({ organizationId: ORG });
    expect(String(state.portalCalls[0].return_url)).toMatch(/^http:\/\/localhost:3000\/app\//);
  });

  it("refuses a workspace that has never checked out", async () => {
    // Creating a customer here would open an empty portal that looks broken.
    state.subscription = { planId: "free", status: "active", stripeCustomerId: null };
    const result = await createBillingPortalSession({ organizationId: ORG });

    expect(result.error).toMatch(/doesn't have a billing account/i);
    expect(state.portalCalls).toEqual([]);
  });
});
