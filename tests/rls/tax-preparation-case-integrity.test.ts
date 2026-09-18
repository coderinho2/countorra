import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * A preparation case's identity columns cannot be rewritten — against real
 * Postgres, by anyone, through any path.
 *
 * FOUND DURING LIVE VERIFICATION (Task 7.1), CLOSED BY 0043
 *
 * 0042 gives write-capable members an UPDATE policy on tax_preparation_cases,
 * because a case genuinely is edited. RLS policies are row-level, so nothing
 * stopped the same member, calling the REST API directly, from rewriting the
 * columns that give a case its meaning. The trigger in 0043 enforces
 * column-level immutability for every caller: the signed-in owner (the
 * authenticated REST path), and the service role (asAdmin here), which RLS
 * never sees.
 *
 * Each protected column is tried by both, individually, and then in the
 * combinations a bypass would need: alongside a legitimate change, together
 * with another protected column, via an upsert, via UPDATE … FROM, and across
 * several rows at once.
 */

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOMEONE_ELSE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let db: TestDatabase;
let orgA: string;
let orgB: string;
let orgOther: string;
let caseA: string;

type CaseRow = { id: string; tax_year: number; organization_id: string; created_by: string | null; created_at: string; filing_status: string | null };

async function readCase(id: string): Promise<CaseRow | undefined> {
  const result = await db.asAdmin((query) =>
    query(`select id, tax_year, organization_id, created_by, created_at::text as created_at, filing_status from tax_preparation_cases where id = $1`, [id]),
  );
  return result.rows[0] as CaseRow | undefined;
}

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin((query) =>
    query(`insert into auth.users (id, email) values ($1, 'owner@example.test'), ($2, 'member@example.test'), ($3, 'other-owner@example.test')`, [
      OWNER,
      SOMEONE_ELSE,
      OTHER_OWNER,
    ]),
  );

  await db.asUser(OWNER);
  orgA = ((await db.query(`insert into organizations (name, entity_type, created_by) values ('Test A', 'personal', $1) returning id`, [OWNER])).rows[0] as { id: string }).id;
  // A second workspace the SAME person owns — the realistic way to try to move a case.
  orgB = ((await db.query(`insert into organizations (name, entity_type, created_by) values ('Test B', 'personal', $1) returning id`, [OWNER])).rows[0] as { id: string }).id;

  await db.asUser(OTHER_OWNER);
  orgOther = ((await db.query(`insert into organizations (name, entity_type, created_by) values ('Someone else', 'personal', $1) returning id`, [OTHER_OWNER])).rows[0] as { id: string }).id;

  caseA = await db.asAdmin(async (query) => {
    const result = await query(
      `insert into tax_preparation_cases (organization_id, tax_year, status, filing_status, primary_state_region, created_by)
       values ($1, 2026, 'COLLECTING', 'single', 'CA', $2) returning id`,
      [orgA, OWNER],
    );
    return (result.rows[0] as { id: string }).id;
  });
});

afterEach(async () => {
  await db.close();
});

/**
 * Every protected column, with a change that would be meaningful. The error
 * must name the column, so a refusal for some other reason (RLS, a foreign key)
 * cannot pass for the trigger working.
 */
const PROTECTED: { column: string; set: string; params: () => unknown[] }[] = [
  { column: "id", set: "id = gen_random_uuid()", params: () => [] },
  { column: "tax_year", set: "tax_year = 2019", params: () => [] },
  { column: "organization_id", set: "organization_id = $2", params: () => [orgB] },
  { column: "created_at", set: "created_at = now() - interval '1 year'", params: () => [] },
  { column: "created_by", set: "created_by = $2", params: () => [SOMEONE_ELSE] },
  { column: "created_by", set: "created_by = null", params: () => [] },
];

async function attempt(actor: "owner" | "service", sql: string, params: unknown[]) {
  if (actor === "service") return db.asAdmin((query) => query(sql, params));
  await db.asUser(OWNER);
  return db.query(sql, params);
}

describe.each([
  ["the signed-in owner (authenticated REST path)", "owner"],
  ["the service role (RLS bypassed)", "service"],
] as const)("protected columns, attempted by %s", (_label, actor) => {
  it.each(PROTECTED)("refuses `set $set`", async ({ column, set, params }) => {
    const before = await readCase(caseA);

    await expect(attempt(actor, `update tax_preparation_cases set ${set} where id = $1`, [caseA, ...params()])).rejects.toThrow(
      new RegExp(`tax_preparation_cases\\.${column} cannot be changed`),
    );
    // Refused means untouched — not partially applied.
    expect(await readCase(caseA)).toEqual(before);
  });
});

