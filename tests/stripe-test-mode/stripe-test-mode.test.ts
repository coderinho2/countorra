import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

/**
 * REAL STRIPE TEST MODE verification (Task 18).
 *
 * Every test in the gated block below talks to Stripe's real API with a
 * `sk_test_…` key. Nothing here is a mock of Stripe. What IS stood in for is
 * Countorra's own session and database at the Server Action boundary (who is
 * signed in, which rows exist): those are verified for real elsewhere —
 * tests/server/*.test.ts for authorization, tests/rls/*.test.ts against real
 * Postgres for the webhook's write path and the deletion guard.
 *
 * HOW IT IS GATED
 *
 *   - The four STRIPE_* values are read from the environment, or from
 *     .env.local. Values are never printed.
 *   - No `sk_test_` key, or any value missing → the block is SKIPPED. A
 *     skipped run is "BLOCKED: not configured", never a pass.
 *   - A LIVE key (`sk_live_` / `rk_live_`) → the file FAILS immediately.
 *     This suite creates customers and subscriptions; it must never run
 *     against real money.
 *
 * Everything it creates is tagged `countorra_test_run` and deleted in
 * afterAll (deleting a test-mode customer cancels its subscriptions).
 *
 * WHAT IT CANNOT DO ALONE
 *
 * Completing a hosted Checkout page needs a browser session on Stripe's
 * domain, and real webhook DELIVERY needs a public endpoint or the Stripe CLI
 * (`stripe listen --forward-to localhost:3000/api/stripe/webhook`). Those two
 * are the manual steps in DEPLOYMENT.md §8; this suite covers everything that
 * can be driven through the API.
 */

const STRIPE_VARS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PREMIUM_PRICE_ID", "STRIPE_BUSINESS_PRICE_ID"] as const;

function readLocalEnv(): Record<string, string> {
  const file = path.resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Decides whether the suite may run. Exported for the always-on test below. */
export function stripeTestModeGate(env: Record<string, string | undefined>): { enabled: boolean; missing: string[]; live: boolean; partial: string | null } {
  const key = env.STRIPE_SECRET_KEY ?? "";
  const live = /^(sk|rk)_live_/.test(key);
  const missing = STRIPE_VARS.filter((name) => !env[name]);
  const enabled = !live && missing.length === 0 && key.startsWith("sk_test_");
  // Credentials that are present but unusable are a FAILURE to report, not a
  // reason to skip: a skip would read as "not configured" when it is
  // misconfigured.
  const anyPresent = missing.length < STRIPE_VARS.length;
  const partial =
    live || enabled || !anyPresent
      ? null
      : missing.length > 0
        ? `Stripe is partly configured: missing ${missing.join(", ")}`
        : "STRIPE_SECRET_KEY is not a secret TEST key (sk_test_…)";
  return { enabled, missing, live, partial };
}

const local = readLocalEnv();
const merged: Record<string, string | undefined> = { ...local, ...process.env };
const gate = stripeTestModeGate(merged);

if (gate.live) {
  throw new Error("STRIPE_SECRET_KEY is a LIVE key. The Stripe test-mode suite refuses to run against live mode.");
}
if (gate.partial) {
  throw new Error(`${gate.partial}. Fix the configuration (scripts/stripe-test-setup.mjs check) rather than letting the real-Stripe tests skip.`);
}

// Only what the modules under test need. Values are never logged.
if (gate.enabled) {
  for (const name of STRIPE_VARS) process.env[name] = merged[name];
}
for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_APP_URL"] as const) {
  process.env[name] ??= local[name] ?? (name === "NEXT_PUBLIC_SUPABASE_URL" ? "https://example.supabase.co" : name === "NEXT_PUBLIC_APP_URL" ? "http://localhost:3000" : "test-anon-key");
}
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";

// ── Countorra's session and rows, stood in for (see header) ───────────────
const ORG = "5d7a1f00-0000-4000-8000-000000000018";
const OTHER_ORG = "5d7a1f00-0000-4000-8000-000000000099";

