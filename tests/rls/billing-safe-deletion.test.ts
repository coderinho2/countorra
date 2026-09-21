import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";
import { entitlementsFor } from "@/domain/billing/entitlements";

/**
 * Billing-safe organization deletion (migration 0050), against real Postgres.
 *
 * The application cancels in Stripe before deleting (deletion-safety.ts). The
 * database holds the same line on its own, so the invariant does not depend on
 * every caller remembering:
 *
 *   - no browser session can delete an organization directly;
 *   - nobody — service role included — can delete one whose row still records
 *     a Stripe subscription that can bill;
 *   - the teardown lock serializes deletions;
 *   - a recorded cancellation cannot be undone by an older webhook.
 */

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTSIDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CUSTOMER = "cus_test_deletion";
const SUBSCRIPTION = "sub_test_deletion";
const ATTEMPT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_ATTEMPT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let db: TestDatabase;
let orgId: string;

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 18, 12, minutes, 0)).toISOString();

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin((query) =>
    query(`insert into auth.users (id, email) values ($1, 'owner@example.test'), ($2, 'outsider@example.test')`, [OWNER, OUTSIDER]),
  );
  await db.asUser(OWNER);
  const org = await db.query(`insert into organizations (name, entity_type, created_by) values ('Paid', 'personal', $1) returning id`, [OWNER]);
  orgId = (org.rows[0] as { id: string }).id;
});

afterEach(async () => {
  await db.close();
});

/** Exactly as the webhook route calls it. */
async function applyEvent(options: { eventId: string; created: string; status: string; canceledAt?: string | null }) {
  return db.asAdmin(async (query) => {
    const r = await query(
      `select apply_stripe_subscription_event($1, 'customer.subscription.updated', $2::timestamptz, $3::uuid, $4, $5, 'price_premium',
         'premium'::plan_tier, $6::subscription_status, $7::timestamptz, $8::timestamptz, false, $9::timestamptz) as outcome`,
      [options.eventId, options.created, orgId, CUSTOMER, SUBSCRIPTION, options.status, at(0), at(60), options.canceledAt ?? null],
    );
    return (r.rows[0] as { outcome: string }).outcome;
  });
}

async function makePaid() {
  await db.asAdmin((query) => query(`select bind_stripe_customer($1::uuid, $2)`, [orgId, CUSTOMER]));
  expect(await applyEvent({ eventId: "evt_paid", created: at(5), status: "active" })).toBe("applied");
}

async function row() {
  return db.asAdmin(async (query) => {
    const r = await query(`select * from subscriptions where organization_id = $1`, [orgId]);
    return r.rows[0] as
      | { plan_id: "free" | "premium" | "business"; status: string; canceled_at: string | null; stripe_event_at: string | null; deletion_lock_id: string | null }
      | undefined;
  });
}

const orgExists = () =>
  db.asAdmin(async (query) => (await query(`select 1 from organizations where id = $1`, [orgId])).rows.length === 1);

/** Runs as the Data API's service role — not the superuser the harness uses. */
function asServiceRole<T>(fn: () => Promise<T>): Promise<T> {
  return db.asAdmin(async (query) => {
    await query(`set role service_role`);
    try {
      return await fn();
    } finally {
      await query(`reset role`);
    }
  });
}

describe("no browser session can delete an organization", () => {
  it("refuses the owner's own session outright", async () => {
    await db.asUser(OWNER);
    await expect(db.query(`delete from organizations where id = $1`, [orgId])).rejects.toThrow(/permission denied/i);
    expect(await orgExists()).toBe(true);
  });

  it("refuses an outsider too", async () => {
    await db.asUser(OUTSIDER);
    await expect(db.query(`delete from organizations where id = $1`, [orgId])).rejects.toThrow(/permission denied/i);
    expect(await orgExists()).toBe(true);
  });

  it("no longer carries a delete policy for organizations", async () => {
    const policies = await db.asAdmin((query) =>
      query(`select policyname from pg_policies where tablename = 'organizations' and cmd = 'DELETE'`),
    );
    expect(policies.rows).toEqual([]);
  });
});