describe("no bypass by combining changes in one request", () => {
  it("refuses a protected change hidden alongside a legitimate one, and applies neither", async () => {
    await db.asUser(OWNER);
    await expect(db.query(`update tax_preparation_cases set filing_status = 'married_filing_jointly', tax_year = 2019 where id = $1`, [caseA])).rejects.toThrow(
      /tax_year cannot be changed/,
    );
    const row = await readCase(caseA);
    expect(row?.tax_year).toBe(2026);
    expect(row?.filing_status).toBe("single");
  });

  it("refuses two protected changes at once", async () => {
    await db.asUser(OWNER);
    await expect(db.query(`update tax_preparation_cases set tax_year = 2019, organization_id = $2 where id = $1`, [caseA, orgB])).rejects.toThrow(/cannot be changed/);
    expect((await readCase(caseA))?.organization_id).toBe(orgA);
  });

  it("refuses an upsert that rewrites the year on conflict — what the REST API sends", async () => {
    await db.asUser(OWNER);
    await expect(
      db.query(
        `insert into tax_preparation_cases (id, organization_id, tax_year, created_by) values ($1, $2, 2019, $3)
         on conflict (id) do update set tax_year = excluded.tax_year`,
        [caseA, orgA, OWNER],
      ),
    ).rejects.toThrow(/tax_year cannot be changed/);
    expect((await readCase(caseA))?.tax_year).toBe(2026);
  });

  it("refuses UPDATE … FROM", async () => {
    await db.asUser(OWNER);
    await expect(db.query(`update tax_preparation_cases c set tax_year = v.y from (values (2019)) as v(y) where c.id = $1`, [caseA])).rejects.toThrow(/tax_year cannot be changed/);
  });

  it("refuses a multi-row update and changes none of the rows", async () => {
    const second = await db.asAdmin(async (query) => {
      const result = await query(`insert into tax_preparation_cases (organization_id, tax_year, created_by) values ($1, 2025, $2) returning id`, [orgA, OWNER]);
      return (result.rows[0] as { id: string }).id;
    });

    await db.asUser(OWNER);
    await expect(db.query(`update tax_preparation_cases set tax_year = tax_year - 1 where organization_id = $1`, [orgA])).rejects.toThrow(/tax_year cannot be changed/);
    expect((await readCase(caseA))?.tax_year).toBe(2026);
    expect((await readCase(second))?.tax_year).toBe(2025);
  });
});

describe("the one sanctioned identity change", () => {
  it("still lets the creator's account be deleted, clearing created_by through the foreign key", async () => {
    // The member who opens the case owns no workspace: deleting a workspace
    // OWNER is refused earlier by the separate last-owner guard, which would
    // make this test pass or fail for a reason unrelated to the trigger.
    const openedBySomeoneElse = await db.asAdmin(async (query) => {
      const result = await query(`insert into tax_preparation_cases (organization_id, tax_year, status, created_by) values ($1, 2025, 'COLLECTING', $2) returning id`, [
        orgA,
        SOMEONE_ELSE,
      ]);
      return (result.rows[0] as { id: string }).id;
    });

    await db.asAdmin((query) => query(`delete from auth.users where id = $1`, [SOMEONE_ELSE]));

    const row = await readCase(openedBySomeoneElse);
    expect(row?.created_by).toBeNull();
    expect(row?.tax_year).toBe(2025);
  });
});

