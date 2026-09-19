import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import {
  isBillingTeardownLocked,
  isTerminalStripeStatus,
  secureBillingForDeletion,
  stripeBillingGateway,
  type BillingTeardownStore,
  type LocalBillingLink,
  type RemoteSubscription,
  type StripeBillingGateway,
} from "@/server/billing/deletion-safety";
import { __resetObservabilitySinksForTests, registerObservabilitySink, type ReportedError } from "@/lib/observability";

/**
 * The billing-safety primitive on its own (src/server/billing/deletion-safety.ts).
 *
 * tests/server/account-deletion.test.ts proves the account flow calls it first
 * and stops when it refuses. This file proves the primitive's own contract:
 * it succeeds only when Stripe itself reports nothing that can bill, it
 * serializes attempts, it is safe to repeat, and it never lets a provider's
 * words reach a log or a person.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_2 = "22222222-2222-4222-8222-222222222222";
const CUSTOMER = "cus_primitive";
const SUB = "sub_primitive";

// ── An in-memory store with the 0050 lock semantics ──────────────────────────

class MemoryStore implements BillingTeardownStore {
  locks = new Map<string, string>();
  links = new Map<string, LocalBillingLink>();
  recorded: { organizationId: string; subscriptionId: string; status: string; canceledAt: string }[] = [];
  failRead = false;

  async acquire(organizationId: string, attemptId: string) {
    const holder = this.locks.get(organizationId);
    if (holder && holder !== attemptId) return false;
    this.locks.set(organizationId, attemptId);
    return true;
  }
  async release(organizationId: string, attemptId: string) {
    if (this.locks.get(organizationId) === attemptId) this.locks.delete(organizationId);
  }
  async read(organizationId: string) {
    if (this.failRead) throw new Error("connection refused to db.internal:5432");
    return this.links.get(organizationId) ?? null;
  }
  async recordTerminal(organizationId: string, subscriptionId: string, status: string, canceledAt: string) {
    this.recorded.push({ organizationId, subscriptionId, status, canceledAt });
  }
}

// ── A fake Stripe account ────────────────────────────────────────────────────

class FakeStripe implements StripeBillingGateway {
  subscriptions = new Map<string, RemoteSubscription & { customer: string }>();
  sessions = new Map<string, { customer: string; open: boolean }>();
  calls: string[] = [];
  keys: string[] = [];
  cancelFails = 0;
  /** Cancels "succeed" but Stripe keeps reporting the subscription live. */
  cancelIsIgnored = false;
  /** Makes a new subscription appear on the customer the first time it is listed. */
  lateSubscription: string | null = null;

  add(id: string, status: string, customer = CUSTOMER) {
    this.subscriptions.set(id, { id, status, canceledAt: null, customer });
  }

  async listCustomerSubscriptions(customerId: string) {
    this.calls.push(`list:${customerId}`);
    if (this.lateSubscription) {
      this.add(this.lateSubscription, "active", customerId);
      this.lateSubscription = null;
    }
    return [...this.subscriptions.values()].filter((s) => s.customer === customerId).map((s) => ({ id: s.id, status: s.status, canceledAt: s.canceledAt }));
  }
  async retrieveSubscription(id: string) {
    this.calls.push(`retrieve:${id}`);
    const found = this.subscriptions.get(id);
    return found ? { id: found.id, status: found.status, canceledAt: found.canceledAt } : null;
  }
  async cancelSubscription(id: string, idempotencyKey: string) {
    this.calls.push(`cancel:${id}`);
    this.keys.push(idempotencyKey);
    if (this.cancelFails > 0) {
      this.cancelFails -= 1;
      throw Object.assign(new Error(`Something went wrong on subscription '${id}' (customer '${CUSTOMER}'), key sk_test_51Secret`), {
        type: "StripeAPIError",
        code: "api_error",
        statusCode: 500,
      });
    }
    const found = this.subscriptions.get(id)!;
    if (!this.cancelIsIgnored) {
      found.status = "canceled";
      found.canceledAt = 1_790_000_000;
    }
    return { id, status: found.status, canceledAt: found.canceledAt };
  }
  async listOpenCheckoutSessionIds(customerId: string) {
    this.calls.push(`sessions:${customerId}`);
    return [...this.sessions.entries()].filter(([, s]) => s.customer === customerId && s.open).map(([id]) => id);
  }
  async expireCheckoutSession(id: string, idempotencyKey: string) {
    this.calls.push(`expire:${id}`);
    this.keys.push(idempotencyKey);
    this.sessions.get(id)!.open = false;
  }
}

