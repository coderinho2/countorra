import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * supabase/migrations/0051_personal_launch_scope.sql, against the real
 * migrations in an in-process Postgres (tests/rls/harness.ts).
 *
 * Countorra launches personal-only. The database enforces it: no organization
 * can be created as, or changed to, freelancer or business — by any caller.
 * Workspaces stored as freelancer or business before the launch keep their
 * value and their data, stay fully usable by their members, and stay exactly
 * as isolated from everyone else as before.
 */

function one<T>(rows: unknown[]): T {
  return rows[0] as T;
}

let db: TestDatabase;
let owner: string;
let outsider: string;

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin(async (query) => {
    const users = await query(`insert into auth.users (email) values ('owner@example.com'), ('outsider@example.com') returning id`);
    [owner, outsider] = users.rows.map((r) => (r as { id: string }).id);
  });
});

afterEach(async () => {
  await db.close();
});

/** Seeds a workspace the way one created before the launch scope exists: the
 *  guard is lifted for this one insert only, as the migration never ran then. */
async function seedLegacyOrganization(entityType: "freelancer" | "business", createdBy: string): Promise<string> {
  await db.asAdmin((query) => query(`alter table organizations disable trigger organizations_personal_launch_scope`));
  // Inserted by its owner's own session, as it was then — the bootstrap
  // trigger's audit entry requires one.
  await db.asUser(createdBy);
  const result = await db.query(`insert into organizations (name, entity_type, created_by) values ('Legacy ${entityType}', $1, $2) returning id`, [entityType, createdBy]);
  await db.asAdmin((query) => query(`alter table organizations enable trigger organizations_personal_launch_scope`));
  return one<{ id: string }>(result.rows).id;
}

describe("creating organizations", () => {
  it("creates a personal organization, bootstrapped exactly as before", async () => {
    await db.asUser(owner);
    const org = one<{ id: string; entity_type: string }>(
      (await db.query(`insert into organizations (name, entity_type, created_by) values ('Mine', 'personal', $1) returning id, entity_type`, [owner])).rows,
    );
    expect(org.entity_type).toBe("personal");

    // The bootstrap trigger (0012) still runs: owner membership, free plan, starter categories.
    const membership = await db.query(`select role from memberships where organization_id = $1 and user_id = $2`, [org.id, owner]);
    expect(membership.rows).toEqual([{ role: "owner" }]);
    const subscription = await db.query(`select plan_id from subscriptions where organization_id = $1`, [org.id]);
    expect(subscription.rows).toEqual([{ plan_id: "free" }]);
    const categories = await db.query(`select count(*)::int as n from transaction_categories where organization_id = $1`, [org.id]);
    expect(one<{ n: number }>(categories.rows).n).toBeGreaterThan(0);
  });

  it("defaults to personal when no entity type is given", async () => {
    await db.asUser(owner);
    const result = await db.query(`insert into organizations (name, created_by) values ('Default', $1) returning entity_type`, [owner]);
    expect(result.rows).toEqual([{ entity_type: "personal" }]);
  });

  it.each(["freelancer", "business"])("refuses a %s organization from a signed-in user", async (entityType) => {
    await db.asUser(owner);
    await expect(db.query(`insert into organizations (name, entity_type, created_by) values ('No', $1, $2)`, [entityType, owner])).rejects.toThrow(
      /personal workspaces only/,
    );
  });

  it.each(["freelancer", "business"])("refuses a %s organization even from the superuser", async (entityType) => {
    await db.asAdmin(async (query) => {
      await expect(query(`insert into organizations (name, entity_type, created_by) values ('No', $1, $2)`, [entityType, owner])).rejects.toThrow(
        /personal workspaces only/,
      );
    });
  });
});

describe("changing an organization's entity type", () => {
  it.each(["freelancer", "business"])("refuses to turn a personal organization into %s", async (entityType) => {
    await db.asUser(owner);
    const { id } = one<{ id: string }>((await db.query(`insert into organizations (name, created_by) values ('Mine', $1) returning id`, [owner])).rows);
    await expect(db.query(`update organizations set entity_type = $1 where id = $2`, [entityType, id])).rejects.toThrow(/personal workspaces only/);
    const after = await db.query(`select entity_type from organizations where id = $1`, [id]);
    expect(after.rows).toEqual([{ entity_type: "personal" }]);
  });
});

describe("workspaces created before the launch scope", () => {
  it("keep their stored type and stay fully usable by their members", async () => {
    const legacy = await seedLegacyOrganization("business", owner);

    await db.asUser(owner);
    const visible = await db.query(`select id, entity_type from organizations where id = $1`, [legacy]);
    expect(visible.rows).toEqual([{ id: legacy, entity_type: "business" }]);

    // Everyday edits that do not touch the entity type still work.
    await db.query(`update organizations set name = 'Renamed' where id = $1`, [legacy]);
    expect((await db.query(`select name from organizations where id = $1`, [legacy])).rows).toEqual([{ name: "Renamed" }]);
  });

  it("can be moved to personal, never to another deferred type", async () => {
    const legacy = await seedLegacyOrganization("business", owner);
    await db.asUser(owner);
    await expect(db.query(`update organizations set entity_type = 'freelancer' where id = $1`, [legacy])).rejects.toThrow(/personal workspaces only/);
    await db.query(`update organizations set entity_type = 'personal' where id = $1`, [legacy]);
    expect((await db.query(`select entity_type from organizations where id = $1`, [legacy])).rows).toEqual([{ entity_type: "personal" }]);
  });

  it("stay exactly as isolated from other tenants", async () => {
    const legacy = await seedLegacyOrganization("freelancer", owner);

    await db.asUser(outsider);
    expect((await db.query(`select id from organizations where id = $1`, [legacy])).rows).toEqual([]);
    const updated = await db.query(`update organizations set name = 'Hijacked' where id = $1 returning id`, [legacy]);
    expect(updated.rows).toEqual([]);
    expect((await db.query(`select organization_id from memberships where organization_id = $1`, [legacy])).rows).toEqual([]);

    await db.asUser(owner);
    expect((await db.query(`select name from organizations where id = $1`, [legacy])).rows).toEqual([{ name: "Legacy freelancer" }]);
  });

  it("lose no data: nothing in the migration rewrote or removed them", async () => {
    const legacy = await seedLegacyOrganization("business", owner);
    await db.asAdmin(async (query) => {
      const subscription = await query(`select plan_id from subscriptions where organization_id = $1`, [legacy]);
      expect(subscription.rows).toEqual([{ plan_id: "free" }]);
      const membership = await query(`select role from memberships where organization_id = $1`, [legacy]);
      expect(membership.rows).toEqual([{ role: "owner" }]);
    });
  });
});

describe("security is unchanged", () => {
  it("no RLS policy depends on entity_type, so the launch scope cannot widen or narrow access", async () => {
    await db.asAdmin(async (query) => {
      const result = await query(
        `select policyname from pg_policies where coalesce(qual, '') ilike '%entity_type%' or coalesce(with_check, '') ilike '%entity_type%'`,
      );
      expect(result.rows).toEqual([]);
    });
  });

  it("keeps RLS enabled on organizations", async () => {
    await db.asAdmin(async (query) => {
      const result = await query(`select relrowsecurity from pg_class where relname = 'organizations'`);
      expect(result.rows).toEqual([{ relrowsecurity: true }]);
    });
  });
});
