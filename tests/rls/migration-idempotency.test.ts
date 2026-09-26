import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, splitMigrationStatements, type TestDatabase } from "./harness";

/**
 * CAN A MIGRATION BE RE-RUN AGAINST A DATABASE THAT ALREADY HAS ITS EFFECTS?
 *
 * WHY THIS EXISTS
 *
 * Production reached a state the migration files could not describe: every
 * schema effect of 0055 and 0056 was present, neither had a row in
 * `supabase_migrations.schema_migrations`, and `operations_schema_version()`
 * still returned '0054' — the trailing `create or replace` of each file had
 * never run. `supabase db push` then failed on 0055 with
 *
 *   constraint "document_extracted_fields_identity_no_money" ... already exists
 *
 * because two of its `add constraint` statements had no guard in front of
 * them. A migration that cannot be re-run cannot be used to repair drift,
 * which is the one moment it is needed most.
 *
 * WHAT THIS SUITE CHECKS
 *
 * `createTestDatabase()` applies every migration, so the database it returns
 * ALREADY HAS 0055's and 0056's effects — the same starting point production
 * is in. Re-applying the real file from disk, statement by statement, the way
 * the harness applies it, therefore reproduces the exact push that failed.
 *
 * The final schema is asserted afterwards, because "it ran twice" is only half
 * the property: the constraints have to still be there, and still say what the
 * repository says they say.
 */

let db: TestDatabase;

/** Applies one real migration file, statement by statement, as the harness
 *  does. Throws on the first statement Postgres refuses. */
async function reapply(file: string): Promise<number> {
  const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
  const statements = splitMigrationStatements(sql).filter((statement) => !/create extension/i.test(statement));
  await db.asAdmin(async (query) => {
    for (const statement of statements) await query(statement);
  });
  return statements.length;
}

const constraintsOn = (table: string) =>
  db.asAdmin(
    async (query) =>
      (
        await query(
          `select conname, pg_get_constraintdef(oid) as def
             from pg_constraint
            where conrelid = $1::regclass and contype = 'c'
            order by conname`,
          [table],
        )
      ).rows as { conname: string; def: string }[],
  );

const schemaVersion = () => db.asAdmin(async (query) => ((await query(`select operations_schema_version() as v`)).rows[0] as { v: string }).v);

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await db.close();
});

describe("0055, re-applied to a database that already has its effects", () => {
  it("starts from the state production is in: the constraints already exist", async () => {
    const names = (await constraintsOn("document_extracted_fields")).map((row) => row.conname);
    expect(names).toContain("document_extracted_fields_identity_no_money");
    expect(names).toContain("document_extracted_fields_identity_no_identifiers");
  });

  it("re-applies without error, which is what the failed push could not do", async () => {
    // Before the guards were added this threw 42710 on the first of the two.
    const applied = await reapply("0055_document_ocr_identity.sql");
    expect(applied).toBeGreaterThan(0);
  });

  it("re-applies twice over, so a retried push is safe however far the last one got", async () => {
    await reapply("0055_document_ocr_identity.sql");
    await reapply("0055_document_ocr_identity.sql");
    const names = (await constraintsOn("document_extracted_fields")).map((row) => row.conname);
    // Still exactly one of each — a re-run does not accumulate duplicates.
    expect(names.filter((name) => name === "document_extracted_fields_identity_no_money")).toHaveLength(1);
    expect(names.filter((name) => name === "document_extracted_fields_identity_no_identifiers")).toHaveLength(1);
  });

  it("leaves every identity protection in place, with the definition the repository states", async () => {
    await reapply("0055_document_ocr_identity.sql");
    const byName = new Map((await constraintsOn("document_extracted_fields")).map((row) => [row.conname, row.def]));

    // No money on an identity field.
    expect(byName.get("document_extracted_fields_identity_no_money")).toMatch(/amount_minor IS NULL/i);
    expect(byName.get("document_extracted_fields_identity_no_money")).toMatch(/normalized_decimal IS NULL/i);
    expect(byName.get("document_extracted_fields_identity_no_money")).toMatch(/currency IS NULL/i);

    // No identifier on an identity field, dates excepted.
    expect(byName.get("document_extracted_fields_identity_no_identifiers")).toMatch(/\[0-9\]\{5,\}/);
    expect(byName.get("document_extracted_fields_identity_no_identifiers")).toMatch(/value_kind = 'DATE'/i);
  });

  it("does not touch the SSN backstop from 0046", async () => {
    const before = (await constraintsOn("document_extracted_fields")).find((row) => row.conname === "document_extracted_fields_no_ssn");
    expect(before, "the 0046 SSN backstop should exist before the re-run").toBeDefined();

    await reapply("0055_document_ocr_identity.sql");

    const after = (await constraintsOn("document_extracted_fields")).find((row) => row.conname === "document_extracted_fields_no_ssn");
    // Byte for byte the same constraint: 0055 never mentions it outside a comment.
    expect(after).toEqual(before);
  });

  it("restores the identity document classes and the IDENTITY section", async () => {
    await reapply("0055_document_ocr_identity.sql");

    const extractions = new Map((await constraintsOn("document_extractions")).map((row) => [row.conname, row.def]));
    const documentType = extractions.get("document_extractions_document_type_check") ?? "";
    for (const type of ["DRIVER_LICENSE", "PASSPORT", "SSN_DOCUMENT", "GOVERNMENT_ID", "BILL"]) {
      expect(documentType, type).toContain(type);
    }

    const fields = new Map((await constraintsOn("document_extracted_fields")).map((row) => [row.conname, row.def]));
    expect(fields.get("document_extracted_fields_section_check") ?? "").toContain("IDENTITY");
  });
});

