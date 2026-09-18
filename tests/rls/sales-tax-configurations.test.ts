import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/** RLS coverage for supabase/migrations/0017_us_tax_architecture.sql's
 *  sales_tax_configurations table (US-first direction update, Phase 2). */

let db: TestDatabase;
let owner: string;
let viewer: string;
let outsider: string;
let orgA: string;

beforeEach(async () => {
  db = await createTestDatabase();

  await db.asAdmin(async (query) => {
    const users = await query(`insert into auth.users (email) values ('owner@example.com'), ('viewer@example.com'), ('outsider@example.com') returning id`);
    [owner, viewer, outsider] = users.rows.map((r: unknown) => (r as { id: string }).id);
  });

  await db.asUser(owner);
  const org = await db.query(`insert into organizations (name, entity_type, created_by) values ('Org A', 'business', $1) returning id`, [owner]);
  orgA = (org.rows[0] as { id: string }).id;

  await db.asAdmin((query) => query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'viewer')`, [orgA, viewer]));
});

afterEach(async () => {
  await db.close();
});

describe("sales_tax_configurations", () => {
  it("an owner can create a state nexus configuration", async () => {
    await db.asUser(owner);
    const result = await db.query(
      `insert into sales_tax_configurations (organization_id, state, has_nexus, registered) values ($1, 'CA', true, true) returning id`,
      [orgA],
    );
    expect(result.rows).toHaveLength(1);
  });

  it("a viewer can read but not write", async () => {
    await db.asAdmin((query) => query(`insert into sales_tax_configurations (organization_id, state) values ($1, 'NY')`, [orgA]));

    await db.asUser(viewer);
    expect((await db.query(`select * from sales_tax_configurations`)).rows).toHaveLength(1);
    await expect(db.query(`insert into sales_tax_configurations (organization_id, state) values ($1, 'TX')`, [orgA])).rejects.toThrow();
  });

  it("an outsider cannot see another organization's sales tax configuration", async () => {
    await db.asAdmin((query) => query(`insert into sales_tax_configurations (organization_id, state) values ($1, 'WA')`, [orgA]));

    await db.asUser(outsider);
    expect((await db.query(`select * from sales_tax_configurations`)).rows).toHaveLength(0);
  });

  it("only owner/admin can delete a configuration, not accountant", async () => {
    await db.asAdmin((query) => query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'accountant')`, [orgA, outsider]));
    const created = await db.asAdmin((query) =>
      query(`insert into sales_tax_configurations (organization_id, state) values ($1, 'FL') returning id`, [orgA]),
    );
    const id = (created.rows[0] as { id: string }).id;

    await db.asUser(outsider);
    const attempt = await db.query(`delete from sales_tax_configurations where id = $1 returning id`, [id]);
    expect(attempt.rows).toHaveLength(0);

    await db.asUser(owner);
    const ownerAttempt = await db.query(`delete from sales_tax_configurations where id = $1 returning id`, [id]);
    expect(ownerAttempt.rows).toHaveLength(1);
  });
});

describe("organizations tax identifier", () => {
  it("defaults new organizations to US/USD", async () => {
    await db.asUser(owner);
    const result = await db.query(`select country, base_currency from organizations where id = $1`, [orgA]);
    expect((result.rows[0] as { country: string; base_currency: string }).country).toBe("US");
    expect((result.rows[0] as { country: string; base_currency: string }).base_currency).toBe("USD");
  });

  it("accepts an EIN-typed tax identifier", async () => {
    await db.asUser(owner);
    const result = await db.query(
      `update organizations set tax_identifier = '12-3456789', tax_identifier_type = 'ein' where id = $1 returning tax_identifier_type`,
      [orgA],
    );
    expect((result.rows[0] as { tax_identifier_type: string }).tax_identifier_type).toBe("ein");
  });
});