let store: MemoryStore;
let stripe: FakeStripe;
let records: ReportedError[];

beforeEach(() => {
  store = new MemoryStore();
  stripe = new FakeStripe();
  records = [];
  __resetObservabilitySinksForTests();
  registerObservabilitySink({ name: "test", capture: (record) => void records.push(record) });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  __resetObservabilitySinksForTests();
  vi.restoreAllMocks();
});

let attempt = 0;
const deps = (gateway: StripeBillingGateway | null = stripe) => ({ store, gateway, newAttemptId: () => `attempt-${++attempt}` });

function paid(status = "active") {
  store.links.set(ORG, { stripeCustomerId: CUSTOMER, stripeSubscriptionId: SUB });
  stripe.add(SUB, status);
}

describe("what counts as able to bill", () => {
  it("treats only canceled and incomplete_expired as terminal", () => {
    expect(isTerminalStripeStatus("canceled")).toBe(true);
    expect(isTerminalStripeStatus("incomplete_expired")).toBe(true);
    for (const status of ["active", "trialing", "past_due", "unpaid", "incomplete", "paused", "something_new"]) {
      expect(isTerminalStripeStatus(status)).toBe(false);
    }
  });
});

describe("success means Stripe reports nothing that can bill", () => {
  it("cancels, re-lists, records, and keeps the lock for the caller", async () => {
    paid();
    const result = await secureBillingForDeletion(deps(), [ORG]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canceled).toBe(1);
    expect(stripe.subscriptions.get(SUB)!.status).toBe("canceled");
    expect(stripe.calls.lastIndexOf(`list:${CUSTOMER}`)).toBeGreaterThan(stripe.calls.indexOf(`cancel:${SUB}`));
    expect(store.recorded).toEqual([{ organizationId: ORG, subscriptionId: SUB, status: "canceled", canceledAt: new Date(1_790_000_000 * 1000).toISOString() }]);
    expect(store.locks.has(ORG)).toBe(true);

    await result.release();
    expect(store.locks.has(ORG)).toBe(false);
  });

  it("cancels every live subscription on the customer, not only the one we recorded", async () => {
    paid();
    stripe.add("sub_second_never_webhooked", "trialing");
    stripe.add("sub_old", "canceled");

    const result = await secureBillingForDeletion(deps(), [ORG]);

    expect(result.ok && result.canceled).toBe(2);
    expect(stripe.calls.filter((c) => c.startsWith("cancel:")).sort()).toEqual(["cancel:sub_primitive", "cancel:sub_second_never_webhooked"]);
  });

  it("never touches another customer's subscriptions", async () => {
    paid();
    stripe.add("sub_neighbour", "active", "cus_neighbour");
    await secureBillingForDeletion(deps(), [ORG]);
    expect(stripe.subscriptions.get("sub_neighbour")!.status).toBe("active");
  });

  it("expires open Checkout sessions before it lists subscriptions", async () => {
    paid();
    stripe.sessions.set("cs_open", { customer: CUSTOMER, open: true });
    stripe.sessions.set("cs_neighbour", { customer: "cus_neighbour", open: true });

    const result = await secureBillingForDeletion(deps(), [ORG]);

    expect(result.ok).toBe(true);
    expect(stripe.sessions.get("cs_open")!.open).toBe(false);
    expect(stripe.sessions.get("cs_neighbour")!.open).toBe(true);
  });

  it("catches a subscription that appears between rounds", async () => {
    paid("canceled");
    stripe.lateSubscription = "sub_completed_checkout";
    const result = await secureBillingForDeletion(deps(), [ORG]);
    expect(result.ok).toBe(true);
    expect(stripe.subscriptions.get("sub_completed_checkout")!.status).toBe("canceled");
  });

  it("does nothing, and needs no Stripe, for a workspace that never reached Checkout", async () => {
    store.links.set(ORG, { stripeCustomerId: null, stripeSubscriptionId: null });
    expect((await secureBillingForDeletion(deps(null), [ORG])).ok).toBe(true);
    expect((await secureBillingForDeletion(deps(stripe), [ORG_2])).ok).toBe(true);
    expect(stripe.calls).toEqual([]);
  });

  it("is harmless to repeat: a second run cancels nothing", async () => {
    paid();
    const first = await secureBillingForDeletion(deps(), [ORG]);
    if (first.ok) await first.release();
    const second = await secureBillingForDeletion(deps(), [ORG]);

    expect(second.ok && second.canceled).toBe(0);
    expect(stripe.calls.filter((c) => c.startsWith("cancel:"))).toHaveLength(1);
  });

  it("treats a subscription canceled elsewhere mid-flight as success", async () => {
    paid();
    stripe.cancelFails = 1;
    // Someone cancels in the portal while our request is failing.
    const original = stripe.cancelSubscription.bind(stripe);
    stripe.cancelSubscription = async (id, key) => {
      stripe.subscriptions.get(id)!.status = "canceled";
      return original(id, key);
    };
    expect((await secureBillingForDeletion(deps(), [ORG])).ok).toBe(true);
  });
});