describe("the guard: nothing deletes an organization that can still be billed", () => {
  it.each(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"])("blocks deletion while the subscription is %s", async (status) => {
    await makePaid();
    if (status !== "active") expect(await applyEvent({ eventId: `evt_${status}`, created: at(6), status })).toBe("applied");

    await expect(db.asAdmin((query) => query(`delete from organizations where id = $1`, [orgId]))).rejects.toThrow(/Stripe subscription/);
    expect(await orgExists()).toBe(true);
    expect((await row())?.status).toBe(status);
  });

  it("blocks the service role as well", async () => {
    await makePaid();
    await expect(asServiceRole(() => db.query(`delete from organizations where id = $1`, [orgId]))).rejects.toThrow(/Stripe subscription/);
    expect(await orgExists()).toBe(true);
  });

  it("allows deletion once the cancellation is recorded, and the row goes with it", async () => {
    await makePaid();
    await asServiceRole(() =>
      db.query(`select record_stripe_subscription_terminal($1::uuid, $2, 'canceled'::subscription_status, $3::timestamptz)`, [orgId, SUBSCRIPTION, at(30)]),
    );
    await asServiceRole(() => db.query(`delete from organizations where id = $1`, [orgId]));
    expect(await orgExists()).toBe(false);
    expect(await row()).toBeUndefined();
  });

  it("allows deletion when Stripe's own webhook already recorded the cancellation", async () => {
    await makePaid();
    expect(await applyEvent({ eventId: "evt_deleted", created: at(20), status: "canceled", canceledAt: at(20) })).toBe("applied");
    await db.asAdmin((query) => query(`delete from organizations where id = $1`, [orgId]));
    expect(await orgExists()).toBe(false);
  });

  it("does not block a workspace that only has a bound customer and never paid", async () => {
    // bind_stripe_customer sets the provider before any payment; the app-side
    // check asks Stripe about that customer, the guard does not need to.
    await db.asAdmin((query) => query(`select bind_stripe_customer($1::uuid, $2)`, [orgId, CUSTOMER]));
    await db.asAdmin((query) => query(`delete from organizations where id = $1`, [orgId]));
    expect(await orgExists()).toBe(false);
  });

  it("does not block a Free workspace", async () => {
    await db.asAdmin((query) => query(`delete from organizations where id = $1`, [orgId]));
    expect(await orgExists()).toBe(false);
  });
});

describe("recording a terminal state", () => {
  const record = (status: string, subscriptionId = SUBSCRIPTION, canceledAt = at(30)) =>
    db.asAdmin((query) =>
      query(`select record_stripe_subscription_terminal($1::uuid, $2, $3::subscription_status, $4::timestamptz) as found`, [orgId, subscriptionId, status, canceledAt]),
    );

  it("removes paid entitlements immediately", async () => {
    await makePaid();
    expect(entitlementsFor({ planId: "premium", status: "active" }).tier).toBe("premium");

    await record("canceled");
    const after = await row();
    expect(after?.status).toBe("canceled");
    expect(entitlementsFor({ planId: after!.plan_id, status: after!.status as "canceled" }).tier).toBe("free");
  });

  it("can never grant: a non-terminal status is rejected", async () => {
    await makePaid();
    await record("canceled");
    await expect(record("active")).rejects.toThrow(/terminal/);
    expect((await row())?.status).toBe("canceled");
  });

  it("only touches the subscription it names", async () => {
    await makePaid();
    const r = await record("canceled", "sub_someone_else");
    expect((r.rows[0] as { found: boolean }).found).toBe(false);
    expect((await row())?.status).toBe("active");
  });

  it("an older webhook arriving afterwards is stale and cannot resurrect the plan", async () => {
    await makePaid();
    await record("canceled", SUBSCRIPTION, at(30));

    // Delayed delivery of an event created BEFORE the cancellation.
    expect(await applyEvent({ eventId: "evt_late_active", created: at(25), status: "active" })).toBe("stale");
    expect((await row())?.status).toBe("canceled");
  });

  it("a webhook arriving after the workspace is deleted resurrects nothing", async () => {
    await makePaid();
    await record("canceled", SUBSCRIPTION, at(30));
    await db.asAdmin((query) => query(`delete from organizations where id = $1`, [orgId]));

    // Even a NEWER event claiming "active", naming the deleted organization.
    expect(await applyEvent({ eventId: "evt_after_delete", created: at(50), status: "active" })).toBe("unknown_customer");
    const rows = await db.asAdmin((query) => query(`select * from subscriptions where stripe_customer_id = $1 or organization_id = $2`, [CUSTOMER, orgId]));
    expect(rows.rows).toEqual([]);
  });

  it("is idempotent", async () => {
    await makePaid();
    await record("canceled", SUBSCRIPTION, at(30));
    await record("canceled", SUBSCRIPTION, at(40));
    const after = await row();
    expect(after?.status).toBe("canceled");
    expect(new Date(after!.canceled_at!).toISOString()).toBe(at(30));
  });
});

