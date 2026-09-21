import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";
import { entitlementsFor } from "@/domain/billing/entitlements";

/**
 * Webhook idempotency, ordering, and billing isolation — against real
 * Postgres, because every property here IS a database property.
 *
 * Stripe guarantees at-least-once delivery. The same event arrives again
 * after a timeout, a retry, or a dashboard redelivery, and two deliveries can
 * be in flight simultaneously. A mock cannot exhibit a unique-constraint race
 * or a transaction boundary, so none of this is tested with one.
 *
 * The unit under test is `apply_stripe_subscription_event`
 * (supabase/migrations/0035_stripe_billing.sql), which claims the event id and
 * applies the change in ONE transaction.
 */

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTSIDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const CUSTOMER = "cus_test_accountant";
const OTHER_CUSTOMER = "cus_test_someone_else";
const SUBSCRIPTION = "sub_test_123";

let db: TestDatabase;
let orgId: string;
let otherOrgId: string;

/** `2026-09-09T12:00:00Z` plus n minutes, for ordering assertions. */
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 9, 12, minutes, 0)).toISOString();

beforeEach(async () => {
  db = await createTestDatabase();

  await db.asAdmin((query) =>
    query(`insert into auth.users (id, email) values ($1, 'owner@example.test'), ($2, 'outsider@example.test')`, [OWNER, OUTSIDER]),
  );

  await db.asUser(OWNER);
  const org = await db.query(`insert into organizations (name, entity_type, created_by) values ('Acme', 'personal', $1) returning id`, [OWNER]);
  orgId = (org.rows[0] as { id: string }).id;

  await db.asUser(OUTSIDER);
  const other = await db.query(`insert into organizations (name, entity_type, created_by) values ('Other', 'personal', $1) returning id`, [OUTSIDER]);
  otherOrgId = (other.rows[0] as { id: string }).id;
});

afterEach(async () => {
  await db.close();
});

interface EventOptions {
  eventId?: string;
  type?: string;
  created?: string;
  organizationId?: string | null;
  customerId?: string | null;
  subscriptionId?: string | null;
  priceId?: string | null;
  plan?: "free" | "premium" | "business";
  status?: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: string | null;
}

/** Calls the RPC exactly as the webhook route does. */
async function applyEvent(options: EventOptions = {}): Promise<string> {
  return db.asAdmin(async (query) => {
    const result = await query(
      `select apply_stripe_subscription_event(
         $1, $2, $3::timestamptz, $4::uuid, $5, $6, $7, $8::plan_tier, $9::subscription_status,
         $10::timestamptz, $11::timestamptz, $12::boolean, $13::timestamptz
       ) as outcome`,
      [
        options.eventId ?? "evt_default",
        options.type ?? "customer.subscription.updated",
        options.created ?? at(10),
        options.organizationId === undefined ? orgId : options.organizationId,
        options.customerId === undefined ? CUSTOMER : options.customerId,
        options.subscriptionId === undefined ? SUBSCRIPTION : options.subscriptionId,
        options.priceId === undefined ? "price_premium" : options.priceId,
        options.plan ?? "premium",
        options.status ?? "active",
        options.periodStart ?? at(0),
        options.periodEnd ?? at(60),
        options.cancelAtPeriodEnd ?? false,
        options.canceledAt ?? null,
      ],
    );
    return (result.rows[0] as { outcome: string }).outcome;
  });
}

async function subscriptionRow(organizationId = orgId) {
  return db.asAdmin(async (query) => {
    const r = await query(`select * from subscriptions where organization_id = $1`, [organizationId]);
    return r.rows[0] as {
      plan_id: string;
      status: string;
      stripe_customer_id: string | null;
      stripe_price_id: string | null;
      external_provider: string | null;
      external_subscription_id: string | null;
      cancel_at_period_end: boolean;
      canceled_at: string | null;
      current_period_end: string | null;
      stripe_event_at: string | null;
    };
  });
}

const eventCount = () =>
  db.asAdmin(async (query) => {
    const r = await query(`select count(*)::int as n from stripe_webhook_events`);
    return (r.rows[0] as { n: number }).n;
  });