const app = vi.hoisted(() => ({
  memberOf: ["5d7a1f00-0000-4000-8000-000000000018"],
  subscription: null as null | { planId: string; status: string; stripeCustomerId: string | null; deletionLockedAt?: string | null },
  boundCustomer: null as string | null,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/auth/session", () => ({
  requireUser: async () => ({ id: "user-stripe-test", email: "stripe-test@example.test" }),
  requireOrgMembership: async (organizationId: string) => {
    if (!app.memberOf.includes(organizationId)) throw new Error("NEXT_REDIRECT;/app");
    return { user: { id: "user-stripe-test", email: "stripe-test@example.test" }, membership: { organizationId, userId: "user-stripe-test", role: "owner" } };
  },
}));
vi.mock("@/server/security/rate-limit", () => ({ enforceRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0, message: null, degraded: false }) }));
vi.mock("@/domain/audit/audit-log", () => ({ recordAuditEvent: async () => {}, AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }) }));
vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/server/db/repositories/organizations", () => ({
  getOrganization: async (_c: unknown, id: string) => ({ id, name: "TEST — Stripe test mode", entityType: "personal", country: "US", baseCurrency: "USD" }),
}));
vi.mock("@/server/db/repositories/subscriptions", () => ({ getSubscription: async () => app.subscription }));
vi.mock("@/server/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      app.rpcCalls.push({ name, args });
      if (name === "bind_stripe_customer" && !app.boundCustomer) app.boundCustomer = String(args.p_stripe_customer_id);
      return { data: name === "apply_stripe_subscription_event" ? "applied" : null, error: null };
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { stripe_customer_id: app.boundCustomer, deletion_locked_at: null }, error: null }) }) }),
    }),
  }),
}));

// ── Helpers over the REAL Stripe API ─────────────────────────────────────
const RUN = `t18-${Date.now()}`;
const createdCustomers: string[] = [];
let stripe: Stripe;

async function testCustomer(label: string): Promise<string> {
  const customer = await stripe.customers.create({ name: `Countorra test ${label}`, metadata: { countorra_test_run: RUN, organization_id: ORG } });
  createdCustomers.push(customer.id);
  return customer.id;
}

/** A subscription paid with Stripe's test card. `pm_card_visa` is a Stripe
 *  test token; no real card exists behind it. */
async function paidSubscription(customerId: string, priceId: string, card = "pm_card_visa", behavior: Stripe.SubscriptionCreateParams.PaymentBehavior = "error_if_incomplete") {
  const pm = await stripe.paymentMethods.attach(card, { customer: customerId });
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm.id } });
  return stripe.subscriptions.create({ customer: customerId, items: [{ price: priceId }], payment_behavior: behavior, metadata: { organization_id: ORG, countorra_test_run: RUN } });
}

/** The real event Stripe recorded for an object, polled because events are
 *  written asynchronously. */
