import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * 0045 — `tax_preparation_cases.spouse_itemizes_deductions`, against real
 * Postgres with every migration applied.
 *
 * The column is a person's answer for married filing separately (IRS Topic
 * 551). It must be additive — nullable, no default answer, no other column or
 * guarantee changed — and it must follow the existing row policies: the case's
 * own members can record it, nobody else can, and the identity trigger from
 * 0043 still refuses what it refused before.
 */

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let db: TestDatabase;
let orgA: string;
let caseA: string;

async function answer(id: string): Promise<boolean | null | undefined> {
  const result = await db.asAdmin((query) => query(`select spouse_itemizes_deductions from tax_preparation_cases where id = $1`, [id]));
  return (result.rows[0] as { spouse_itemizes_deductions: boolean | null } | undefined)?.spouse_itemizes_deductions;
}

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin((query) => query(`insert into auth.users (id, email) values ($1, 'owner@example.test'), ($2, 'other-owner@example.test')`, [OWNER, OTHER_OWNER]));

  await db.asUser(OWNER);
  orgA = ((await db.query(`insert into organizations (name, entity_type, created_by) values ('Test A', 'personal', $1) returning id`, [OWNER])).rows[0] as { id: string }).id;
  await db.asUser(OTHER_OWNER);
  await db.query(`insert into organizations (name, entity_type, created_by) values ('Someone else', 'personal', $1) returning id`, [OTHER_OWNER]);

  caseA = await db.asAdmin(async (query) => {
    const result = await query(
      `insert into tax_preparation_cases (organization_id, tax_year, status, filing_status, primary_state_region, created_by)
       values ($1, 2026, 'COLLECTING', 'married_filing_separately', 'TX', $2) returning id`,
      [orgA, OWNER],
    );
    return (result.rows[0] as { id: string }).id;
  });
});

afterEach(async () => {
  await db.close();
});

describe("0045 spouse_itemizes_deductions", () => {
  it("is a nullable boolean with no default answer", async () => {
    const column = await db.asAdmin((query) =>
      query(
        `select data_type, is_nullable, column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'tax_preparation_cases' and column_name = 'spouse_itemizes_deductions'`,
      ),
    );
    expect(column.rows).toEqual([{ data_type: "boolean", is_nullable: "YES", column_default: null }]);
    // An existing or new case starts unanswered — never "no" by default.
    expect(await answer(caseA)).toBeNull();
  });

  it("lets the case's own owner record yes, no, and clear the answer", async () => {
    await db.asUser(OWNER);
    for (const value of [true, false, null]) {
      const updated = await db.query(`update tax_preparation_cases set spouse_itemizes_deductions = $1 where id = $2 returning id`, [value, caseA]);
      expect(updated.rows, String(value)).toHaveLength(1);
      expect(await answer(caseA), String(value)).toBe(value);
    }
  });

  it("is invisible and unwritable to another workspace's owner", async () => {
    await db.asUser(OTHER_OWNER);
    const updated = await db.query(`update tax_preparation_cases set spouse_itemizes_deductions = true where id = $1 returning id`, [caseA]);
    expect(updated.rows).toHaveLength(0);
    expect(await answer(caseA)).toBeNull();
  });

  it("is refused anything but a boolean", async () => {
    await db.asUser(OWNER);
    await expect(db.query(`update tax_preparation_cases set spouse_itemizes_deductions = 'maybe' where id = $1`, [caseA])).rejects.toThrow();
  });

  it("does not loosen the 0043 identity trigger when changed alongside a protected column", async () => {
    await db.asUser(OWNER);
    await expect(db.query(`update tax_preparation_cases set spouse_itemizes_deductions = false, tax_year = 2025 where id = $1`, [caseA])).rejects.toThrow(/tax_year/);
    expect(await answer(caseA)).toBeNull();
  });

  it("keeps the filing-status CHECK exactly as it was", async () => {
    await db.asUser(OWNER);
    await expect(db.query(`update tax_preparation_cases set filing_status = 'married_filing_jointly_but_separately' where id = $1`, [caseA])).rejects.toThrow();
  });
});