describe("a verified event synchronises the subscription", () => {
  it("moves a Free workspace onto Premium", async () => {
    expect(await applyEvent()).toBe("applied");

    const row = await subscriptionRow();
    expect(row.plan_id).toBe("premium");
    expect(row.status).toBe("active");
    expect(row.stripe_customer_id).toBe(CUSTOMER);
    expect(row.external_provider).toBe("stripe");
    expect(row.external_subscription_id).toBe(SUBSCRIPTION);
    expect(row.stripe_price_id).toBe("price_premium");
  });

  it("produces the entitlements the rest of the product enforces", async () => {
    // The whole architecture in one assertion: Stripe state → local row →
    // entitlementsFor → the limits every feature reads.
    await applyEvent({ plan: "business", status: "active" });
    const row = await subscriptionRow();

    const entitlements = entitlementsFor({ planId: row.plan_id as "business", status: row.status });
    expect(entitlements.tier).toBe("business");
    expect(entitlements.aiMessagesPerDay).toBe(500);
  });

  it("records the event for audit, with its outcome", async () => {
    await applyEvent({ eventId: "evt_audit" });

    const row = await db.asAdmin(async (query) => {
      const r = await query(`select * from stripe_webhook_events where id = 'evt_audit'`);
      return r.rows[0] as { type: string; outcome: string; organization_id: string };
    });

    expect(row.outcome).toBe("applied");
    expect(row.organization_id).toBe(orgId);
  });
});