async function eventFor(type: string, objectId: string, since: number): Promise<Stripe.Event> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const events = await stripe.events.list({ type, created: { gte: since - 5 }, limit: 50 });
    const found = events.data.find((e) => (e.data.object as { id?: string }).id === objectId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Stripe recorded no ${type} event for the test object in 20 seconds.`);
}

describe("the gate", () => {
  it("never enables on a live key, and names what is missing", () => {
    expect(stripeTestModeGate({ STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "w", STRIPE_PREMIUM_PRICE_ID: "p", STRIPE_BUSINESS_PRICE_ID: "b" })).toMatchObject({ enabled: false, live: true });
    expect(stripeTestModeGate({ STRIPE_SECRET_KEY: "rk_live_x" }).live).toBe(true);
    expect(stripeTestModeGate({}).missing).toEqual([...STRIPE_VARS]);
    expect(stripeTestModeGate({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "w", STRIPE_PREMIUM_PRICE_ID: "p", STRIPE_BUSINESS_PRICE_ID: "b" }).enabled).toBe(true);
  });

  it("treats present-but-unusable credentials as a failure, never a skip", () => {
    expect(stripeTestModeGate({}).partial).toBeNull();
    expect(stripeTestModeGate({ STRIPE_SECRET_KEY: "sk_test_x" }).partial).toMatch(/missing STRIPE_WEBHOOK_SECRET, STRIPE_PREMIUM_PRICE_ID, STRIPE_BUSINESS_PRICE_ID/);
    expect(stripeTestModeGate({ STRIPE_SECRET_KEY: "rk_test_x", STRIPE_WEBHOOK_SECRET: "w", STRIPE_PREMIUM_PRICE_ID: "p", STRIPE_BUSINESS_PRICE_ID: "b" }).partial).toMatch(/not a secret TEST key/);
    expect(stripeTestModeGate({ STRIPE_PREMIUM_PRICE_ID: "p" }).partial).toMatch(/partly configured/);
  });

  it("reports this run's configuration status (names only)", () => {
    // Informational: a skipped block below is BLOCKED, not passed.
    console.info(`[stripe-test-mode] ${gate.enabled ? "ENABLED (sk_test_)" : `BLOCKED — missing: ${gate.missing.join(", ") || "a sk_test_ key"}`}`);
    expect(gate.live).toBe(false);
  });
});

describe.skipIf(!gate.enabled)("REAL Stripe TEST MODE", () => {
  let config: NonNullable<ReturnType<typeof import("@/server/billing/stripe-config").stripeConfig>>;

  beforeAll(async () => {
    const { stripeConfig } = await import("@/server/billing/stripe-config");
    const { stripeClient } = await import("@/server/billing/stripe-client");
    const c = stripeConfig();
    const s = stripeClient();
    if (!c || !s) throw new Error("Stripe did not configure from the environment.");
    expect(c.testMode).toBe(true);
    config = c;
    stripe = s;
  });

  afterAll(async () => {
    for (const id of createdCustomers) {
      try {
        await stripe.customers.del(id);
      } catch {
        // Already deleted.
      }
    }
  });

  describe("pricing matches the canonical plans exactly", () => {
    it.each([
      ["premium", 1_900],
      ["business", 4_900],
    ] as const)("%s is a live, recurring, monthly USD price of the canonical amount", async (plan, amount) => {
      const { PLAN_ENTITLEMENTS } = await import("@/domain/billing/entitlements");
      expect(PLAN_ENTITLEMENTS[plan].priceMinorMonthly).toBe(amount);

      const price = await stripe.prices.retrieve(config.priceIds[plan]);
      expect(price.livemode).toBe(false);
      expect(price.active).toBe(true);
      expect(price.type).toBe("recurring");
      expect(price.currency).toBe("usd");
      expect(price.unit_amount).toBe(amount);
      expect(price.recurring?.interval).toBe("month");
      expect(price.recurring?.interval_count).toBe(1);
      expect(price.recurring?.usage_type).toBe("licensed");
    });

    it("maps each configured price back to exactly its plan, and nothing else", async () => {
      const { planForPriceId } = await import("@/server/billing/stripe-config");
      expect(planForPriceId(config.priceIds.premium)).toBe("premium");
      expect(planForPriceId(config.priceIds.business)).toBe("business");
      expect(config.priceIds.premium).not.toBe(config.priceIds.business);
    });
  });

  describe("Checkout through Countorra's Server Action", () => {
    it.each(["premium", "business"] as const)("creates a %s session with the SERVER's price, ignoring a smuggled one", async (plan) => {
      const { createCheckoutSession } = await import("@/server/billing/actions");
      app.subscription = { planId: "free", status: "active", stripeCustomerId: null };
      app.boundCustomer = null;

      const result = await createCheckoutSession({ organizationId: ORG, plan, price: config.priceIds.premium === config.priceIds[plan] ? config.priceIds.business : config.priceIds.premium } as never);
      expect(result.error).toBeUndefined();
      expect(result.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);

      const customerId = app.boundCustomer!;
      createdCustomers.push(customerId);
      const sessions = await stripe.checkout.sessions.list({ customer: customerId, limit: 1 });
      const session = sessions.data[0];
      const items = await stripe.checkout.sessions.listLineItems(session.id);
      expect(items.data.map((i) => i.price?.id)).toEqual([config.priceIds[plan]]);
      expect(session.mode).toBe("subscription");
      expect(session.client_reference_id).toBe(ORG);
      expect(session.metadata?.organization_id).toBe(ORG);

      // Opening Checkout grants nothing: unpaid, and no subscription exists.
      expect(session.payment_status).toBe("unpaid");
      expect((await stripe.subscriptions.list({ customer: customerId, status: "all" })).data).toEqual([]);
      expect(app.rpcCalls.some((c) => c.name === "apply_stripe_subscription_event")).toBe(false);

      await stripe.checkout.sessions.expire(session.id);
    });

    it("refuses an organization the caller does not belong to, before reaching Stripe", async () => {
      const { createCheckoutSession } = await import("@/server/billing/actions");
      const before = createdCustomers.length;
      await expect(createCheckoutSession({ organizationId: OTHER_ORG, plan: "premium" })).rejects.toThrow(/NEXT_REDIRECT/);
      expect(createdCustomers.length).toBe(before);
    });
  });

  describe("payment → subscription → signed webhook → local state → entitlements", () => {
    let customerId: string;
    let subscription: Stripe.Subscription;

    beforeAll(async () => {
      customerId = await testCustomer("paid");
      const since = Math.floor(Date.now() / 1000);
      subscription = await paidSubscription(customerId, config.priceIds.premium);
      (globalThis as { __since?: number }).__since = since;
    });

    it("the test payment succeeds and Stripe reports an active Premium subscription", async () => {
      expect(subscription.status).toBe("active");
      expect(subscription.items.data[0].price.id).toBe(config.priceIds.premium);
      const invoices = await stripe.invoices.list({ subscription: subscription.id, limit: 1 });
      expect(invoices.data[0].status).toBe("paid");
    });

    it("Stripe's own event, signed with the real webhook secret, reaches the handler and maps to Premium", async () => {
      const { POST } = await import("@/app/api/stripe/webhook/route");
      const { entitlementsFor } = await import("@/domain/billing/entitlements");
      const event = await eventFor("customer.subscription.created", subscription.id, (globalThis as { __since?: number }).__since!);
      const payload = JSON.stringify(event);
      app.rpcCalls = [];

      const response = await POST(
        new Request("http://localhost/api/stripe/webhook", {
          method: "POST",
          body: payload,
          headers: { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret: config.webhookSecret }) },
        }),
      );
      expect(response.status).toBe(200);

      const call = app.rpcCalls.find((c) => c.name === "apply_stripe_subscription_event")!;
      expect(call.args).toMatchObject({
        p_event_id: event.id,
        p_organization_id: ORG,
        p_stripe_customer_id: customerId,
        p_stripe_subscription_id: subscription.id,
        p_stripe_price_id: config.priceIds.premium,
        p_plan_id: "premium",
        p_status: "active",
      });
      const granted = entitlementsFor({ planId: "premium", status: "active" });
      expect(granted).toMatchObject({ tier: "premium", aiMessagesPerDay: 100, maxOrganizations: 3, bankConnections: true, prioritySupport: false });
    });

    it("rejects the same real event with a modified body, or signed with a different secret", async () => {
      const { POST } = await import("@/app/api/stripe/webhook/route");
      const event = await eventFor("customer.subscription.created", subscription.id, (globalThis as { __since?: number }).__since!);
      const payload = JSON.stringify(event);
      const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: config.webhookSecret });
      const tampered = payload.replace(ORG, OTHER_ORG);

      const post = (body: string, sig: string) => POST(new Request("http://localhost/api/stripe/webhook", { method: "POST", body, headers: { "stripe-signature": sig } }));
      expect((await post(tampered, signature)).status).toBe(400);
      expect((await post(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_not_the_real_one" }))).status).toBe(400);
      expect((await post("{not json", signature)).status).toBe(400);
    });

    it("Premium → Business: Stripe reflects it and the webhook maps it to Business", async () => {
      const { POST } = await import("@/app/api/stripe/webhook/route");
      const since = Math.floor(Date.now() / 1000);
      const updated = await stripe.subscriptions.update(subscription.id, {
        items: [{ id: subscription.items.data[0].id, price: config.priceIds.business }],
        proration_behavior: "none",
      });
      expect(updated.items.data[0].price.id).toBe(config.priceIds.business);

      const event = await eventFor("customer.subscription.updated", subscription.id, since);
      const payload = JSON.stringify(event);
      app.rpcCalls = [];
      await POST(new Request("http://localhost/api/stripe/webhook", { method: "POST", body: payload, headers: { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret: config.webhookSecret }) } }));
      expect(app.rpcCalls.find((c) => c.name === "apply_stripe_subscription_event")?.args).toMatchObject({ p_plan_id: "business", p_stripe_customer_id: customerId });

      // And back, which the portal also allows.
      const back = await stripe.subscriptions.update(subscription.id, { items: [{ id: updated.items.data[0].id, price: config.priceIds.premium }], proration_behavior: "none" });
      expect(back.items.data[0].price.id).toBe(config.priceIds.premium);
    });

    it("cancellation: Stripe reports it, the webhook maps it, and paid entitlements are gone", async () => {
      const { POST } = await import("@/app/api/stripe/webhook/route");
      const { entitlementsFor } = await import("@/domain/billing/entitlements");
      const since = Math.floor(Date.now() / 1000);
      const canceled = await stripe.subscriptions.cancel(subscription.id);
      expect(canceled.status).toBe("canceled");

      const event = await eventFor("customer.subscription.deleted", subscription.id, since);
      const payload = JSON.stringify(event);
      app.rpcCalls = [];
      await POST(new Request("http://localhost/api/stripe/webhook", { method: "POST", body: payload, headers: { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret: config.webhookSecret }) } }));
      const args = app.rpcCalls.find((c) => c.name === "apply_stripe_subscription_event")!.args;
      expect(args.p_status).toBe("canceled");
      expect(entitlementsFor({ planId: args.p_plan_id as "premium", status: "canceled" }).tier).toBe("free");
    });
  });

  describe("failed payment", () => {
    it("a declining test card leaves the subscription unpaid, and it maps to no paid access", async () => {
      const { toLocalSubscriptionStatus } = await import("@/domain/billing/stripe-subscription");
      const { entitlementsFor } = await import("@/domain/billing/entitlements");
      const customerId = await testCustomer("declined");
      // `pm_card_chargeCustomerFail` attaches, then every charge is declined.
      const subscription = await paidSubscription(customerId, config.priceIds.premium, "pm_card_chargeCustomerFail", "allow_incomplete");

      expect(subscription.status).toBe("incomplete");
      const local = toLocalSubscriptionStatus(subscription.status);
      expect(entitlementsFor({ planId: "premium", status: local }).tier).toBe("free");
    });
  });

  describe("Customer Portal", () => {
    it("is configured in test mode, and a session opens for the organization's own customer", async () => {
      const configurations = await stripe.billingPortal.configurations.list({ active: true, limit: 1 });
      expect(configurations.data.length).toBeGreaterThan(0);

      const { createBillingPortalSession } = await import("@/server/billing/actions");
      const customerId = await testCustomer("portal");
      app.subscription = { planId: "premium", status: "active", stripeCustomerId: customerId };
      const result = await createBillingPortalSession({ organizationId: ORG, customer: "cus_someone_else" } as never);
      expect(result.error).toBeUndefined();
      expect(result.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    });

    it("refuses another organization's portal", async () => {
      const { createBillingPortalSession } = await import("@/server/billing/actions");
      await expect(createBillingPortalSession({ organizationId: OTHER_ORG })).rejects.toThrow(/NEXT_REDIRECT/);
    });
  });

  describe("deletion → Stripe cancellation (Task 17 primitive, against real Stripe)", () => {
    class MemoryStore {
      locks = new Map<string, string>();
      links = new Map<string, { stripeCustomerId: string | null; stripeSubscriptionId: string | null }>();
      recorded: { subscriptionId: string; status: string }[] = [];
      async acquire(org: string, attempt: string) {
        const holder = this.locks.get(org);
        if (holder && holder !== attempt) return false;
        this.locks.set(org, attempt);
        return true;
      }
      async release(org: string, attempt: string) {
        if (this.locks.get(org) === attempt) this.locks.delete(org);
      }
      async read(org: string) {
        return this.links.get(org) ?? null;
      }
      async recordTerminal(_org: string, subscriptionId: string, status: string) {
        this.recorded.push({ subscriptionId, status });
      }
    }

    it("cancels an active subscription, Stripe confirms it, and a repeat cancels nothing", async () => {
      const { secureBillingForDeletion, stripeBillingGateway } = await import("@/server/billing/deletion-safety");
      const customerId = await testCustomer("deletion");
      const subscription = await paidSubscription(customerId, config.priceIds.premium);
      expect(subscription.status).toBe("active");
      const openSession = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: config.priceIds.business, quantity: 1 }],
        success_url: "http://localhost:3000/ok",
        cancel_url: "http://localhost:3000/no",
      });

      const store = new MemoryStore();
      store.links.set(ORG, { stripeCustomerId: customerId, stripeSubscriptionId: subscription.id });
      const deps = { store, gateway: stripeBillingGateway(stripe) };

      const first = await secureBillingForDeletion(deps, [ORG]);
      expect(first).toMatchObject({ ok: true, canceled: 1 });
      expect((await stripe.subscriptions.retrieve(subscription.id)).status).toBe("canceled");
      expect((await stripe.checkout.sessions.retrieve(openSession.id)).status).toBe("expired");
      expect(store.recorded).toEqual([{ subscriptionId: subscription.id, status: "canceled" }]);
      if (first.ok) await first.release();

      const second = await secureBillingForDeletion(deps, [ORG]);
      expect(second).toMatchObject({ ok: true, canceled: 0 });
    });

    it("refuses when it cannot establish cancellation: a subscription id this account has never seen", async () => {
      const { secureBillingForDeletion, stripeBillingGateway } = await import("@/server/billing/deletion-safety");
      const store = new MemoryStore();
      store.links.set(ORG, { stripeCustomerId: null, stripeSubscriptionId: "sub_does_not_exist_in_this_account" });
      const result = await secureBillingForDeletion({ store, gateway: stripeBillingGateway(stripe) }, [ORG]);
      expect(result).toMatchObject({ ok: false, reason: "not_verified" });
      expect(store.locks.size).toBe(0);
    });

    it("never touches another customer's subscription", async () => {
      const { secureBillingForDeletion, stripeBillingGateway } = await import("@/server/billing/deletion-safety");
      const mine = await testCustomer("deletion-mine");
      const theirs = await testCustomer("deletion-theirs");
      const theirSubscription = await paidSubscription(theirs, config.priceIds.premium);

      const store = new MemoryStore();
      store.links.set(ORG, { stripeCustomerId: mine, stripeSubscriptionId: null });
      expect(await secureBillingForDeletion({ store, gateway: stripeBillingGateway(stripe) }, [ORG])).toMatchObject({ ok: true, canceled: 0 });
      expect((await stripe.subscriptions.retrieve(theirSubscription.id)).status).toBe("active");
    });
  });
});
