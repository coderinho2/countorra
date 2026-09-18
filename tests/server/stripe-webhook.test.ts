import { beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

/**
 * The webhook endpoint, exercised through real Stripe signature verification.
 *
 * `generateTestHeaderString` produces a genuine HMAC over the exact body, so
 * these are not "does the code call a function" tests — a signature made with
 * the wrong secret, over a different body, or outside the tolerance window is
 * rejected by Stripe's own verifier, exactly as it would be in production.
 *
 * WHAT THE STATUS CODES MEAN
 *
 * Stripe retries any non-2xx for days, so the codes are a contract:
 *   400 — not from Stripe. Never retry.
 *   503 — real event, we could not handle it. Retry.
 *   200 — handled, ignored, or duplicate. Done.
 * Getting these backwards produces either an infinite retry loop or a
 * silently dropped upgrade, so each one is asserted.
 */

const WEBHOOK_SECRET = "whsec_test_secret_for_signature_verification";
const PREMIUM_PRICE = "price_premium_configured";
const ORG = "11111111-1111-4111-8111-111111111111";

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    configured: true,
    /** Every RPC call the route made, so ordering and arguments are visible. */
    rpcCalls: [] as Record<string, unknown>[],
    rpcOutcome: "applied",
    rpcError: null as { message: string } | null,
    /** Subscriptions the fake Stripe will return, by id. */
    subscriptions: {} as Record<string, unknown>,
    retrieveCalls: [] as string[],
    retrieveThrows: false,
  };
});

vi.mock("@/lib/observability", () => ({ reportError: () => {}, reportEvent: () => {} }));

vi.mock("@/server/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (_name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push(args);
      if (state.rpcError) return { data: null, error: state.rpcError };
      return { data: state.rpcOutcome, error: null };
    },
  }),
}));

vi.mock("@/server/billing/stripe-config", () => ({
  stripeConfig: () => (state.configured ? { secretKey: "sk_test_x", webhookSecret: WEBHOOK_SECRET, priceIds: { premium: PREMIUM_PRICE }, testMode: true } : null),
  isBillingConfigured: () => state.configured,
  planForPriceId: (priceId: string | null) => (priceId === PREMIUM_PRICE ? "premium" : null),
  priceIdForPlan: () => PREMIUM_PRICE,
}));

/**
 * A REAL Stripe instance for signature verification, with only the network
 * calls replaced. Verification is the thing under test, so it must not be
 * stubbed; `subscriptions.retrieve` is a network call and must be.
 */
vi.mock("@/server/billing/stripe-client", async () => {
  const StripeCtor = (await import("stripe")).default;
  return {
    stripeClient: () => {
      if (!state.configured) return null;
      const stripe = new StripeCtor("sk_test_fake", { apiVersion: "2026-08-26.dahlia" });

      // Only the NETWORK call is replaced. Signature verification is the
      // thing under test and stays completely real. Cast through `unknown`
      // because the fixture is the subset of `Subscription` the route reads,
      // not all 46 fields of it.
      (stripe as unknown as { subscriptions: { retrieve: (id: string) => Promise<unknown> } }).subscriptions = {
        retrieve: async (id: string) => {
          state.retrieveCalls.push(id);
          if (state.retrieveThrows) throw new Error("Stripe unreachable");
          return state.subscriptions[id] ?? subscriptionFixture({ id });
        },
      };
      return stripe;
    },
  };
});

const { POST } = await import("@/app/api/stripe/webhook/route");

/** A Stripe Subscription shaped the way the route reads it. */
function subscriptionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_test_1",
    status: "active",
    customer: "cus_test_1",
    cancel_at_period_end: false,
    canceled_at: null,
    metadata: { organization_id: ORG },
    items: {
      data: [
        {
          price: { id: PREMIUM_PRICE },
          current_period_start: 1_790_000_000,
          current_period_end: 1_792_000_000,
        },
      ],
    },
    ...overrides,
  };
}

function buildEvent(type: string, object: unknown, id = "evt_test_1", created = 1_790_000_100) {
  return { id, object: "event", api_version: "2026-08-26.dahlia", created, type, data: { object }, livemode: false };
}

/** Signs the body the way Stripe does, so verification is genuinely exercised. */
function post(body: unknown, options: { secret?: string; signature?: string | null; rawBody?: string } = {}) {
  const payload = options.rawBody ?? JSON.stringify(body);
  const signature =
    options.signature === null
      ? null
      : (options.signature ??
        Stripe.webhooks.generateTestHeaderString({ payload, secret: options.secret ?? WEBHOOK_SECRET }));

  const headers = new Headers({ "content-type": "application/json" });
  if (signature) headers.set("stripe-signature", signature);

  return POST(new Request("https://app.example.test/api/stripe/webhook", { method: "POST", headers, body: payload }));
}