describe("anything short of that is a refusal, with every lock released", () => {
  it("refuses when Stripe fails to cancel", async () => {
    paid();
    stripe.cancelFails = 5;
    const result = await secureBillingForDeletion(deps(), [ORG]);

    expect(result).toMatchObject({ ok: false, reason: "provider_error" });
    expect(store.locks.size).toBe(0);
    expect(store.recorded).toEqual([]);
  });

  it("refuses when Stripe keeps reporting the subscription live after every round", async () => {
    paid();
    stripe.cancelIsIgnored = true;
    const result = await secureBillingForDeletion(deps(), [ORG]);

    expect(result).toMatchObject({ ok: false, reason: "not_verified" });
    expect(stripe.calls.filter((c) => c.startsWith("cancel:")).length).toBe(3);
  });

  it("refuses when a customer exists and Stripe is not configured", async () => {
    paid();
    expect(await secureBillingForDeletion(deps(null), [ORG])).toMatchObject({ ok: false, reason: "billing_unavailable" });
  });

  it("refuses when Stripe has never heard of the subscription we recorded", async () => {
    store.links.set(ORG, { stripeCustomerId: CUSTOMER, stripeSubscriptionId: "sub_other_mode" });
    expect(await secureBillingForDeletion(deps(), [ORG])).toMatchObject({ ok: false, reason: "not_verified" });
  });

  it("refuses when our own database cannot be read", async () => {
    paid();
    store.failRead = true;
    expect(await secureBillingForDeletion(deps(), [ORG])).toMatchObject({ ok: false, reason: "store_error" });
    expect(stripe.calls).toEqual([]);
  });

  it("refuses the whole set when any one workspace fails, releasing all of them", async () => {
    store.links.set(ORG_2, { stripeCustomerId: "cus_2", stripeSubscriptionId: "sub_2" });
    stripe.add("sub_2", "active", "cus_2");
    paid();
    stripe.cancelFails = 99;

    const result = await secureBillingForDeletion(deps(), [ORG_2, ORG]);

    expect(result.ok).toBe(false);
    expect(store.locks.size).toBe(0);
  });
});

