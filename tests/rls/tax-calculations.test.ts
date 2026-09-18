import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * Stored tax calculations, against real Postgres.
 *
 * Two properties, both of which are database properties and neither of which
 * a mock could demonstrate:
 *
 *   ISOLATION — a tax figure is among the most sensitive rows an
 *   organization has. Another workspace must not see one.
 *
 *   IMMUTABILITY — the row records what the product told someone under a
 *   named rule-set version. Editing one destroys the only thing it is for,
 *   so 0038 creates no UPDATE and no DELETE policy at all.
 */

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIEWER_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let db: TestDatabase;
let orgA: string;
let orgB: string;

async function insertCalculation(organizationId: string, actor: string, overrides: { version?: string; taxYear?: number } = {}) {
  return db.asAdmin(async (query) => {
    const result = await query(
      `insert into tax_calculations
         (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status,
          rule_set_version, filing_status, currency,
          inputs, totals, trace, total_tax_minor, calculated_by)
       values ($1, 'US_FEDERAL', $2, $2, 'PUBLISHED_RULES', $3, 'single', 'USD',
          '{"ordinaryIncomeMinor": 10000000}'::jsonb,
          '{"incomeTax": 1317000}'::jsonb,
          '[{"key": "taxable_income"}]'::jsonb,
          1317000, $4)
       returning id`,
      [organizationId, overrides.taxYear ?? 2026, overrides.version ?? "2026.1", actor],
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
});

afterEach(async () => {
  await db.close();
});

describe("organization isolation", () => {
  it("lets a member read their own organization's calculations", async () => {
    await insertCalculation(orgA, OWNER_A);

    await db.asUser(OWNER_A);
    const result = await db.query(`select * from tax_calculations where organization_id = $1`, [orgA]);
    expect(result.rows).toHaveLength(1);
  });

  it("HIDES another organization's calculations entirely", async () => {
    await insertCalculation(orgA, OWNER_A);

    await db.asUser(OWNER_B);
    const byOrg = await db.query(`select * from tax_calculations where organization_id = $1`, [orgA]);
    const unscoped = await db.query(`select * from tax_calculations`);

    expect(byOrg.rows).toHaveLength(0);
    // Even an unscoped read returns nothing — RLS, not the WHERE clause, is
    // what keeps them apart.
    expect(unscoped.rows).toHaveLength(0);
  });

  it("lets a viewer read but not create", async () => {
    // Reading the workspace's tax position is ordinary member access.
    await insertCalculation(orgA, OWNER_A);
    await db.asUser(VIEWER_A);
    expect((await db.query(`select * from tax_calculations`)).rows).toHaveLength(1);

    // Producing one is a financial write.
    await expect(
      db.query(
        `insert into tax_calculations (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status,
            rule_set_version, filing_status, currency, inputs, totals, trace, total_tax_minor)
         values ($1, 'US_FEDERAL', 2026, 2026, 'PUBLISHED_RULES', '2026.1', 'single', 'USD', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 0)`,
        [orgA],
      ),
    ).rejects.toThrow();
  });

  it("refuses a member inserting into another organization", async () => {
    await db.asUser(OWNER_A);
    await expect(
      db.query(
        `insert into tax_calculations (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status,
            rule_set_version, filing_status, currency, inputs, totals, trace, total_tax_minor)
         values ($1, 'US_FEDERAL', 2026, 2026, 'PUBLISHED_RULES', '2026.1', 'single', 'USD', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 0)`,
        [orgB],
      ),
    ).rejects.toThrow();
  });
});

describe("a stored calculation is immutable", () => {
  it("cannot be updated by the member who created it", async () => {
    const id = await insertCalculation(orgA, OWNER_A);

    await db.asUser(OWNER_A);
    // No UPDATE policy: RLS matches zero rows rather than erroring, so the
    // assertion is that nothing changed.
    await db.query(`update tax_calculations set total_tax_minor = 1 where id = $1`, [id]);

    const row = await db.asAdmin(async (query) => (await query(`select total_tax_minor from tax_calculations where id = $1`, [id])).rows[0]);
    expect(Number((row as { total_tax_minor: number }).total_tax_minor)).toBe(1317000);
  });

  it("cannot have its rule-set version rewritten", async () => {
    // The single most important field: rewriting it would make a historical
    // result claim it was computed under rules it never saw.
    const id = await insertCalculation(orgA, OWNER_A);

    await db.asUser(OWNER_A);
    await db.query(`update tax_calculations set rule_set_version = '2026.9' where id = $1`, [id]);

    const row = await db.asAdmin(async (query) => (await query(`select rule_set_version from tax_calculations where id = $1`, [id])).rows[0]);
    expect((row as { rule_set_version: string }).rule_set_version).toBe("2026.1");
  });

  it("cannot be deleted by a member", async () => {
    const id = await insertCalculation(orgA, OWNER_A);

    await db.asUser(OWNER_A);
    await db.query(`delete from tax_calculations where id = $1`, [id]);

    expect(await db.asAdmin(async (query) => (await query(`select count(*)::int as n from tax_calculations`)).rows[0])).toEqual({ n: 1 });
  });
});

describe("the version stamp", () => {
  it("records different versions side by side", async () => {
    // What reproducibility looks like in practice: an old result keeps its
    // own version after a correction, rather than being restated.
    await insertCalculation(orgA, OWNER_A, { version: "2026.1" });
    await insertCalculation(orgA, OWNER_A, { version: "2026.2" });

    const rows = await db.asAdmin(async (query) => (await query(`select rule_set_version from tax_calculations order by rule_set_version`)).rows);
    expect(rows.map((r) => (r as { rule_set_version: string }).rule_set_version)).toEqual(["2026.1", "2026.2"]);
  });

  it("requires a version on every row", async () => {
    await expect(
      db.asAdmin((query) =>
        query(
          `insert into tax_calculations (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status,
              filing_status, currency, inputs, totals, trace, total_tax_minor)
           values ($1, 'US_FEDERAL', 2026, 2026, 'PUBLISHED_RULES', 'single', 'USD', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 0)`,
          [orgA],
        ),
      ),
    ).rejects.toThrow();
  });

  it("refuses an impossible tax year", async () => {
    await expect(insertCalculation(orgA, OWNER_A, { taxYear: 99_999 })).rejects.toThrow();
  });

  it("survives the deletion of the user who ran it", async () => {
    // Attribution detaches; the calculation itself is organization data and
    // must outlive an account deletion. Run as the non-owner member — the
    // owner cannot be deleted while the workspace has other members, which
    // is a separate rule (tests/rls/deletion-graph.test.ts).
    const id = await insertCalculation(orgA, VIEWER_A);

    await db.asAdmin(async (query) => {
      await query(`delete from ai_conversations where user_id = $1`, [VIEWER_A]);
      await query(`delete from auth.users where id = $1`, [VIEWER_A]);

      const row = (await query(`select calculated_by, total_tax_minor from tax_calculations where id = $1`, [id])).rows[0];
      expect((row as { calculated_by: string | null }).calculated_by).toBeNull();
      expect(Number((row as { total_tax_minor: number }).total_tax_minor)).toBe(1317000);
    });
  });
});

describe("the requested year is recorded separately from the rules that ran", () => {
  it("stores both years when a disclosed fallback produced the figure", async () => {
    const id = await db.asAdmin(async (query) => {
      const result = await query(
        `insert into tax_calculations (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status,
            rule_set_version, filing_status, currency, inputs, totals, trace, total_tax_minor)
         values ($1, 'US_CA', 2025, 2026, 'ESTIMATE_USING_LATEST_PUBLISHED_RULES', '2025.1', 'single', 'USD',
            '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 520900)
         returning id`,
        [orgA],
      );
      return (result.rows[0] as { id: string }).id;
    });

    const row = await db.asAdmin(
      async (query) =>
        (await query(`select tax_year, requested_tax_year, calculation_status from tax_calculations where id = $1`, [id])).rows[0] as {
          tax_year: number;
          requested_tax_year: number;
          calculation_status: string;
        },
    );

    // The distinction survives the write. A row that recorded only one year
    // would later be read as an authoritative 2026 calculation.
    expect(Number(row.tax_year)).toBe(2025);
    expect(Number(row.requested_tax_year)).toBe(2026);
    expect(row.calculation_status).toBe("ESTIMATE_USING_LATEST_PUBLISHED_RULES");
  });

  it("refuses an unrecognised calculation status", async () => {
    // Free text here would let a bad writer record something that reads as
    // "probably authoritative" to anyone querying the table.
    await expect(
      db.asAdmin((query) =>
        query(
          `insert into tax_calculations (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status,
              rule_set_version, filing_status, currency, inputs, totals, trace, total_tax_minor)
           values ($1, 'US_CA', 2025, 2026, 'DEFINITELY_FINE', '2025.1', 'single', 'USD', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 0)`,
          [orgA],
        ),
      ),
    ).rejects.toThrow();
  });

  it("refuses an impossible requested year", async () => {
    await expect(
      db.asAdmin((query) =>
        query(
          `insert into tax_calculations (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status,
              rule_set_version, filing_status, currency, inputs, totals, trace, total_tax_minor)
           values ($1, 'US_CA', 2025, 99999, 'PUBLISHED_RULES', '2025.1', 'single', 'USD', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 0)`,
          [orgA],
        ),
      ),
    ).rejects.toThrow();
  });

  it("still refuses a row with no requested year at all", async () => {
    await expect(
      db.asAdmin((query) =>
        query(
          `insert into tax_calculations (organization_id, jurisdiction, tax_year, calculation_status,
              rule_set_version, filing_status, currency, inputs, totals, trace, total_tax_minor)
           values ($1, 'US_CA', 2025, 'PUBLISHED_RULES', '2025.1', 'single', 'USD', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 0)`,
          [orgA],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("a New York calculation is stored like any other, and isolated like any other", () => {
  async function insertNewYork(organizationId: string) {
    return db.asAdmin(async (query) => {
      const result = await query(
        `insert into tax_calculations (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status,
            rule_set_version, filing_status, currency, inputs, totals, trace, total_tax_minor)
         values ($1, 'US_NY', 2026, 2026, 'PUBLISHED_RULES', '2026.1', 'single', 'USD',
            '{"federalAdjustedGrossIncomeMinor": 6000000}'::jsonb,
            '{"incomeTax": 264340}'::jsonb,
            '[{"key": "ny_taxable_income"}]'::jsonb,
            264340)
         returning id`,
        [organizationId],
      );
      return (result.rows[0] as { id: string }).id;
    });
  }

  it("needs no new table or column — the existing stamp carries the jurisdiction", async () => {
    const id = await insertNewYork(orgA);
    const row = await db.asAdmin(
      async (query) =>
        (await query(`select jurisdiction, tax_year, calculation_status, total_tax_minor from tax_calculations where id = $1`, [id])).rows[0] as {
          jurisdiction: string;
          tax_year: number;
          calculation_status: string;
          total_tax_minor: number;
        },
    );
    expect(row.jurisdiction).toBe("US_NY");
    expect(Number(row.tax_year)).toBe(2026);
    expect(row.calculation_status).toBe("PUBLISHED_RULES");
    expect(Number(row.total_tax_minor)).toBe(264340);
  });

  it("is readable by its own organization's members", async () => {
    const id = await insertNewYork(orgA);
    await db.asUser(OWNER_A);
    const rows = (await db.query(`select id from tax_calculations where id = $1`, [id])).rows;
    expect(rows).toHaveLength(1);
  });

  it("is invisible to another organization", async () => {
    const id = await insertNewYork(orgA);
    await db.asUser(OWNER_B);
    const rows = (await db.query(`select id from tax_calculations where id = $1`, [id])).rows;
    expect(rows).toHaveLength(0);
  });

  it("is immutable, like every other stored calculation", async () => {
    const id = await insertNewYork(orgA);
    await db.asUser(OWNER_A);
    await db.query(`update tax_calculations set total_tax_minor = 1 where id = $1`, [id]);

    const row = await db.asAdmin(async (query) => (await query(`select total_tax_minor from tax_calculations where id = $1`, [id])).rows[0]);
    expect(Number((row as { total_tax_minor: number }).total_tax_minor)).toBe(264340);
  });

  it("cannot be written into another organization by a member", async () => {
    await db.asUser(OWNER_A);
    await expect(
      db.query(
        `insert into tax_calculations (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status,
            rule_set_version, filing_status, currency, inputs, totals, trace, total_tax_minor)
         values ($1, 'US_NY', 2026, 2026, 'PUBLISHED_RULES', '2026.1', 'single', 'USD', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 0)`,
        [orgB],
      ),
    ).rejects.toThrow();
  });
});

describe("a Florida $0 calculation is stored, scoped and immutable like any other", () => {
  async function insertFlorida(organizationId: string) {
    return db.asAdmin(async (query) => {
      const result = await query(
        `insert into tax_calculations (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status,
            rule_set_version, filing_status, currency, inputs, totals, trace, total_tax_minor)
         values ($1, 'US_FL', 2026, 2026, 'PUBLISHED_RULES', '2026.1', 'single', 'USD',
            '{}'::jsonb,
            '{"incomeTax": 0, "totalTax": 0}'::jsonb,
            '[{"key": "fl_no_individual_income_tax"}]'::jsonb,
            0)
         returning id`,
        [organizationId],
      );
      return (result.rows[0] as { id: string }).id;
    });
  }

  it("needs no new table or column — a $0 row is an ordinary row", async () => {
    const id = await insertFlorida(orgA);
    const row = await db.asAdmin(
      async (query) =>
        (await query(`select jurisdiction, total_tax_minor, calculation_status from tax_calculations where id = $1`, [id])).rows[0] as {
          jurisdiction: string;
          total_tax_minor: number;
          calculation_status: string;
        },
    );
    expect(row.jurisdiction).toBe("US_FL");
    expect(Number(row.total_tax_minor)).toBe(0);
    expect(row.calculation_status).toBe("PUBLISHED_RULES");
  });

  it("is readable by its own organization's members", async () => {
    const id = await insertFlorida(orgA);
    await db.asUser(OWNER_A);
    expect((await db.query(`select id from tax_calculations where id = $1`, [id])).rows).toHaveLength(1);
  });

  it("is invisible to another organization", async () => {
    const id = await insertFlorida(orgA);
    await db.asUser(OWNER_B);
    expect((await db.query(`select id from tax_calculations where id = $1`, [id])).rows).toHaveLength(0);
  });

  it("cannot be edited into a non-zero liability", async () => {
    // The immutability rule matters more here, not less: a $0 row silently
    // becoming non-zero is the kind of edit nobody would notice.
    const id = await insertFlorida(orgA);
    await db.asUser(OWNER_A);
    await db.query(`update tax_calculations set total_tax_minor = 999999 where id = $1`, [id]);

    const row = await db.asAdmin(async (query) => (await query(`select total_tax_minor from tax_calculations where id = $1`, [id])).rows[0]);
    expect(Number((row as { total_tax_minor: number }).total_tax_minor)).toBe(0);
  });

  it("cannot be written into another organization by a member", async () => {
    await db.asUser(OWNER_A);
    await expect(
      db.query(
        `insert into tax_calculations (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status,
            rule_set_version, filing_status, currency, inputs, totals, trace, total_tax_minor)
         values ($1, 'US_FL', 2026, 2026, 'PUBLISHED_RULES', '2026.1', 'single', 'USD', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 0)`,
        [orgB],
      ),
    ).rejects.toThrow();
  });
});

describe("a Texas $0 calculation stores and isolates like any other, and stays distinct from Florida", () => {
  async function insertZeroState(organizationId: string, jurisdiction: "US_TX" | "US_FL") {
    return db.asAdmin(async (query) => {
      const result = await query(
        `insert into tax_calculations (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status,
            rule_set_version, filing_status, currency, inputs, totals, trace, total_tax_minor)
         values ($1, $2, 2026, 2026, 'PUBLISHED_RULES', '2026.1', 'single', 'USD',
            '{}'::jsonb, '{"incomeTax": 0, "totalTax": 0}'::jsonb, '[{"key": "no_individual_income_tax"}]'::jsonb, 0)
         returning id`,
        [organizationId, jurisdiction],
      );
      return (result.rows[0] as { id: string }).id;
    });
  }

  it("needs no new table or column", async () => {
    const id = await insertZeroState(orgA, "US_TX");
    const row = await db.asAdmin(
      async (query) =>
        (await query(`select jurisdiction, total_tax_minor, calculation_status from tax_calculations where id = $1`, [id])).rows[0] as {
          jurisdiction: string;
          total_tax_minor: number;
          calculation_status: string;
        },
    );
    expect(row.jurisdiction).toBe("US_TX");
    expect(Number(row.total_tax_minor)).toBe(0);
    expect(row.calculation_status).toBe("PUBLISHED_RULES");
  });

  it("stays a separate row from a Florida calculation in the same organization", async () => {
    // Two states, same number, same year. They must remain distinguishable
    // in storage — a report grouped by jurisdiction depends on it.
    await insertZeroState(orgA, "US_TX");
    await insertZeroState(orgA, "US_FL");
    const rows = await db.asAdmin(
      async (query) =>
        (await query(`select jurisdiction from tax_calculations where organization_id = $1 and jurisdiction in ('US_TX','US_FL') order by jurisdiction`, [orgA])).rows as {
          jurisdiction: string;
        }[],
    );
    expect(rows.map((r) => r.jurisdiction)).toEqual(["US_FL", "US_TX"]);
  });

  it("is readable by its own organization's members", async () => {
    const id = await insertZeroState(orgA, "US_TX");
    await db.asUser(OWNER_A);
    expect((await db.query(`select id from tax_calculations where id = $1`, [id])).rows).toHaveLength(1);
  });

  it("is invisible to another organization", async () => {
    const id = await insertZeroState(orgA, "US_TX");
    await db.asUser(OWNER_B);
    expect((await db.query(`select id from tax_calculations where id = $1`, [id])).rows).toHaveLength(0);
  });

  it("cannot be edited into a non-zero liability", async () => {
    const id = await insertZeroState(orgA, "US_TX");
    await db.asUser(OWNER_A);
    await db.query(`update tax_calculations set total_tax_minor = 123456 where id = $1`, [id]);

    const row = await db.asAdmin(async (query) => (await query(`select total_tax_minor from tax_calculations where id = $1`, [id])).rows[0]);
    expect(Number((row as { total_tax_minor: number }).total_tax_minor)).toBe(0);
  });

  it("cannot be written into another organization by a member", async () => {
    await db.asUser(OWNER_A);
    await expect(
      db.query(
        `insert into tax_calculations (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status,
            rule_set_version, filing_status, currency, inputs, totals, trace, total_tax_minor)
         values ($1, 'US_TX', 2026, 2026, 'PUBLISHED_RULES', '2026.1', 'single', 'USD', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 0)`,
        [orgB],
      ),
    ).rejects.toThrow();
  });
});

describe("the table is ready for Arizona, which does not write rows yet", () => {
  // Arizona's engine refuses for 2026 — its standard deduction is unpublished
  // — so nothing writes a US_AZ row today. What is verified here is that the
  // existing table needs no change when it does, and that such a row obeys
  // the same scoping and immutability as every other.
  async function insertArizona(organizationId: string) {
    return db.asAdmin(async (query) => {
      const result = await query(
        `insert into tax_calculations (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status,
            rule_set_version, filing_status, currency, inputs, totals, trace, total_tax_minor)
         values ($1, 'US_AZ', 2026, 2026, 'PUBLISHED_RULES', '2026.1', 'single', 'USD',
            '{"federalAdjustedGrossIncomeMinor": 12000000}'::jsonb,
            '{"incomeTax": 259750, "totalTax": 259750}'::jsonb,
            '[{"key": "az_taxable_income"}]'::jsonb,
            259750)
         returning id`,
        [organizationId],
      );
      return (result.rows[0] as { id: string }).id;
    });
  }

  it("accepts a US_AZ row on the existing schema, with no migration", async () => {
    const id = await insertArizona(orgA);
    const row = await db.asAdmin(
      async (query) =>
        (await query(`select jurisdiction, tax_year, calculation_status from tax_calculations where id = $1`, [id])).rows[0] as {
          jurisdiction: string;
          tax_year: number;
          calculation_status: string;
        },
    );
    expect(row.jurisdiction).toBe("US_AZ");
    expect(Number(row.tax_year)).toBe(2026);
    expect(row.calculation_status).toBe("PUBLISHED_RULES");
  });

  it("is readable by its own organization and invisible to another", async () => {
    const id = await insertArizona(orgA);
    await db.asUser(OWNER_A);
    expect((await db.query(`select id from tax_calculations where id = $1`, [id])).rows).toHaveLength(1);
    await db.asUser(OWNER_B);
    expect((await db.query(`select id from tax_calculations where id = $1`, [id])).rows).toHaveLength(0);
  });

  it("cannot have its tax result edited from one value to another", async () => {
    const id = await insertArizona(orgA);
    await db.asUser(OWNER_A);
    await db.query(`update tax_calculations set total_tax_minor = 1 where id = $1`, [id]);

    const row = await db.asAdmin(async (query) => (await query(`select total_tax_minor from tax_calculations where id = $1`, [id])).rows[0]);
    expect(Number((row as { total_tax_minor: number }).total_tax_minor)).toBe(259750);
  });

  it("cannot be written into another organization by a member", async () => {
    await db.asUser(OWNER_A);
    await expect(
      db.query(
        `insert into tax_calculations (organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status,
            rule_set_version, filing_status, currency, inputs, totals, trace, total_tax_minor)
         values ($1, 'US_AZ', 2026, 2026, 'PUBLISHED_RULES', '2026.1', 'single', 'USD', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 0)`,
        [orgB],
      ),
    ).rejects.toThrow();
  });
});
