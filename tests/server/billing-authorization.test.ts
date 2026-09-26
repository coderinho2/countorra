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
    subscription: null as { planId: string; status: string; stripeCustomerId: string | null; deletionLockedAt?: string | null } | null,
    /** What the post-create re-read sees (Task 17): a deletion that started, or
     *  finished, while the Checkout session was being created. */
    afterCreate: "unchanged" as "unchanged" | "locked" | "deleted",
    expiredSessions: [] as string[],
    rateLimited: false,
    /** Everything handed to Stripe, so the test can inspect it. */
    checkoutCalls: [] as Record<string, unknown>[],
    portalCalls: [] as Record<string, unknown>[],
    customersCreated: [] as Record<string, unknown>[],
    boundCustomers: [] as { organizationId: string; customerId: string }[],
    /** The `subscriptions.stripe_customer_id` column, modelled so the real
     *  write guards can be exercised: `bind_stripe_customer` writes only when
     *  it is null, and the replacement update only while it still holds the
     *  stale id. */
    storedCustomerId: null as string | null,
    /** What Stripe says when the stored customer is retrieved. */
    retrieve: "ok" as "ok" | "missing" | "deleted" | "rate_limited",
    /** Every id Stripe was asked to retrieve, so "was it verified?" is testable. */
    customerRetrieves: [] as string[],
    /** Every replacement update, with the filters it was guarded by. */
    customerUpdates: [] as { values: Record<string, unknown>; filters: Record<string, unknown> }[],
    /** Simulates another request winning the race to replace the stale id. */
    onReplace: null as (() => void) | null,
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
        // The real function's WHERE clause: writes only when still null.
        if (state.storedCustomerId === null) state.storedCustomerId = args.p_stripe_customer_id;
        state.boundCustomers.push({ organizationId: args.p_organization_id, customerId: args.p_stripe_customer_id });
      }
      return { error: null };
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data:
              state.afterCreate === "deleted"
                ? null
                : {
                    stripe_customer_id: state.storedCustomerId,
                    deletion_locked_at: state.afterCreate === "locked" ? new Date().toISOString() : null,
                  },
            error: null,
          }),
        }),
      }),
      /** `update(...).eq(...).eq(...)`, resolved when awaited. The filters are
       *  applied, not ignored: that is the guard under test. */
      update: (values: Record<string, unknown>) => {
        const filters: Record<string, unknown> = {};
        const chain = {
          eq(column: string, value: unknown) {
            filters[column] = value;
            return chain;
          },
          then(resolve: (result: { error: null }) => void) {
            state.onReplace?.();
            state.customerUpdates.push({ values, filters: { ...filters } });
            // Only replaces while the column still names the stale id.
            if (filters.stripe_customer_id === state.storedCustomerId) {
              state.storedCustomerId = values.stripe_customer_id as string;
            }
            resolve({ error: null });
          },
        };
        return chain;
      },
    }),
  }),
}));

/** Shaped like the Stripe SDK's error for an id that does not exist for this
 *  key — which is what a test-mode customer looks like to a live key. */
function stripeResourceMissing(): Error {
  return Object.assign(new Error("No such customer; a similar object exists in test mode, but a live mode key was used to make this request."), {
    type: "StripeInvalidRequestError",
    code: "resource_missing",
    statusCode: 404,
    param: "customer",
  });
}

/** A transient failure. Must NEVER be read as "missing". */
function stripeRateLimited(): Error {
  return Object.assign(new Error("Too many requests"), { type: "StripeRateLimitError", code: "rate_limit", statusCode: 429 });
}