describe("attempts are serialized and keyed", () => {
  it("refuses a concurrent attempt on the same workspace, touching nothing", async () => {
    paid();
    store.locks.set(ORG, "someone-else");
    const result = await secureBillingForDeletion(deps(), [ORG]);

    expect(result).toMatchObject({ ok: false, reason: "in_progress" });
    expect(stripe.calls).toEqual([]);
    expect(store.locks.get(ORG)).toBe("someone-else");
  });

  it("lets exactly one of two simultaneous attempts through", async () => {
    paid();
    const [a, b] = await Promise.all([secureBillingForDeletion(deps(), [ORG]), secureBillingForDeletion(deps(), [ORG])]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(stripe.calls.filter((c) => c.startsWith("cancel:"))).toHaveLength(1);
  });

  it("scopes every idempotency key to the workspace, the attempt and the object", async () => {
    paid();
    stripe.sessions.set("cs_open", { customer: CUSTOMER, open: true });
    await secureBillingForDeletion({ store, gateway: stripe, newAttemptId: () => "attempt-fixed" }, [ORG]);

    expect(stripe.keys).toContain(`countorra:delete-org:${ORG}:attempt-fixed:cancel:${SUB}`);
    expect(stripe.keys).toContain(`countorra:delete-org:${ORG}:attempt-fixed:expire:cs_open`);
    for (const key of stripe.keys) expect(key.length).toBeLessThanOrEqual(255);
  });

  it("uses a fresh key on a retry, so a replayed 5xx cannot block it for a day", async () => {
    paid();
    stripe.cancelFails = 1;
    await secureBillingForDeletion(deps(), [ORG]);
    await secureBillingForDeletion(deps(), [ORG]);
    expect(new Set(stripe.keys).size).toBe(2);
  });
});

describe("nothing a provider says reaches a person or a log", () => {
  it("returns a fixed message and logs only the error's type and code", async () => {
    paid();
    stripe.cancelFails = 5;
    const result = await secureBillingForDeletion(deps(), [ORG]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toMatch(/sub_|cus_|sk_|Stripe|api_error|went wrong/);

    const serialized = JSON.stringify(records);
    expect(serialized).toContain("billing.deletion_blocked");
    expect(serialized).toContain("api_error");
    expect(serialized).not.toMatch(/sub_primitive|cus_primitive|sk_test|went wrong/);
  });
});

describe("the teardown lock as Checkout sees it", () => {
  it("is locked for 15 minutes, then lapses", () => {
    const now = Date.parse("2026-09-18T12:00:00Z");
    expect(isBillingTeardownLocked(null, now)).toBe(false);
    expect(isBillingTeardownLocked("2026-09-18T11:50:00Z", now)).toBe(true);
    expect(isBillingTeardownLocked("2026-09-18T11:44:00Z", now)).toBe(false);
    expect(isBillingTeardownLocked("not a date", now)).toBe(false);
  });
});

/**
 * The adapter over the real SDK client. A Stripe-shaped fake records exactly
 * what would be sent — no network.
 */
describe("the Stripe adapter sends what the design says", () => {
  function fakeSdk() {
    const sent: { method: string; args: unknown[] }[] = [];
    const list = (items: unknown[]) => ({
      async *[Symbol.asyncIterator]() {
        for (const item of items) yield item;
      },
    });
    const sdk = {
      subscriptions: {
        list: (...args: unknown[]) => {
          sent.push({ method: "subscriptions.list", args });
          return list([{ id: "sub_a", status: "active", canceled_at: null }]);
        },
        retrieve: async (id: string) => {
          sent.push({ method: "subscriptions.retrieve", args: [id] });
          if (id === "sub_missing") throw Object.assign(new Error("No such subscription"), { code: "resource_missing", statusCode: 404 });
          if (id === "sub_boom") throw Object.assign(new Error("boom"), { statusCode: 500 });
          return { id, status: "canceled", canceled_at: 5 };
        },
        cancel: async (...args: unknown[]) => {
          sent.push({ method: "subscriptions.cancel", args });
          return { id: args[0], status: "canceled", canceled_at: 7 };
        },
      },
      checkout: {
        sessions: {
          list: (...args: unknown[]) => {
            sent.push({ method: "checkout.sessions.list", args });
            return list([{ id: "cs_1" }]);
          },
          expire: async (...args: unknown[]) => {
            sent.push({ method: "checkout.sessions.expire", args });
            return {};
          },
        },
      },
    };
    return { gateway: stripeBillingGateway(sdk as unknown as Stripe), sent };
  }

  it("lists every status, so a past_due or paused subscription is not missed", async () => {
    const { gateway, sent } = fakeSdk();
    expect(await gateway.listCustomerSubscriptions("cus_x")).toEqual([{ id: "sub_a", status: "active", canceledAt: null }]);
    expect(sent[0].args[0]).toEqual({ customer: "cus_x", status: "all", limit: 100 });
  });

  it("cancels immediately, with no proration or final invoice, under the given key", async () => {
    const { gateway, sent } = fakeSdk();
    await gateway.cancelSubscription("sub_a", "key-1");
    expect(sent[0].args).toEqual(["sub_a", { invoice_now: false, prorate: false }, { idempotencyKey: "key-1" }]);
  });

  it("lists only OPEN Checkout sessions for the customer and expires under a key", async () => {
    const { gateway, sent } = fakeSdk();
    expect(await gateway.listOpenCheckoutSessionIds("cus_x")).toEqual(["cs_1"]);
    await gateway.expireCheckoutSession("cs_1", "key-2");
    expect(sent[0].args[0]).toEqual({ customer: "cus_x", status: "open", limit: 100 });
    expect(sent[1].args).toEqual(["cs_1", {}, { idempotencyKey: "key-2" }]);
  });

  it("maps 'no such subscription' to null, and every other failure to a throw", async () => {
    const { gateway } = fakeSdk();
    expect(await gateway.retrieveSubscription("sub_missing")).toBeNull();
    await expect(gateway.retrieveSubscription("sub_boom")).rejects.toThrow();
    expect(await gateway.retrieveSubscription("sub_ok")).toEqual({ id: "sub_ok", status: "canceled", canceledAt: 5 });
  });
});