describe("idempotency", () => {
  it("applies a duplicate delivery exactly once", async () => {
    expect(await applyEvent({ eventId: "evt_dupe" })).toBe("applied");
    expect(await applyEvent({ eventId: "evt_dupe" })).toBe("duplicate");
    expect(await applyEvent({ eventId: "evt_dupe" })).toBe("duplicate");

    expect(await eventCount()).toBe(1);
  });

  it("does not let a duplicate re-apply a superseded plan", async () => {
    // The dangerous shape: an upgrade, then a cancellation, then Stripe
    // redelivers the upgrade. Without the event claim, the customer is
    // silently re-upgraded.
    await applyEvent({ eventId: "evt_upgrade", created: at(10), plan: "business", status: "active" });
    await applyEvent({ eventId: "evt_cancel", created: at(20), plan: "business", status: "canceled" });

    expect(await applyEvent({ eventId: "evt_upgrade", created: at(10), plan: "business", status: "active" })).toBe("duplicate");
    expect((await subscriptionRow()).status).toBe("canceled");
  });

  it("survives CONCURRENT duplicate deliveries", async () => {
    // Two in-flight at once is the case a "check then insert" cannot handle:
    // both read "not seen", both apply. The unique primary key makes the
    // claim atomic, so one blocks on the other and loses.
    const outcomes = await Promise.all([
      applyEvent({ eventId: "evt_race" }),
      applyEvent({ eventId: "evt_race" }),
      applyEvent({ eventId: "evt_race" }),
      applyEvent({ eventId: "evt_race" }),
      applyEvent({ eventId: "evt_race" }),
    ]);

    expect(outcomes.filter((o) => o === "applied")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(4);
    expect(await eventCount()).toBe(1);
  });

  it("keeps distinct events distinct", async () => {
    await applyEvent({ eventId: "evt_a", created: at(10) });
    await applyEvent({ eventId: "evt_b", created: at(20) });
    expect(await eventCount()).toBe(2);
  });
});

describe("out-of-order delivery", () => {
  it("ignores an event older than the one already applied", async () => {
    await applyEvent({ eventId: "evt_new", created: at(30), plan: "business", status: "active" });

    // The upgrade to Premium arrives late, after the move to Business.
    expect(await applyEvent({ eventId: "evt_old", created: at(10), plan: "premium", status: "active" })).toBe("stale");
    expect((await subscriptionRow()).plan_id).toBe("business");
  });

  it("ignores a re-sent event with the same timestamp", async () => {
    await applyEvent({ eventId: "evt_1", created: at(10), plan: "business" });
    expect(await applyEvent({ eventId: "evt_2", created: at(10), plan: "premium" })).toBe("stale");
    expect((await subscriptionRow()).plan_id).toBe("business");
  });

  it("still accepts a genuinely newer event afterwards", async () => {
    // Staleness must not wedge the row: a later event still applies.
    await applyEvent({ eventId: "evt_1", created: at(30), plan: "business" });
    await applyEvent({ eventId: "evt_2", created: at(10), plan: "premium" });

    expect(await applyEvent({ eventId: "evt_3", created: at(40), plan: "premium", status: "canceled" })).toBe("applied");
    expect((await subscriptionRow()).status).toBe("canceled");
  });

  it("records a stale event rather than discarding it silently", async () => {
    await applyEvent({ eventId: "evt_new", created: at(30) });
    await applyEvent({ eventId: "evt_old", created: at(10) });

    const outcome = await db.asAdmin(async (query) => {
      const r = await query(`select outcome from stripe_webhook_events where id = 'evt_old'`);
      return (r.rows[0] as { outcome: string }).outcome;
    });
    expect(outcome).toBe("stale");
  });
});

describe("events that do not belong to anyone here", () => {
  it("records an unknown customer without touching any subscription", async () => {
    const outcome = await applyEvent({ eventId: "evt_orphan", customerId: "cus_not_ours", organizationId: null });

    expect(outcome).toBe("unknown_customer");
    expect((await subscriptionRow()).plan_id).toBe("free");
    expect((await subscriptionRow(otherOrgId)).plan_id).toBe("free");
  });

  it("handles an event naming an organization that does not exist", async () => {
    // A deleted workspace, or metadata someone crafted. This must resolve to
    // a recorded no-op, NOT an error: the claim row carries a foreign key to
    // `organizations`, and writing an unverified id into it aborted the whole
    // function — which made the route answer 503 and Stripe retry that same
    // event forever, with no outcome that could ever end the loop.
    const outcome = await applyEvent({
      eventId: "evt_unknown_org",
      customerId: "cus_unknown",
      organizationId: "99999999-9999-4999-8999-999999999999",
    });

    expect(outcome).toBe("unknown_customer");
    // Claimed, so the retry is answered immediately next time.
    expect(await eventCount()).toBe(1);
  });

  it("leaves the organization unset on an event it could not attribute", async () => {
    await applyEvent({ eventId: "evt_orphan2", customerId: "cus_nobody", organizationId: null });

    const row = await db.asAdmin(async (query) => {
      const r = await query(`select organization_id, outcome from stripe_webhook_events where id = 'evt_orphan2'`);
      return r.rows[0] as { organization_id: string | null; outcome: string };
    });

    expect(row.organization_id).toBeNull();
    expect(row.outcome).toBe("unknown_customer");
  });
});

describe("organization isolation", () => {
  it("upgrades only the organization the customer belongs to", async () => {
    await applyEvent({ eventId: "evt_org_a", customerId: CUSTOMER, organizationId: orgId, plan: "business" });

    expect((await subscriptionRow(orgId)).plan_id).toBe("business");
    expect((await subscriptionRow(otherOrgId)).plan_id).toBe("free");
  });

  it("routes by Stripe customer, not by the metadata organization id", async () => {
    // Customer already bound to org A. An event that claims org B in metadata
    // must still land on A — metadata is a hint for the first event only, and
    // is attacker-influenced if a Checkout Session is ever crafted by hand.
    await applyEvent({ eventId: "evt_bind", customerId: CUSTOMER, organizationId: orgId, plan: "premium" });

    await applyEvent({
      eventId: "evt_confused",
      created: at(30),
      customerId: CUSTOMER,
      organizationId: otherOrgId,
      plan: "business",
    });

    expect((await subscriptionRow(orgId)).plan_id).toBe("business");
    expect((await subscriptionRow(otherOrgId)).plan_id).toBe("free");
  });

  it("keeps two organizations' customers apart", async () => {
    await applyEvent({ eventId: "evt_a", customerId: CUSTOMER, organizationId: orgId, plan: "premium" });
    await applyEvent({
      eventId: "evt_b",
      customerId: OTHER_CUSTOMER,
      organizationId: otherOrgId,
      subscriptionId: "sub_other",
      plan: "business",
    });

    expect((await subscriptionRow(orgId)).plan_id).toBe("premium");
    expect((await subscriptionRow(otherOrgId)).plan_id).toBe("business");
  });

  it("refuses to give one Stripe customer to two organizations", async () => {
    await applyEvent({ eventId: "evt_a", customerId: CUSTOMER, organizationId: orgId });

    await expect(
      db.asAdmin((query) => query(`update subscriptions set stripe_customer_id = $1 where organization_id = $2`, [CUSTOMER, otherOrgId])),
    ).rejects.toThrow();
  });
});

describe("lifecycle transitions", () => {
  it.each([
    ["Free to Premium", "free", "premium"],
    ["Free to Business", "free", "business"],
    ["Premium to Business", "premium", "business"],
    ["Business to Premium", "business", "premium"],
  ] as const)("%s", async (_label, from, to) => {
    if (from !== "free") await applyEvent({ eventId: "evt_from", created: at(5), plan: from });
    expect(await applyEvent({ eventId: "evt_to", created: at(15), plan: to })).toBe("applied");
    expect((await subscriptionRow()).plan_id).toBe(to);
  });

  it("keeps entitlements during a cancellation scheduled for period end", async () => {
    // `cancel_at_period_end` is a scheduled end, not an immediate one: the
    // customer paid for this period and keeps it.
    await applyEvent({ eventId: "evt_cancel_at_end", plan: "premium", status: "active", cancelAtPeriodEnd: true, canceledAt: at(20) });

    const row = await subscriptionRow();
    expect(row.cancel_at_period_end).toBe(true);
    expect(row.status).toBe("active");
    expect(entitlementsFor({ planId: row.plan_id as "premium", status: row.status }).tier).toBe("premium");
  });

  it("removes entitlements on immediate cancellation", async () => {
    await applyEvent({ eventId: "evt_active", created: at(10), plan: "premium", status: "active" });
    await applyEvent({ eventId: "evt_deleted", created: at(20), plan: "premium", status: "canceled", canceledAt: at(20) });

    const row = await subscriptionRow();
    expect(row.status).toBe("canceled");
    expect(entitlementsFor({ planId: row.plan_id as "premium", status: row.status }).tier).toBe("free");
  });

  it("removes entitlements on a failed payment, and restores them on recovery", async () => {
    await applyEvent({ eventId: "evt_active", created: at(10), plan: "premium", status: "active" });

    await applyEvent({ eventId: "evt_failed", created: at(20), plan: "premium", status: "past_due" });
    let row = await subscriptionRow();
    expect(entitlementsFor({ planId: row.plan_id as "premium", status: row.status }).tier).toBe("free");

    await applyEvent({ eventId: "evt_recovered", created: at(30), plan: "premium", status: "active" });
    row = await subscriptionRow();
    expect(entitlementsFor({ planId: row.plan_id as "premium", status: row.status }).tier).toBe("premium");
  });

  it("advances the period on renewal", async () => {
    await applyEvent({ eventId: "evt_p1", created: at(10), periodEnd: at(60) });
    await applyEvent({ eventId: "evt_p2", created: at(70), periodEnd: at(120) });

    // Compared as an instant, not as text: the driver may hand back a Date or
    // a string, and a substring assertion on either is a test that passes for
    // the wrong reason.
    const stored = (await subscriptionRow()).current_period_end;
    expect(new Date(stored as string).toISOString()).toBe(at(120));
  });

  it.each(["incomplete", "incomplete_expired", "unpaid", "paused"])("grants nothing for %s", async (status) => {
    await applyEvent({ eventId: `evt_${status}`, plan: "business", status });
    const row = await subscriptionRow();
    expect(entitlementsFor({ planId: row.plan_id as "business", status: row.status }).tier).toBe("free");
  });
});

describe("billing state is not client-writable", () => {
  it("gives no member a way to update their own subscription", async () => {
    // 0011 creates a SELECT policy and nothing else. RLS expresses "no update
    // policy" as zero rows matched, so the assertion is that nothing changed.
    await db.asUser(OWNER);
    await db.query(`update subscriptions set plan_id = 'business', status = 'active' where organization_id = $1`, [orgId]);

    expect((await subscriptionRow()).plan_id).toBe("free");
  });

  it("gives no member a way to insert a subscription row", async () => {
    await db.asUser(OWNER);
    await expect(
      db.query(`insert into subscriptions (organization_id, plan_id, status) values ($1, 'business', 'active')`, [otherOrgId]),
    ).rejects.toThrow();
  });

  it("hides another organization's subscription entirely", async () => {
    await db.asUser(OUTSIDER);
    const result = await db.query(`select * from subscriptions where organization_id = $1`, [orgId]);
    expect(result.rows).toHaveLength(0);
  });

  it("gives no client any access to the webhook event log", async () => {
    // It names Stripe identifiers and delivery internals — not tenant data a
    // member has any reason to read.
    await applyEvent({ eventId: "evt_secret" });

    await db.asUser(OWNER);
    await expect(db.query(`select * from stripe_webhook_events`)).rejects.toThrow();
  });

  it("lets no client call the sync function directly", async () => {
    // The function is SECURITY DEFINER and writes plan state. If a member
    // could execute it, billing state would be self-service.
    await db.asUser(OWNER);
    await expect(
      db.query(
        `select apply_stripe_subscription_event('evt_x', 't', now(), $1::uuid, 'cus_x', 'sub_x', 'price_x', 'business'::plan_tier,
           'active'::subscription_status, now(), now(), false, null)`,
        [orgId],
      ),
    ).rejects.toThrow();
  });

  it("lets no client bind a Stripe customer", async () => {
    await db.asUser(OWNER);
    await expect(db.query(`select bind_stripe_customer($1::uuid, 'cus_attacker')`, [orgId])).rejects.toThrow();
  });
});

describe("bind_stripe_customer", () => {
  it("attaches a customer to an organization that has none", async () => {
    await db.asAdmin((query) => query(`select bind_stripe_customer($1::uuid, $2)`, [orgId, CUSTOMER]));
    expect((await subscriptionRow()).stripe_customer_id).toBe(CUSTOMER);
  });

  it("never repoints an organization already bound to a customer", async () => {
    // A concurrent second Checkout must not move the workspace onto a new
    // customer and orphan the paying one.
    await db.asAdmin((query) => query(`select bind_stripe_customer($1::uuid, $2)`, [orgId, CUSTOMER]));
    await db.asAdmin((query) => query(`select bind_stripe_customer($1::uuid, 'cus_second')`, [orgId]));

    expect((await subscriptionRow()).stripe_customer_id).toBe(CUSTOMER);
  });
});