vi.mock("@/server/db/repositories/organizations", () => ({
  getOrganization: async (_c: unknown, id: string) => ({ id, name: "Acme", entityType: "personal", country: "US", baseCurrency: "USD" }),
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
                return { id: "cs_test_created", url: "https://checkout.stripe.test/session" };
              },
              expire: async (id: string) => {
                state.expiredSessions.push(id);
                return { id, status: "expired" };
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
              // First is `cus_created`; later ones are distinct, so a
              // replacement can be told apart from the original.
              return { id: state.customersCreated.length === 1 ? "cus_created" : `cus_created_${state.customersCreated.length}` };
            },
            retrieve: async (id: string) => {
              state.customerRetrieves.push(id);
              if (state.retrieve === "missing") throw stripeResourceMissing();
              if (state.retrieve === "rate_limited") throw stripeRateLimited();
              if (state.retrieve === "deleted") return { id, deleted: true };
              return { id };
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
  state.storedCustomerId = null;
  state.retrieve = "ok";
  state.customerRetrieves = [];
  state.customerUpdates = [];
  state.onReplace = null;
  state.auditActions = [];
  state.afterCreate = "unchanged";
  state.expiredSessions = [];
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

describe("a stored Stripe customer from the other mode", () => {
  /**
   * WHY THIS EXISTS. A `cus_…` belongs to ONE Stripe mode. The id is stored on
   * the organization's subscription row, and that row survives the switch from
   * test keys to live ones — so on the first live Checkout the stored id is
   * handed to a live key, Stripe answers `resource_missing`, and without
   * recovery it would answer that forever for that organization.
   *
   * This is not hypothetical: one real workspace held a test-mode customer id
   * when Countorra was being prepared for live Stripe.
   */

  it("(a) reuses a VALID existing customer, and creates nothing", async () => {
    state.subscription = { planId: "free", status: "active", stripeCustomerId: "cus_live_valid" };
    state.storedCustomerId = "cus_live_valid";
    state.retrieve = "ok";

    const result = await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(result.url).toBeTruthy();
    // Verified, then reused as-is.
    expect(state.customerRetrieves).toEqual(["cus_live_valid"]);
    expect(state.customersCreated).toEqual([]);
    expect(state.customerUpdates).toEqual([]);
    expect(state.checkoutCalls[0].customer).toBe("cus_live_valid");
    expect(state.storedCustomerId).toBe("cus_live_valid");
  });

  it("(b) replaces a customer that returns resource_missing, and checks out with the replacement", async () => {
    state.subscription = { planId: "free", status: "active", stripeCustomerId: "cus_from_test_mode" };
    state.storedCustomerId = "cus_from_test_mode";
    state.retrieve = "missing";

    const result = await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(result.error).toBeUndefined();
    expect(result.url).toBeTruthy();
    expect(state.customerRetrieves).toEqual(["cus_from_test_mode"]);
    // Exactly one replacement, created in the CURRENT mode.
    expect(state.customersCreated).toHaveLength(1);
    expect(state.customersCreated[0].metadata).toEqual({ organization_id: ORG });
    // The row now names the replacement, and Checkout used it.
    expect(state.storedCustomerId).toBe("cus_created");
    expect(state.checkoutCalls[0].customer).toBe("cus_created");
  });

  it("(b) writes the replacement through a guard naming the stale id, not a blind overwrite", async () => {
    state.subscription = { planId: "free", status: "active", stripeCustomerId: "cus_from_test_mode" };
    state.storedCustomerId = "cus_from_test_mode";
    state.retrieve = "missing";

    await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(state.customerUpdates).toHaveLength(1);
    const [update] = state.customerUpdates;
    expect(update.values).toMatchObject({ stripe_customer_id: "cus_created", external_provider: "stripe" });
    // Scoped to this organization AND to the id just proven unusable, so a
    // concurrent replacement cannot be clobbered.
    expect(update.filters).toEqual({ organization_id: ORG, stripe_customer_id: "cus_from_test_mode" });
  });

  it("(b) does not use bind_stripe_customer, which cannot replace a non-null id", async () => {
    state.subscription = { planId: "free", status: "active", stripeCustomerId: "cus_from_test_mode" };
    state.storedCustomerId = "cus_from_test_mode";
    state.retrieve = "missing";

    await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    // bind's WHERE clause is `stripe_customer_id is null`. Calling it here
    // would silently do nothing and Checkout would use an unbound customer.
    expect(state.boundCustomers).toEqual([]);
  });

  it("(b) also replaces a customer that was DELETED in the Dashboard", async () => {
    // Stripe raises no error for this one: retrieve succeeds with
    // `deleted: true`, and Checkout then refuses the customer.
    state.subscription = { planId: "free", status: "active", stripeCustomerId: "cus_deleted" };
    state.storedCustomerId = "cus_deleted";
    state.retrieve = "deleted";

    const result = await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(result.url).toBeTruthy();
    expect(state.customersCreated).toHaveLength(1);
    expect(state.storedCustomerId).toBe("cus_created");
  });

  it("(c) never reuses the stale id: it reaches neither Checkout nor the stored row", async () => {
    state.subscription = { planId: "free", status: "active", stripeCustomerId: "cus_from_test_mode" };
    state.storedCustomerId = "cus_from_test_mode";
    state.retrieve = "missing";

    await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(state.checkoutCalls[0].customer).not.toBe("cus_from_test_mode");
    expect(state.storedCustomerId).not.toBe("cus_from_test_mode");
    // And nothing anywhere asked Stripe to delete it — the old customer may
    // hold real billing history in the mode it belongs to.
    expect(state.customersCreated).toHaveLength(1);
  });

  it("(c) a TRANSIENT Stripe failure creates no customer at all", async () => {
    // The dangerous misreading: treating any error as "missing" would mint a
    // new customer on every retry and multiply customers for one workspace.
    state.subscription = { planId: "free", status: "active", stripeCustomerId: "cus_live_valid" };
    state.storedCustomerId = "cus_live_valid";
    state.retrieve = "rate_limited";

    const result = await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(result.error).toBeTruthy();
    expect(result.url).toBeUndefined();
    expect(state.customersCreated).toEqual([]);
    expect(state.customerUpdates).toEqual([]);
    // The stored id is untouched, so a later attempt still finds it.
    expect(state.storedCustomerId).toBe("cus_live_valid");
    expect(state.checkoutCalls).toEqual([]);
  });

  it("(c) a workspace with no customer yet is unaffected: nothing is retrieved", async () => {
    state.subscription = { planId: "free", status: "active", stripeCustomerId: null };
    state.storedCustomerId = null;

    await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    // No id to verify, so no retrieve — and the original bind path is used.
    expect(state.customerRetrieves).toEqual([]);
    expect(state.boundCustomers).toEqual([{ organizationId: ORG, customerId: "cus_created" }]);
    expect(state.customerUpdates).toEqual([]);
  });

  it("(b) loses a replacement race gracefully: it adopts the winner's customer", async () => {
    state.subscription = { planId: "free", status: "active", stripeCustomerId: "cus_from_test_mode" };
    state.storedCustomerId = "cus_from_test_mode";
    state.retrieve = "missing";
    // Another request replaces the stale id first, so this one's guard misses.
    state.onReplace = () => {
      state.storedCustomerId = "cus_winner";
      state.onReplace = null;
    };

    const result = await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(result.url).toBeTruthy();
    // The winner's customer stands, and Checkout uses it rather than ours.
    expect(state.storedCustomerId).toBe("cus_winner");
    expect(state.checkoutCalls[0].customer).toBe("cus_winner");
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

/**
 * A deletion in progress (Task 17). Deletion cancels every subscription and
 * expires every open Checkout session it can see; these close the window in
 * which a NEW one could be opened behind it.
 */
describe("billing is frozen while the workspace is being deleted", () => {
  const recently = () => new Date(Date.now() - 60_000).toISOString();

  it("refuses Checkout while a deletion holds the lock, before reaching Stripe", async () => {
    state.subscription = { planId: "free", status: "active", stripeCustomerId: "cus_org_a", deletionLockedAt: recently() };
    const result = await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(result.error).toMatch(/being deleted/i);
    expect(result.url).toBeUndefined();
    expect(state.checkoutCalls).toEqual([]);
    expect(state.customersCreated).toEqual([]);
  });

  it("allows Checkout again once a stale lock has lapsed", async () => {
    state.subscription = { planId: "free", status: "active", stripeCustomerId: "cus_org_a", deletionLockedAt: new Date(Date.now() - 20 * 60_000).toISOString() };
    expect((await createCheckoutSession({ organizationId: ORG, plan: "premium" })).url).toBeTruthy();
  });

  it("expires the session it just created if a deletion started meanwhile", async () => {
    state.afterCreate = "locked";
    const result = await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(result.error).toMatch(/being deleted/i);
    expect(result.url).toBeUndefined();
    expect(state.expiredSessions).toEqual(["cs_test_created"]);
  });

  it("expires the session it just created if the workspace is already gone", async () => {
    state.afterCreate = "deleted";
    const result = await createCheckoutSession({ organizationId: ORG, plan: "premium" });

    expect(result.url).toBeUndefined();
    expect(state.expiredSessions).toEqual(["cs_test_created"]);
  });

  it("refuses the Customer Portal while a deletion holds the lock", async () => {
    state.subscription = { planId: "premium", status: "canceled", stripeCustomerId: "cus_org_a", deletionLockedAt: recently() };
    const result = await createBillingPortalSession({ organizationId: ORG });

    expect(result.error).toMatch(/being deleted/i);
    expect(state.portalCalls).toEqual([]);
  });
});
