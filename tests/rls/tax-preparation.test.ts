import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * Tax preparation tables, against real Postgres.
 *
 * Everything here is a DATABASE property. A mock would prove nothing: the
 * question is whether Postgres itself refuses, because Postgres is the only
 * layer an attacker cannot route around, and because application code that
 * "remembers to check" is exactly the code that eventually forgets.
 *
 * Four properties are asserted:
 *
 *   ISOLATION       another workspace cannot read or write a case, a fact, a
 *                   dependent or a snapshot.
 *   IMMUTABILITY    facts and snapshots have no UPDATE and no DELETE policy,
 *                   so an AI proposal and the person who accepted it stay
 *                   separately attributable forever.
 *   TENANT INTEGRITY a fact cannot point at another organization's case or
 *                   another organization's document, enforced by composite
 *                   foreign keys rather than by application code.
 *   LEAST PRIVILEGE a viewer reads and cannot write.
 */

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIEWER_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let db: TestDatabase;
let orgA: string;
let orgB: string;
let caseA: string;
let caseB: string;

async function createCase(organizationId: string, actor: string, taxYear = 2026) {
  return db.asAdmin(async (query) => {
    const result = await query(
      `insert into tax_preparation_cases (organization_id, tax_year, status, filing_status, legal_first_name, legal_last_name, primary_state_region, created_by)
       values ($1, $2, 'COLLECTING', 'single', 'Dana', 'Okafor', 'CA', $3) returning id`,
      [organizationId, taxYear, actor],
    );
    return (result.rows[0] as { id: string }).id;
  });
}

async function createFact(organizationId: string, targetCaseId: string, actor: string, overrides: { state?: string; source?: string; amount?: number } = {}) {
  return db.asAdmin(async (query) => {
    const result = await query(
      `insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, currency, source, state, created_by)
       values ($1, $2, 1, 'W2_WAGES', $3, 'USD', $4, $5, $6) returning id`,
      [organizationId, targetCaseId, overrides.amount ?? 8_500_000, overrides.source ?? "USER_ENTERED", overrides.state ?? "CONFIRMED", actor],
    );
    return (result.rows[0] as { id: string }).id;
  });
}

async function createSnapshot(organizationId: string, targetCaseId: string, actor: string, version = 1) {
  return db.asAdmin(async (query) => {
    const result = await query(
      `insert into tax_preparation_snapshots (organization_id, case_id, version, tax_year, filing_status, jurisdictions, payload, created_by)
       values ($1, $2, $3, 2026, 'single', array['US_FEDERAL','US_CA'], '{"facts":[]}'::jsonb, $4) returning id`,
      [organizationId, targetCaseId, version, actor],
    );
    return (result.rows[0] as { id: string }).id;
  });
}