describe("normal operation is unaffected", () => {
  it("allows inserting and reading a case", async () => {
    await db.asUser(OWNER);
    const inserted = await db.query(`insert into tax_preparation_cases (organization_id, tax_year, created_by) values ($1, 2025, $2) returning id`, [orgA, OWNER]);
    const read = await db.query(`select tax_year from tax_preparation_cases where id = $1`, [(inserted.rows[0] as { id: string }).id]);
    expect(read.rows).toEqual([{ tax_year: 2025 }]);
  });

  it("allows every field the application legitimately updates", async () => {
    await db.asUser(OWNER);
    const result = await db.query(
      `update tax_preparation_cases set
         status = 'CALCULATED', filing_status = 'head_of_household',
         legal_first_name = 'Test', legal_middle_name = 'Q', legal_last_name = 'Taxpayer', date_of_birth = '1985-04-12',
         tax_identifier_type = 'ssn', tax_identifier_on_file = true,
         primary_state_region = 'AZ', additional_state_regions = array['NY']::char(2)[],
         spouse_first_name = 'Pat', spouse_last_name = 'Taxpayer', spouse_date_of_birth = '1986-01-01', spouse_tax_identifier_on_file = true,
         current_version = 3, completed_at = now()
       where id = $1
       returning status, filing_status, legal_last_name, primary_state_region, current_version, tax_year, organization_id`,
      [caseA],
    );
    expect(result.rows[0]).toEqual({
      status: "CALCULATED",
      filing_status: "head_of_household",
      legal_last_name: "Taxpayer",
      primary_state_region: "AZ",
      current_version: 3,
      tax_year: 2026,
      organization_id: orgA,
    });
  });

  it("allows an update that repeats the unchanged identity values", async () => {
    // A client that sends the whole row back unchanged must not be refused.
    const before = await readCase(caseA);
    await db.asUser(OWNER);
    const result = await db.query(
      `update tax_preparation_cases set id = $1, tax_year = 2026, organization_id = $2, created_by = $3, created_at = created_at where id = $1 returning id`,
      [caseA, orgA, OWNER],
    );
    expect(result.rows).toHaveLength(1);
    expect((await readCase(caseA))?.created_at).toBe(before?.created_at);
  });

  it("allows archiving", async () => {
    await db.asUser(OWNER);
    const result = await db.query(`update tax_preparation_cases set status = 'ARCHIVED', completed_at = now() where id = $1 returning status`, [caseA]);
    expect((result.rows[0] as { status: string }).status).toBe("ARCHIVED");
  });

  it("allows recording, superseding and reading facts for the case", async () => {
    await db.asUser(OWNER);
    const proposed = await db.query(
      `insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, currency, source, state)
       values ($1, $2, 1, 'W2_WAGES', 8500000, 'USD', 'AI_PROPOSED', 'PROPOSED') returning id`,
      [orgA, caseA],
    );
    await db.query(
      `insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, currency, source, state, supersedes_fact_id, created_by)
       values ($1, $2, 1, 'W2_WAGES', 8500000, 'USD', 'AI_PROPOSED', 'CONFIRMED', $3, $4)`,
      [orgA, caseA, (proposed.rows[0] as { id: string }).id, OWNER],
    );
    const facts = await db.query(`select state from tax_preparation_facts where case_id = $1`, [caseA]);
    expect(facts.rows.map((row) => (row as { state: string }).state).sort()).toEqual(["CONFIRMED", "PROPOSED"]);
  });

  it("allows dependents to be added and edited", async () => {
    await db.asUser(OWNER);
    const added = await db.query(
      `insert into tax_preparation_dependents (organization_id, case_id, first_name, last_name, relationship) values ($1, $2, 'Sam', 'Taxpayer', 'child') returning id`,
      [orgA, caseA],
    );
    const edited = await db.query(`update tax_preparation_dependents set first_name = 'Samuel' where id = $1 returning first_name`, [(added.rows[0] as { id: string }).id]);
    expect(edited.rows).toEqual([{ first_name: "Samuel" }]);
  });
});

describe("cross-organization integrity", () => {
  it("does not let another workspace's owner touch the case at all", async () => {
    await db.asUser(OTHER_OWNER);
    const result = await db.query(`update tax_preparation_cases set filing_status = 'single' where id = $1 returning id`, [caseA]);
    // RLS hides the row entirely: zero rows, before the trigger is even reached.
    expect(result.rows).toHaveLength(0);
  });

  it("refuses to move a case into a workspace the actor does not belong to", async () => {
    await db.asUser(OWNER);
    // Either RLS's WITH CHECK or the trigger may refuse first; both are refusals.
    await expect(db.query(`update tax_preparation_cases set organization_id = $2 where id = $1`, [caseA, orgOther])).rejects.toThrow();
    expect((await readCase(caseA))?.organization_id).toBe(orgA);
  });

  it("still refuses a fact that points at another workspace's case", async () => {
    const otherCase = await db.asAdmin(async (query) => {
      const result = await query(`insert into tax_preparation_cases (organization_id, tax_year, created_by) values ($1, 2026, $2) returning id`, [orgOther, OTHER_OWNER]);
      return (result.rows[0] as { id: string }).id;
    });
    await expect(
      db.asAdmin((query) =>
        query(
          `insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, currency, source, state)
           values ($1, $2, 1, 'W2_WAGES', 100, 'USD', 'USER_ENTERED', 'CONFIRMED')`,
          [orgA, otherCase],
        ),
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe("the migration itself", () => {
  const migration = readFileSync(path.join(process.cwd(), "supabase/migrations/0043_tax_preparation_case_identity.sql"), "utf8");

  it("installs the trigger, enabled, on the cases table", async () => {
    const result = await db.asAdmin((query) =>
      query(`select tgenabled from pg_trigger where tgname = 'tax_preparation_cases_identity_immutable' and tgrelid = 'public.tax_preparation_cases'::regclass`),
    );
    expect(result.rows).toEqual([{ tgenabled: "O" }]);
  });

  it("changes no existing data — no DML, no table alterations", () => {
    // Comment lines stripped, so prose that says "update" cannot trip this.
    const code = migration
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|\balter\s+table\b|\bdrop\s+|\btruncate\b/i);
  });

  it("covers every protected column", () => {
    for (const column of ["id", "tax_year", "organization_id", "created_at", "created_by"]) {
      expect(migration, column).toMatch(new RegExp(`new\\.${column} is distinct from old\\.${column}`));
    }
  });
});
