import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * supabase/migrations/0059_developer_plan_override.sql, against the real
 * migrations.
 *
 * The whole security value of this table is what a BROWSER ROLE cannot do
 * with it. The application checks an allowlist before it acts on a row, but
 * that is a second line: the first is that `authenticated` has no policy
 * permitting an insert, an update or a delete, so no request a signed-in
 * person can construct — no crafted form, no manipulated client state, no
 * direct PostgREST call — can grant them a plan.
 *
 * Every case below runs AS A SIGNED-IN USER, because that is the attacker
 * being modelled: not an anonymous stranger, but a real member of a real
 * workspace trying to promote themselves.
 */

const one = <T>(result: { rows: unknown[] }) => result.rows[0] as T;

let db: TestDatabase;
let owner: string;
let outsider: string;
let orgA: string;
let orgB: string;

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin(async (query) => {
    owner = one<{ id: string }>(await query(`insert into auth.users (email) values ('owner@example.test') returning id`)).id;
    outsider = one<{ id: string }>(await query(`insert into auth.users (email) values ('outsider@example.test') returning id`)).id;
  });

  await db.asUser(owner);
  orgA = one<{ id: string }>(await db.query(`insert into organizations (name, entity_type, created_by) values ('Mine', 'personal', $1) returning id`, [owner])).id;

  await db.asUser(outsider);
  orgB = one<{ id: string }>(await db.query(`insert into organizations (name, entity_type, created_by) values ('Theirs', 'personal', $1) returning id`, [outsider])).id;
});

afterEach(async () => {
  await db.close();
});

const override = (organizationId: string) =>
  db.asAdmin(async (query) => (await query(`select plan_id from developer_plan_overrides where organization_id = $1`, [organizationId])).rows as { plan_id: string }[]);

/** As the service role — what the server action does once it has checked the
 *  allowlist and ownership. */
const grant = (organizationId: string, plan: string, actor: string | null = owner) =>
  db.asAdmin((query) =>
    query(`insert into developer_plan_overrides (organization_id, plan_id, created_by) values ($1, $2, $3) on conflict (organization_id) do update set plan_id = excluded.plan_id`, [
      organizationId,
      plan,
      actor,
    ]),
  );

describe("a signed-in user cannot grant themselves a plan", () => {
  it("cannot insert an override for their OWN workspace", async () => {
    await db.asUser(owner);
    // The owner of the workspace, signed in, asking for Business. There is no
    // insert policy, so PostgREST/Postgres refuses regardless of who they are.
    await expect(db.query(`insert into developer_plan_overrides (organization_id, plan_id) values ($1, 'business')`, [orgA])).rejects.toThrow();
    expect(await override(orgA)).toHaveLength(0);
  });

  it("cannot insert an override for somebody else's workspace", async () => {
    await db.asUser(outsider);
    await expect(db.query(`insert into developer_plan_overrides (organization_id, plan_id) values ($1, 'business')`, [orgA])).rejects.toThrow();
    expect(await override(orgA)).toHaveLength(0);
  });

  it("cannot UPDATE an override that already exists", async () => {
    await grant(orgA, "free");
    await db.asUser(owner);

    // Raising their own test plan from free to business. Postgres does not
    // REFUSE this the way it refuses the insert — with no permissive update
    // policy the rows are simply not visible to the statement, so it succeeds
    // having changed nothing. The security property is the row, not the
    // error, so that is what is asserted.
    const result = await db.query(`update developer_plan_overrides set plan_id = 'business' where organization_id = $1 returning organization_id`, [orgA]);
    expect(result.rows).toHaveLength(0);
    expect((await override(orgA))[0].plan_id).toBe("free");
  });

  it("cannot DELETE an override, which would be a way to escape a forced Free", async () => {
    await grant(orgA, "free");
    await db.asUser(owner);

    // Same shape: nothing is deleted, and nothing says so.
    const result = await db.query(`delete from developer_plan_overrides where organization_id = $1 returning organization_id`, [orgA]);
    expect(result.rows).toHaveLength(0);
    expect(await override(orgA)).toHaveLength(1);
  });
});

describe("what a member may see", () => {
  it("reads their own workspace's override, so the UI can say it is a test plan", async () => {
    await grant(orgA, "premium");
    await db.asUser(owner);
    const rows = (await db.query(`select plan_id from developer_plan_overrides where organization_id = $1`, [orgA])).rows as { plan_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].plan_id).toBe("premium");
  });

  it("sees nothing of another workspace's, like every other table", async () => {
    await grant(orgA, "business");
    await db.asUser(outsider);
    expect((await db.query(`select plan_id from developer_plan_overrides where organization_id = $1`, [orgA])).rows).toHaveLength(0);
  });
});

describe("the table itself", () => {
  it("accepts only the three real tiers", async () => {
    await expect(grant(orgA, "enterprise")).rejects.toThrow();
    for (const plan of ["free", "premium", "business"]) {
      await expect(grant(orgA, plan), plan).resolves.toBeDefined();
    }
  });

  it("holds at most one override per workspace", async () => {
    await grant(orgA, "premium");
    await grant(orgA, "business");
    const rows = await override(orgA);
    expect(rows).toHaveLength(1);
    expect(rows[0].plan_id).toBe("business");
  });

  it("goes with the workspace when it is deleted", async () => {
    await grant(orgA, "premium");
    await db.asAdmin((query) => query(`delete from organizations where id = $1`, [orgA]));
    expect(await override(orgA)).toHaveLength(0);
  });

  it("survives the developer's account being deleted, with the attribution cleared", async () => {
    // A developer who owns no workspace of their own, so deleting them does
    // not run into the "an organization must always have at least one owner"
    // rule — which is what would happen with orgA's owner, and is a different
    // invariant from the one under test here.
    const developer = await db.asAdmin(async (query) => one<{ id: string }>(await query(`insert into auth.users (email) values ('dev@example.test') returning id`)).id);
    await grant(orgA, "premium", developer);

    await db.asAdmin((query) => query(`delete from auth.users where id = $1`, [developer]));

    const rows = await db.asAdmin(async (query) => (await query(`select plan_id, created_by from developer_plan_overrides where organization_id = $1`, [orgA])).rows as { plan_id: string; created_by: string | null }[]);
    // The override outlives the account: `on delete set null`, so the plan
    // stands and only the attribution goes.
    expect(rows[0]).toMatchObject({ plan_id: "premium", created_by: null });
  });

  it("does not touch the workspace's real subscription", async () => {
    const before = await db.asAdmin(async (query) => (await query(`select plan_id, status from subscriptions where organization_id = $1`, [orgA])).rows);
    await grant(orgA, "business");
    const after = await db.asAdmin(async (query) => (await query(`select plan_id, status from subscriptions where organization_id = $1`, [orgA])).rows);
    // The row Stripe owns is byte-for-byte what it was.
    expect(after).toEqual(before);
    expect(one<{ plan_id: string }>({ rows: after }).plan_id).toBe("free");
  });
});

describe("the schema version is reported", () => {
  it("is 0059", async () => {
    expect(await db.asAdmin(async (query) => one<{ v: string }>(await query(`select operations_schema_version() as v`)).v)).toBe("0059");
  });
});

describe("orgB is untouched by anything done to orgA", () => {
  it("keeps no override of its own", async () => {
    await grant(orgA, "business");
    expect(await override(orgB)).toHaveLength(0);
  });
});