beforeEach(async () => {
  db = await createTestDatabase();

  await db.asAdmin((query) =>
    query(`insert into auth.users (id, email) values ($1, 'a@example.test'), ($2, 'b@example.test'), ($3, 'v@example.test')`, [OWNER_A, OWNER_B, VIEWER_A]),
  );

  await db.asUser(OWNER_A);
  orgA = ((await db.query(`insert into organizations (name, entity_type, created_by) values ('Acme', 'freelancer', $1) returning id`, [OWNER_A])).rows[0] as { id: string }).id;

  await db.asUser(OWNER_B);
  orgB = ((await db.query(`insert into organizations (name, entity_type, created_by) values ('Rival', 'business', $1) returning id`, [OWNER_B])).rows[0] as { id: string }).id;

  await db.asAdmin((query) => query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'viewer')`, [orgA, VIEWER_A]));

  caseA = await createCase(orgA, OWNER_A);
  caseB = await createCase(orgB, OWNER_B);
});

afterEach(async () => {
  await db.close();
});

describe("tenant isolation", () => {
  it("hides another organization's preparation case", async () => {
    await db.asUser(OWNER_B);
    const result = await db.query(`select id from tax_preparation_cases where id = $1`, [caseA]);
    expect(result.rows).toHaveLength(0);
  });

  it("shows a member their own organization's case", async () => {
    await db.asUser(OWNER_A);
    const result = await db.query(`select id from tax_preparation_cases where id = $1`, [caseA]);
    expect(result.rows).toHaveLength(1);
  });

  it("hides another organization's facts", async () => {
    await createFact(orgA, caseA, OWNER_A);
    await db.asUser(OWNER_B);
    const result = await db.query(`select id from tax_preparation_facts`);
    expect(result.rows).toHaveLength(0);
  });

  it("hides another organization's dependents", async () => {
    await db.asAdmin((query) =>
      query(`insert into tax_preparation_dependents (organization_id, case_id, first_name, last_name, relationship) values ($1, $2, 'Sam', 'Okafor', 'child')`, [orgA, caseA]),
    );
    await db.asUser(OWNER_B);
    expect((await db.query(`select id from tax_preparation_dependents`)).rows).toHaveLength(0);
  });

  it("hides another organization's snapshots", async () => {
    await createSnapshot(orgA, caseA, OWNER_A);
    await db.asUser(OWNER_B);
    expect((await db.query(`select id from tax_preparation_snapshots`)).rows).toHaveLength(0);
  });

  it("refuses an update to another organization's case", async () => {
    await db.asUser(OWNER_B);
    const result = await db.query(`update tax_preparation_cases set status = 'ARCHIVED' where id = $1 returning id`, [caseA]);
    // Zero rows, not an error: RLS makes the row invisible rather than
    // announcing that it exists.
    expect(result.rows).toHaveLength(0);
  });

  it("refuses to insert a case into another organization", async () => {
    await db.asUser(OWNER_B);
    await expect(
      db.query(`insert into tax_preparation_cases (organization_id, tax_year, created_by) values ($1, 2026, $2)`, [orgA, OWNER_B]),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("immutability", () => {
  it("refuses to update a fact", async () => {
    const factId = await createFact(orgA, caseA, OWNER_A);
    await db.asUser(OWNER_A);
    // The owner of the workspace, who inserted it, still cannot change it.
    // Confirming a value is a new row, so nothing legitimate needs UPDATE.
    const result = await db.query(`update tax_preparation_facts set amount_minor = 1 where id = $1 returning id`, [factId]);
    expect(result.rows).toHaveLength(0);
  });

  it("refuses to delete a fact", async () => {
    const factId = await createFact(orgA, caseA, OWNER_A);
    await db.asUser(OWNER_A);
    expect((await db.query(`delete from tax_preparation_facts where id = $1 returning id`, [factId])).rows).toHaveLength(0);
  });

  it("refuses to update a snapshot", async () => {
    const snapshotId = await createSnapshot(orgA, caseA, OWNER_A);
    await db.asUser(OWNER_A);
    const result = await db.query(`update tax_preparation_snapshots set payload = '{}'::jsonb where id = $1 returning id`, [snapshotId]);
    expect(result.rows).toHaveLength(0);
  });

  it("refuses to delete a snapshot", async () => {
    const snapshotId = await createSnapshot(orgA, caseA, OWNER_A);
    await db.asUser(OWNER_A);
    expect((await db.query(`delete from tax_preparation_snapshots where id = $1 returning id`, [snapshotId])).rows).toHaveLength(0);
  });

  it("keeps the proposal and the confirmation as separate attributable rows", async () => {
    const proposed = await createFact(orgA, caseA, null as unknown as string, { state: "PROPOSED", source: "AI_PROPOSED" });

    // A person accepts it: a NEW row, with the reviewer recorded on it.
    await db.asAdmin((query) =>
      query(
        `insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, currency, source, state, supersedes_fact_id, created_by)
         values ($1, $2, 1, 'W2_WAGES', 8500000, 'USD', 'AI_PROPOSED', 'CONFIRMED', $3, $4)`,
        [orgA, caseA, proposed, OWNER_A],
      ),
    );

    await db.asUser(OWNER_A);
    const rows = (await db.query(`select state, created_by from tax_preparation_facts order by state`)).rows as { state: string; created_by: string | null }[];

    expect(rows).toHaveLength(2);
    // The proposal still says no person made it. That is the whole point:
    // an UPDATE would have overwritten this with the reviewer's id.
    expect(rows.find((row) => row.state === "PROPOSED")?.created_by).toBeNull();
    expect(rows.find((row) => row.state === "CONFIRMED")?.created_by).toBe(OWNER_A);
  });

  it("allows only one row to supersede a given fact", async () => {
    const proposed = await createFact(orgA, caseA, OWNER_A, { state: "PROPOSED" });
    const supersede = () =>
      db.asAdmin((query) =>
        query(
          `insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, currency, source, state, supersedes_fact_id, created_by)
           values ($1, $2, 1, 'W2_WAGES', 8500000, 'USD', 'USER_ENTERED', 'CONFIRMED', $3, $4)`,
          [orgA, caseA, proposed, OWNER_A],
        ),
      );

    await supersede();
    // Two concurrent confirmations of the same proposal would otherwise both
    // land, and the snapshot would carry the figure twice.
    await expect(supersede()).rejects.toThrow(/unique|duplicate/i);
  });
});

describe("tenant integrity, enforced by Postgres", () => {
  it("refuses a fact pointing at another organization's case", async () => {
    await expect(
      db.asAdmin((query) =>
        query(
          `insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, currency, source, state)
           values ($1, $2, 1, 'W2_WAGES', 100, 'USD', 'USER_ENTERED', 'CONFIRMED')`,
          [orgA, caseB],
        ),
      ),
      // Superuser, RLS bypassed entirely — so this is the foreign key
      // itself refusing, not a policy.
    ).rejects.toThrow(/foreign key/i);
  });

  it("refuses a fact whose evidence document belongs to another organization", async () => {
    const foreignDocument = await db.asAdmin(async (query) => {
      const result = await query(`insert into documents (organization_id, storage_path) values ($1, 'b/w2.pdf') returning id`, [orgB]);
      return (result.rows[0] as { id: string }).id;
    });

    await expect(
      db.asAdmin((query) =>
        query(
          `insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, currency, source, state, evidence_document_id)
           values ($1, $2, 1, 'W2_WAGES', 100, 'USD', 'DOCUMENT', 'CONFIRMED', $3)`,
          [orgA, caseA, foreignDocument],
        ),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("breaks the evidence link rather than the figure when a document is deleted", async () => {
    const document = await db.asAdmin(async (query) => {
      const result = await query(`insert into documents (organization_id, storage_path) values ($1, 'a/w2.pdf') returning id`, [orgA]);
      return (result.rows[0] as { id: string }).id;
    });

    await db.asAdmin((query) =>
      query(
        `insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, currency, source, state, evidence_document_id)
         values ($1, $2, 1, 'W2_WAGES', 8500000, 'USD', 'DOCUMENT', 'CONFIRMED', $3)`,
        [orgA, caseA, document],
      ),
    );

    await db.asAdmin((query) => query(`delete from documents where id = $1`, [document]));

    await db.asUser(OWNER_A);
    const rows = (await db.query(`select amount_minor, evidence_document_id from tax_preparation_facts`)).rows as { amount_minor: string; evidence_document_id: string | null }[];

    // The figure survives; the missing evidence is visible rather than
    // silently still "documented". Validation reports it from here.
    expect(rows).toHaveLength(1);
    expect(rows[0].evidence_document_id).toBeNull();
  });

  it("refuses to delete a snapshot a stored calculation was run against", async () => {
    const snapshotId = await createSnapshot(orgA, caseA, OWNER_A);
    await db.asAdmin((query) =>
      query(
        `insert into tax_calculations
           (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status, rule_set_version,
            filing_status, currency, inputs, totals, trace, total_tax_minor, preparation_snapshot_id)
         values ($1, 'US_FEDERAL', 2026, 2026, 'PUBLISHED_RULES', '2026.1', 'single', 'USD',
            '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 1317000, $2)`,
        [orgA, snapshotId],
      ),
    );

    // A stored figure whose inputs had been deleted would still display,
    // now unexplainable. Postgres refuses to let that happen.
    await expect(db.asAdmin((query) => query(`delete from tax_preparation_snapshots where id = $1`, [snapshotId]))).rejects.toThrow(/foreign key|violates/i);
  });

  it("refuses two snapshots claiming the same case version", async () => {
    await createSnapshot(orgA, caseA, OWNER_A, 1);
    await expect(createSnapshot(orgA, caseA, OWNER_A, 1)).rejects.toThrow(/unique|duplicate/i);
  });

  it("refuses a second live case for the same year, and allows one after archiving", async () => {
    await expect(createCase(orgA, OWNER_A, 2026)).rejects.toThrow(/unique|duplicate/i);

    await db.asAdmin((query) => query(`update tax_preparation_cases set status = 'ARCHIVED' where id = $1`, [caseA]));
    // Re-preparing a year after archiving is a real thing people do.
    await expect(createCase(orgA, OWNER_A, 2026)).resolves.toBeTruthy();
  });

  it("refuses a fact carrying no value at all", async () => {
    await expect(
      db.asAdmin((query) =>
        query(
          `insert into tax_preparation_facts (organization_id, case_id, version, key, source, state)
           values ($1, $2, 1, 'W2_WAGES', 'USER_ENTERED', 'CONFIRMED')`,
          [orgA, caseA],
        ),
      ),
      // A valueless row would reach a snapshot as a silent zero.
    ).rejects.toThrow(/tax_preparation_facts_has_value/);
  });

  it("refuses an amount with no currency", async () => {
    await expect(
      db.asAdmin((query) =>
        query(
          `insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, source, state)
           values ($1, $2, 1, 'W2_WAGES', 100, 'USER_ENTERED', 'CONFIRMED')`,
          [orgA, caseA],
        ),
      ),
    ).rejects.toThrow(/tax_preparation_facts_currency_present/);
  });

  it("refuses an unrecognised fact state", async () => {
    await expect(
      db.asAdmin((query) =>
        query(
          `insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, currency, source, state)
           values ($1, $2, 1, 'W2_WAGES', 100, 'USD', 'USER_ENTERED', 'APPROVED')`,
          [orgA, caseA],
        ),
      ),
      // 'APPROVED' is not a state this system has. An unrecognised one would
      // be read as "probably fine" by anything that queried the table.
    ).rejects.toThrow(/check constraint/i);
  });
});