describe("production's exact state: constraints present, version still 0054", () => {
  it("re-running 0055 sets the version it was supposed to set", async () => {
    // Reproduce the drift precisely — the effects are there, the trailing
    // `create or replace` never ran.
    await db.asAdmin((query) => query(`create or replace function operations_schema_version() returns text language sql immutable as $$ select '0054'::text $$`));
    expect(await schemaVersion()).toBe("0054");

    await reapply("0055_document_ocr_identity.sql");

    expect(await schemaVersion()).toBe("0055");
  });

  it("and re-running 0056 after it moves the version on again", async () => {
    await db.asAdmin((query) => query(`create or replace function operations_schema_version() returns text language sql immutable as $$ select '0054'::text $$`));
    await reapply("0055_document_ocr_identity.sql");
    await reapply("0056_document_failure_categories.sql");
    expect(await schemaVersion()).toBe("0056");
  });
});

describe("0056 was already rerunnable, and stays that way", () => {
  it("re-applies without error", async () => {
    await reapply("0056_document_failure_categories.sql");
    await reapply("0056_document_failure_categories.sql");
  });

  it("keeps every failure category the application can write", async () => {
    await reapply("0056_document_failure_categories.sql");
    const check = new Map((await constraintsOn("document_processing_jobs")).map((row) => [row.conname, row.def])).get("document_processing_jobs_failure_category_check") ?? "";
    for (const category of [
      "DOCUMENT_UNAVAILABLE",
      "FILE_VALIDATION_FAILED",
      "PROVIDER_ERROR",
      "PROVIDER_TIMEOUT",
      "MALFORMED_PROVIDER_RESPONSE",
      "LEASE_EXPIRED",
      "INTERNAL_ERROR",
      "UNSUPPORTED_DOCUMENT",
      "DOCUMENT_TOO_LARGE",
      "DOCUMENT_UNREADABLE",
      "PROVIDER_AUTH_ERROR",
      "PROVIDER_THROTTLED",
      "PROVIDER_UNAVAILABLE",
    ]) {
      expect(check, category).toContain(category);
    }
  });
});

