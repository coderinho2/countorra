import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * supabase/migrations/0052_supported_states.sql, and the isolation of a
 * workspace's state, against the real migrations (tests/rls/harness.ts).
 */

let db: TestDatabase;
let owner: string;
let outsider: string;
let org: string;

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin(async (query) => {
    const users = await query(`insert into auth.users (email) values ('owner@example.com'), ('outsider@example.com') returning id`);
    [owner, outsider] = users.rows.map((r) => (r as { id: string }).id);
  });
  await db.asUser(owner);
  const result = await db.query(`insert into organizations (name, entity_type, created_by, state_region) values ('Mine', 'personal', $1, 'CA') returning id`, [owner]);
  org = (result.rows[0] as { id: string }).id;
});

afterEach(async () => {
  await db.close();
});

describe("which states the database accepts", () => {
  it.each(["CA", "TX", "AZ", "FL", "NY"])("accepts %s", async (code) => {
    await db.asUser(owner);
    await db.query(`update organizations set state_region = $1 where id = $2`, [code, org]);
    expect((await db.query(`select state_region from organizations where id = $1`, [org])).rows).toEqual([{ state_region: code }]);
  });

  it.each(["WA", "NJ", "ca"])("refuses %s, from any caller", async (code) => {
    await db.asUser(owner);
    await expect(db.query(`update organizations set state_region = $1 where id = $2`, [code, org])).rejects.toThrow();
    await db.asAdmin(async (query) => {
      await expect(query(`update organizations set state_region = $1 where id = $2`, [code, org])).rejects.toThrow();
    });
  });

  it("still allows no state, for workspaces that have not been told yet", async () => {
    await db.asUser(owner);
    const result = await db.query(`insert into organizations (name, entity_type, created_by) values ('Legacy', 'personal', $1) returning state_region`, [owner]);
    expect(result.rows).toEqual([{ state_region: null }]);
  });
});

describe("a workspace's state is private to its members", () => {
  it("cannot be read by someone outside the workspace", async () => {
    await db.asUser(outsider);
    expect((await db.query(`select state_region from organizations where id = $1`, [org])).rows).toEqual([]);
  });

  it("cannot be changed by someone outside the workspace", async () => {
    await db.asUser(outsider);
    const updated = await db.query(`update organizations set state_region = 'TX' where id = $1 returning id`, [org]);
    expect(updated.rows).toEqual([]);
    await db.asUser(owner);
    expect((await db.query(`select state_region from organizations where id = $1`, [org])).rows).toEqual([{ state_region: "CA" }]);
  });
});