describe("the teardown lock", () => {
  const acquire = (attempt: string) =>
    db.asAdmin(async (query) => {
      const r = await query(`select acquire_organization_billing_teardown($1::uuid, $2::uuid) as ok`, [orgId, attempt]);
      return (r.rows[0] as { ok: boolean }).ok;
    });
  const release = (attempt: string) =>
    db.asAdmin((query) => query(`select release_organization_billing_teardown($1::uuid, $2::uuid)`, [orgId, attempt]));

  it("admits one attempt at a time", async () => {
    expect(await acquire(ATTEMPT)).toBe(true);
    expect(await acquire(OTHER_ATTEMPT)).toBe(false);
    expect(await acquire(ATTEMPT)).toBe(true); // re-entrant for the holder
  });

  it("can only be released by its holder", async () => {
    await acquire(ATTEMPT);
    await release(OTHER_ATTEMPT);
    expect((await row())?.deletion_lock_id).toBe(ATTEMPT);
    await release(ATTEMPT);
    expect((await row())?.deletion_lock_id).toBeNull();
    expect(await acquire(OTHER_ATTEMPT)).toBe(true);
  });

  it("lapses after 15 minutes, so a crashed attempt cannot lock billing forever", async () => {
    await acquire(ATTEMPT);
    await db.asAdmin((query) => query(`update subscriptions set deletion_locked_at = now() - interval '16 minutes' where organization_id = $1`, [orgId]));
    expect(await acquire(OTHER_ATTEMPT)).toBe(true);
  });

  it("serializes truly concurrent attempts", async () => {
    const results = await Promise.all([acquire(ATTEMPT), acquire(OTHER_ATTEMPT)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("is invisible to other tenants and unwritable by members", async () => {
    await acquire(ATTEMPT);
    await db.asUser(OWNER);
    await db.query(`update subscriptions set deletion_lock_id = null, deletion_locked_at = null where organization_id = $1`, [orgId]);
    expect((await row())?.deletion_lock_id).toBe(ATTEMPT);

    await db.asUser(OUTSIDER);
    expect((await db.query(`select * from subscriptions where organization_id = $1`, [orgId])).rows).toHaveLength(0);
  });
});

describe("no client can reach the new functions", () => {
  it.each([
    [`select acquire_organization_billing_teardown($1::uuid, '${ATTEMPT}'::uuid)`],
    [`select release_organization_billing_teardown($1::uuid, '${ATTEMPT}'::uuid)`],
    [`select record_stripe_subscription_terminal($1::uuid, '${SUBSCRIPTION}', 'canceled'::subscription_status, now())`],
  ])("%s", async (sql) => {
    await makePaid();
    await db.asUser(OWNER);
    await expect(db.query(sql, [orgId])).rejects.toThrow(/permission denied/i);
  });

  it("the service role can", async () => {
    const r = await asServiceRole(() => db.query(`select acquire_organization_billing_teardown($1::uuid, $2::uuid) as ok`, [orgId, ATTEMPT]));
    expect((r.rows[0] as { ok: boolean }).ok).toBe(true);
  });
});