describe("0057, re-applied to a database that already has its effects", () => {
  /**
   * 0057 is the financial one: the transfer pairing that stops one movement
   * becoming an expense AND an income. Five constraints, a unique index and a
   * trigger had no guard, so a retried push would have failed on the bank
   * tables — the worst place to be stuck halfway.
   */

  const indexes = () =>
    db.asAdmin(async (query) => (await query(`select indexname from pg_indexes where tablename = 'bank_external_transactions' order by indexname`)).rows as { indexname: string }[]);

  const triggers = (table: string) =>
    db.asAdmin(async (query) => (await query(`select tgname from pg_trigger where tgrelid = $1::regclass and not tgisinternal order by tgname`, [table])).rows as { tgname: string }[]);

  const allConstraints = (table: string) =>
    db.asAdmin(async (query) => (await query(`select conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = $1::regclass order by conname`, [table])).rows as { conname: string; contype: string; def: string }[]);

  const TRANSFER_CONSTRAINTS = [
    "bank_external_transactions_transfer_counterpart_fkey",
    "bank_external_transactions_transfer_role_consistent",
    "bank_external_transactions_transfer_role_values",
    "bank_external_transactions_transfer_not_self",
    "bank_external_transactions_counterpart_has_no_ledger_row",
  ];

  it("starts with every transfer constraint, the index and the trigger present", async () => {
    const names = (await allConstraints("bank_external_transactions")).map((row) => row.conname);
    for (const name of TRANSFER_CONSTRAINTS) expect(names, name).toContain(name);
    expect((await indexes()).map((row) => row.indexname)).toContain("bank_external_transactions_transfer_counterpart_idx");
    expect((await triggers("bank_external_transactions")).map((row) => row.tgname)).toContain("bank_external_transactions_paired_guard_trg");
  });

  it("re-applies without error", async () => {
    await reapply("0057_internal_transfers.sql");
  });

  it("re-applies twice over", async () => {
    await reapply("0057_internal_transfers.sql");
    await reapply("0057_internal_transfers.sql");
  });

  it("keeps exactly one of each constraint, index and trigger", async () => {
    await reapply("0057_internal_transfers.sql");
    const names = (await allConstraints("bank_external_transactions")).map((row) => row.conname);
    for (const name of TRANSFER_CONSTRAINTS) expect(names.filter((candidate) => candidate === name), name).toHaveLength(1);
    expect((await indexes()).filter((row) => row.indexname === "bank_external_transactions_transfer_counterpart_idx")).toHaveLength(1);
    expect((await triggers("bank_external_transactions")).filter((row) => row.tgname === "bank_external_transactions_paired_guard_trg")).toHaveLength(1);
  });

  it("preserves every financial-integrity definition exactly", async () => {
    const before = new Map((await allConstraints("bank_external_transactions")).map((row) => [row.conname, row.def]));
    await reapply("0057_internal_transfers.sql");
    const after = new Map((await allConstraints("bank_external_transactions")).map((row) => [row.conname, row.def]));

    // Byte for byte, every constraint on the table — not only the five
    // re-added ones. A re-run must not perturb anything 0047 established.
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [name, def] of before) expect(after.get(name), name).toBe(def);
  });

  it("keeps the one-external-per-ledger-row rule that predates it", async () => {
    await reapply("0057_internal_transfers.sql");
    expect((await indexes()).map((row) => row.indexname)).toContain("bank_external_transactions_one_per_ledger_row_idx");
  });

  it("keeps the counterpart index UNIQUE and partial, which is what makes pairing idempotent", async () => {
    await reapply("0057_internal_transfers.sql");
    const definition = await db.asAdmin(
      async (query) => ((await query(`select indexdef from pg_indexes where indexname = 'bank_external_transactions_transfer_counterpart_idx'`)).rows[0] as { indexdef: string }).indexdef,
    );
    expect(definition).toMatch(/CREATE UNIQUE INDEX/i);
    expect(definition.toLowerCase()).toContain("transfer_counterpart_id is not null");
  });

  it("leaves the paired-guard trigger firing on the same event", async () => {
    await reapply("0057_internal_transfers.sql");
    const row = await db.asAdmin(
      async (query) =>
        (
          await query(
            `select pg_get_triggerdef(oid) as def from pg_trigger where tgrelid = 'bank_external_transactions'::regclass and tgname = 'bank_external_transactions_paired_guard_trg'`,
          )
        ).rows[0] as { def: string },
    );
    expect(row.def).toMatch(/BEFORE UPDATE/i);
    expect(row.def).toMatch(/FOR EACH ROW/i);
    expect(row.def.toLowerCase()).toContain("bank_external_transactions_paired_guard()");
  });

  it("still reports its own schema version", async () => {
    await reapply("0057_internal_transfers.sql");
    expect(await schemaVersion()).toBe("0057");
  });
});