beforeEach(() => {
  state.configured = true;
  state.rpcCalls = [];
  state.rpcOutcome = "applied";
  state.rpcError = null;
  state.subscriptions = {};
  state.retrieveCalls = [];
  state.retrieveThrows = false;
});

describe("signature verification", () => {
  it("accepts a correctly signed event", async () => {
    const response = await post(buildEvent("customer.subscription.updated", subscriptionFixture()));
    expect(response.status).toBe(200);
    expect(state.rpcCalls).toHaveLength(1);
  });

  it("rejects a request with no signature header", async () => {
    const response = await post(buildEvent("customer.subscription.updated", subscriptionFixture()), { signature: null });

    expect(response.status).toBe(400);
    expect(state.rpcCalls).toEqual([]);
  });

  it("rejects a signature made with a different secret", async () => {
    // The unsigned-JSON attack: anyone can POST a subscription object claiming
    // Business. Without verification this endpoint IS the upgrade button.
    const response = await post(buildEvent("customer.subscription.updated", subscriptionFixture()), { secret: "whsec_attacker_secret" });

    expect(response.status).toBe(400);
    expect(state.rpcCalls).toEqual([]);
  });

  it.each(["", "t=1,v1=deadbeef", "garbage", "v1=", "t=abc,v1=abc"])("rejects the malformed signature %s", async (signature) => {
    const response = await post(buildEvent("customer.subscription.updated", subscriptionFixture()), { signature });
    expect(response.status).toBe(400);
    expect(state.rpcCalls).toEqual([]);
  });

  it("rejects a valid signature over a DIFFERENT body", async () => {
    // Proves the raw bytes are what is verified. If the route parsed and
    // re-serialised the body first, a swapped payload would still verify.
    const signed = JSON.stringify(buildEvent("customer.subscription.updated", subscriptionFixture()));
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: signed, secret: WEBHOOK_SECRET });

    const tampered = JSON.stringify(buildEvent("customer.subscription.updated", subscriptionFixture({ status: "active", customer: "cus_attacker" })));
    const response = await post(null, { signature, rawBody: tampered });

    expect(response.status).toBe(400);
    expect(state.rpcCalls).toEqual([]);
  });

  it("rejects a replayed signature outside Stripe's tolerance window", async () => {
    const payload = JSON.stringify(buildEvent("customer.subscription.updated", subscriptionFixture()));
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 60 * 60,
    });

    const response = await post(null, { signature, rawBody: payload });
    expect(response.status).toBe(400);
  });

  it("never echoes the attacker-controlled body back", async () => {
    const response = await post(buildEvent("customer.subscription.updated", subscriptionFixture()), { secret: "whsec_wrong" });
    const text = await response.text();

    expect(text).not.toContain("cus_test_1");
    expect(text).not.toContain(PREMIUM_PRICE);
  });
});

describe("what reaches the database", () => {
  it("passes the SERVER's plan, resolved from the price id", async () => {
    await post(buildEvent("customer.subscription.updated", subscriptionFixture()));

    expect(state.rpcCalls[0].p_plan_id).toBe("premium");
    expect(state.rpcCalls[0].p_stripe_price_id).toBe(PREMIUM_PRICE);
  });

  it("re-reads the subscription from Stripe rather than trusting the event body", async () => {
    // The event payload is a snapshot that may be out of date by the time it
    // arrives. Re-reading is what makes out-of-order delivery survivable.
    state.subscriptions["sub_test_1"] = subscriptionFixture({ status: "canceled" });
    await post(buildEvent("customer.subscription.updated", subscriptionFixture({ status: "active" })));

    expect(state.retrieveCalls).toEqual(["sub_test_1"]);
    expect(state.rpcCalls[0].p_status).toBe("canceled");
  });

  it("maps the Stripe status through the canonical mapping", async () => {
    state.subscriptions["sub_test_1"] = subscriptionFixture({ status: "past_due" });
    await post(buildEvent("customer.subscription.updated", subscriptionFixture()));
    expect(state.rpcCalls[0].p_status).toBe("past_due");
  });

  it("passes the event id and created time, which drive idempotency and ordering", async () => {
    await post(buildEvent("customer.subscription.updated", subscriptionFixture(), "evt_specific", 1_790_000_500));

    expect(state.rpcCalls[0].p_event_id).toBe("evt_specific");
    expect(state.rpcCalls[0].p_event_created).toBe(new Date(1_790_000_500 * 1000).toISOString());
  });

  it("carries the organization id from subscription metadata", async () => {
    await post(buildEvent("customer.subscription.updated", subscriptionFixture()));
    expect(state.rpcCalls[0].p_organization_id).toBe(ORG);
  });

  it("passes cancellation state through", async () => {
    state.subscriptions["sub_test_1"] = subscriptionFixture({ cancel_at_period_end: true, canceled_at: 1_791_000_000 });
    await post(buildEvent("customer.subscription.updated", subscriptionFixture()));

    expect(state.rpcCalls[0].p_cancel_at_period_end).toBe(true);
    expect(state.rpcCalls[0].p_canceled_at).toBe(new Date(1_791_000_000 * 1000).toISOString());
  });
});