describe("least privilege", () => {
  it("lets a viewer read the workspace's preparation", async () => {
    await createFact(orgA, caseA, OWNER_A);
    await db.asUser(VIEWER_A);
    expect((await db.query(`select id from tax_preparation_cases`)).rows).toHaveLength(1);
    expect((await db.query(`select id from tax_preparation_facts`)).rows).toHaveLength(1);
  });

  it("stops a viewer creating a case", async () => {
    await db.asUser(VIEWER_A);
    await expect(
      db.query(`insert into tax_preparation_cases (organization_id, tax_year, created_by) values ($1, 2025, $2)`, [orgA, VIEWER_A]),
    ).rejects.toThrow(/row-level security/i);
  });

  it("stops a viewer recording a fact", async () => {
    await db.asUser(VIEWER_A);
    await expect(
      db.query(
        `insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, currency, source, state)
         values ($1, $2, 1, 'W2_WAGES', 100, 'USD', 'USER_ENTERED', 'CONFIRMED')`,
        [orgA, caseA],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("stops a viewer taking a snapshot", async () => {
    await db.asUser(VIEWER_A);
    await expect(
      db.query(
        `insert into tax_preparation_snapshots (organization_id, case_id, version, tax_year, filing_status, jurisdictions, payload)
         values ($1, $2, 1, 2026, 'single', array['US_FEDERAL'], '{}'::jsonb)`,
        [orgA, caseA],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("stops an ordinary member deleting a whole year's preparation", async () => {
    const MEMBER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await db.asAdmin((query) => query(`insert into auth.users (id, email) values ($1, 'm@example.test')`, [MEMBER]));
    await db.asAdmin((query) => query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'employee')`, [orgA, MEMBER]));

    await db.asUser(MEMBER);
    // An employee can collect and correct, but discarding the year is an
    // owner/admin act.
    expect((await db.query(`delete from tax_preparation_cases where id = $1 returning id`, [caseA])).rows).toHaveLength(0);
  });
});

describe("what the schema cannot store", () => {
  it("has no column anywhere that could hold a tax identifier", async () => {
    const result = await db.asAdmin((query) =>
      query(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'public' and table_name like 'tax_preparation%'
           and (column_name like '%ssn%' or column_name like '%tin%' or column_name like '%social_security%'
                or column_name like '%identifier_value%' or column_name like '%tax_id')`,
      ),
    );
    // Not a policy enforced by hope: there is physically nowhere to put one.
    expect(result.rows).toEqual([]);
  });

  it("records only that an identifier exists, and which kind", async () => {
    await db.asUser(OWNER_A);
    const result = await db.query(
      `select column_name from information_schema.columns
       where table_name = 'tax_preparation_cases' and column_name like 'tax_identifier%' order by 1`,
    );
    expect(result.rows.map((row) => (row as { column_name: string }).column_name)).toEqual(["tax_identifier_on_file", "tax_identifier_type"]);
  });
});