describe("0059, re-applied to a database that already has its effects", () => {
  const policies = () =>
    db.asAdmin(async (query) => (await query(`select policyname, cmd, qual from pg_policies where tablename = 'developer_plan_overrides' order by policyname`)).rows as { policyname: string; cmd: string; qual: string | null }[]);

  const triggerNames = () =>
    db.asAdmin(async (query) => (await query(`select tgname from pg_trigger where tgrelid = 'developer_plan_overrides'::regclass and not tgisinternal order by tgname`)).rows as { tgname: string }[]);

  it("re-applies without error", async () => {
    await reapply("0059_developer_plan_override.sql");
    await reapply("0059_developer_plan_override.sql");
  });

  it("keeps exactly one updated_at trigger", async () => {
    await reapply("0059_developer_plan_override.sql");
    expect((await triggerNames()).filter((row) => row.tgname === "developer_plan_overrides_set_updated_at")).toHaveLength(1);
  });

  it("keeps exactly ONE policy, and it is still SELECT-only", async () => {
    await reapply("0059_developer_plan_override.sql");
    const all = await policies();
    // The security model is the ABSENCE of write policies. A re-run that
    // added one — or duplicated the read one — would be the regression.
    expect(all).toHaveLength(1);
    expect(all[0].policyname).toBe("developer_plan_overrides_select_member");
    expect(all[0].cmd).toBe("SELECT");
  });

  it("preserves the policy expression exactly", async () => {
    const before = (await policies())[0];
    await reapply("0059_developer_plan_override.sql");
    const after = (await policies())[0];
    expect(after.qual).toBe(before.qual);
    expect(after.qual ?? "").toMatch(/is_org_member/);
  });

  it("leaves row level security enabled", async () => {
    await reapply("0059_developer_plan_override.sql");
    const enabled = await db.asAdmin(
      async (query) => ((await query(`select relrowsecurity from pg_class where oid = 'developer_plan_overrides'::regclass`)).rows[0] as { relrowsecurity: boolean }).relrowsecurity,
    );
    expect(enabled).toBe(true);
  });

  it("does not drop the table or its rows", async () => {
    // The organization is created AS THE OWNER, because its audit trigger
    // requires an authenticated session; the override row is written as the
    // service role, which is the only writer that table has.
    const owner = await db.asAdmin(async (query) => ((await query(`insert into auth.users (email) values ('dev-idem@example.test') returning id`)).rows[0] as { id: string }).id);
    await db.asUser(owner);
    const org = ((await db.query(`insert into organizations (name, entity_type, created_by) values ('Keep', 'personal', $1) returning id`, [owner])).rows[0] as { id: string }).id;
    await db.asAdmin((query) => query(`insert into developer_plan_overrides (organization_id, plan_id, created_by) values ($1, 'premium', $2)`, [org, owner]));

    await reapply("0059_developer_plan_override.sql");

    // `create table if not exists` — the row survives a re-run.
    const rows = await db.asAdmin(async (query) => (await query(`select plan_id from developer_plan_overrides`)).rows as { plan_id: string }[]);
    expect(rows).toHaveLength(1);
    expect(rows[0].plan_id).toBe("premium");
  });

  it("still reports its own schema version", async () => {
    await reapply("0059_developer_plan_override.sql");
    expect(await schemaVersion()).toBe("0059");
  });
});

describe("every pending migration is re-runnable, in order", () => {
  it("0055 through 0059 can all be applied again, back to back", async () => {
    // What a retried `supabase db push` actually does.
    for (const file of [
      "0055_document_ocr_identity.sql",
      "0056_document_failure_categories.sql",
      "0057_internal_transfers.sql",
      "0058_identity_document_retention.sql",
      "0059_developer_plan_override.sql",
    ]) {
      await reapply(file);
    }
    expect(await schemaVersion()).toBe("0059");
  });
});

describe("why the guard is needed, stated as a test", () => {
  it("an unguarded ADD CONSTRAINT for a constraint that exists raises 42710", async () => {
    // The exact error production returned. This is what the two added
    // `drop constraint if exists` lines prevent, and it is here so that
    // removing them fails a test rather than a deployment.
    await expect(
      db.asAdmin((query) =>
        query(`alter table document_extracted_fields add constraint document_extracted_fields_identity_no_money check (section <> 'IDENTITY')`),
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it("the file guards both identity constraints", async () => {
    const sql = readFileSync("supabase/migrations/0055_document_ocr_identity.sql", "utf8");
    for (const name of ["document_extracted_fields_identity_no_money", "document_extracted_fields_identity_no_identifiers"]) {
      expect(sql, name).toContain(`drop constraint if exists ${name};`);
    }
  });
});