describe("event routing", () => {
  it.each([
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ])("handles %s", async (type) => {
    const response = await post(buildEvent(type, subscriptionFixture()));
    expect(response.status).toBe(200);
    expect(state.rpcCalls).toHaveLength(1);
  });

  it("handles checkout.session.completed in subscription mode", async () => {
    const response = await post(
      buildEvent("checkout.session.completed", { id: "cs_1", mode: "subscription", subscription: "sub_test_1", client_reference_id: ORG }),
    );

    expect(response.status).toBe(200);
    expect(state.retrieveCalls).toEqual(["sub_test_1"]);
  });

  it("ignores a checkout session that is not a subscription", async () => {
    // A one-off payment carries no subscription; treating it as one would
    // upgrade nobody and error loudly.
    const response = await post(buildEvent("checkout.session.completed", { id: "cs_2", mode: "payment", subscription: null }));

    expect(response.status).toBe(200);
    expect(state.rpcCalls).toEqual([]);
  });

  it("handles invoice.payment_failed, which is how access is lost", async () => {
    const response = await post(buildEvent("invoice.payment_failed", { id: "in_1", subscription: "sub_test_1", lines: { data: [] } }));

    expect(response.status).toBe(200);
    expect(state.rpcCalls).toHaveLength(1);
  });

  it("finds the subscription on an invoice line when the top-level field is absent", async () => {
    // Where Stripe moved it in recent API versions.
    const response = await post(
      buildEvent("invoice.paid", {
        id: "in_2",
        lines: { data: [{ parent: { subscription_item_details: { subscription: "sub_test_1" } } }] },
      }),
    );

    expect(response.status).toBe(200);
    expect(state.retrieveCalls).toEqual(["sub_test_1"]);
  });

  it("acknowledges an unhandled event type without retrying it forever", async () => {
    const response = await post(buildEvent("customer.created", { id: "cus_x" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ handled: false });
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("events that change nothing", () => {
  it("acknowledges an unknown price without guessing a tier", async () => {
    // Another product in the same Stripe account, or a subscription made by
    // hand in the dashboard. Guessing is how someone lands on Business for $1.
    state.subscriptions["sub_test_1"] = subscriptionFixture({
      items: { data: [{ price: { id: "price_from_another_product" }, current_period_start: 1, current_period_end: 2 }] },
    });

    const response = await post(buildEvent("customer.subscription.updated", subscriptionFixture()));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "unknown_price" });
    expect(state.rpcCalls).toEqual([]);
  });

  it("reports the database's own outcome without changing the status code", async () => {
    for (const outcome of ["duplicate", "stale", "unknown_customer"]) {
      state.rpcCalls = [];
      state.rpcOutcome = outcome;
      const response = await post(buildEvent("customer.subscription.updated", subscriptionFixture()));

      expect(response.status, outcome).toBe(200);
      expect(await response.json()).toMatchObject({ outcome });
    }
  });
});

describe("failures ask to be retried, rather than swallowing the event", () => {
  it("returns 503 when the database call fails", async () => {
    state.rpcError = { message: "connection reset" };
    const response = await post(buildEvent("customer.subscription.updated", subscriptionFixture()));

    // NOT 200: the event is real and unprocessed, so Stripe must send it again.
    expect(response.status).toBe(503);
  });

  it("returns 503 when Stripe itself is unreachable on the follow-up read", async () => {
    state.retrieveThrows = true;
    const response = await post(buildEvent("customer.subscription.updated", subscriptionFixture()));
    expect(response.status).toBe(503);
  });

  it("returns 503 when billing is not configured, so real events are not lost", async () => {
    // 400 here would tell Stripe to give up on a genuine event.
    state.configured = false;
    const response = await post(buildEvent("customer.subscription.updated", subscriptionFixture()));

    expect(response.status).toBe(503);
    expect(state.rpcCalls).toEqual([]);
  });

  it("never returns 2xx for a failure", async () => {
    state.rpcError = { message: "boom" };
    const response = await post(buildEvent("customer.subscription.created", subscriptionFixture()));
    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});
