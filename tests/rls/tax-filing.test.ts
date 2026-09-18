import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * Tax filing tables (0044), against real Postgres.
 *
 * Every assertion is a DATABASE property: the question is whether Postgres
 * itself refuses, because Postgres is the only layer a direct REST call cannot
 * route around. Five properties:
 *
 *   READ-ONLY FOR MEMBERS  isolation by organization, and no member write at all
 *                          — a filing record cannot be forged through the API
 *   IDENTITY               id, organization, preparation case, tax year and
 *                          creation cannot be rewritten, even by the service role
 *   STATUS MACHINE         no provider-only status exists; FINALIZED needs a real
 *                          finalization of the current snapshot
 *   IMMUTABILITY           snapshots and finalizations cannot be updated or
 *                          deleted, even by the service role
 *   DELETION               account and organization deletion still work; a
 *                          preparation with filing history cannot be deleted
 *
 * Where a BEFORE trigger and a constraint would both refuse the same write,
 * Postgres runs the trigger first, so the message asserted is whichever refuses
 * first — the point is that the write fails, and each guard also has a test of
 * its own that the other cannot satisfy.
 */

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIEWER_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACCOUNTANT_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const PACKAGE = JSON.stringify({ format: { id: "countorra.filing-package" }, filed: false, submitted: false, governmentForm: false, electronicFilingAvailable: false });
const FINGERPRINT = "a".repeat(64);

type Query = TestDatabase["query"];

let db: TestDatabase;
let orgA: string;
let orgB: string;
let preparationA: string;
let preparationB: string;
let preparationSnapshotA: string;
let preparationSnapshotB: string;
let filingA: string;
let filingB: string;

/** Runs as `service_role` — which bypasses RLS, and must NOT bypass the triggers. */
async function asService<T>(fn: (query: Query) => Promise<T>): Promise<T> {
  return db.asAdmin(async (query) => {
    await query("set role service_role");
    try {
      return await fn(query);
    } finally {
      await query("reset role");
    }
  });
}

async function refused(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the database to refuse this statement");
}

async function one<T>(query: Query, sql: string, params: unknown[] = []): Promise<T> {
  return (await query(sql, params)).rows[0] as T;
}

async function createPreparation(query: Query, organizationId: string, actor: string, status = "CALCULATED") {
  const { id } = await one<{ id: string }>(
    query,
    `insert into tax_preparation_cases (organization_id, tax_year, status, filing_status, created_by) values ($1, 2026, $2, 'single', $3) returning id`,
    [organizationId, status, actor],
  );
  const snapshot = await one<{ id: string }>(
    query,
    `insert into tax_preparation_snapshots (organization_id, case_id, version, tax_year, filing_status, jurisdictions, payload, created_by)
     values ($1, $2, 1, 2026, 'single', array['US_FEDERAL'], '{}'::jsonb, $3) returning id`,
    [organizationId, id, actor],
  );
  return { caseId: id, snapshotId: snapshot.id };
}

async function createFilingCase(query: Query, organizationId: string, preparationCaseId: string, actor: string) {
  return (await one<{ id: string }>(query, `insert into tax_filing_cases (organization_id, preparation_case_id, tax_year, created_by) values ($1, $2, 2026, $3) returning id`, [organizationId, preparationCaseId, actor])).id;
}

async function insertSnapshot(
  query: Query,
  input: { organizationId: string; filingCaseId: string; preparationSnapshotId: string; version: number; readiness?: string; pkg?: string; taxYear?: number; preparationVersion?: number; actor?: string },
) {
  return (
    await one<{ id: string }>(
      query,
      `insert into tax_filing_snapshots (organization_id, filing_case_id, version, tax_year, preparation_snapshot_id, preparation_version, readiness_status, readiness, package, package_fingerprint, input_fingerprint, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, '{"status":"READY"}'::jsonb, $8::jsonb, $9, $9, $10) returning id`,
      [
        input.organizationId,
        input.filingCaseId,
        input.version,
        input.taxYear ?? 2026,
        input.preparationSnapshotId,
        input.preparationVersion ?? 1,
        input.readiness ?? "READY",
        input.pkg ?? PACKAGE,
        FINGERPRINT,
        input.actor ?? OWNER_A,
      ],
    )
  ).id;
}

async function setCase(query: Query, filingCaseId: string, status: string, currentVersion?: number) {
  if (currentVersion === undefined) return query(`update tax_filing_cases set status = $2 where id = $1`, [filingCaseId, status]);
  return query(`update tax_filing_cases set status = $2, current_version = $3 where id = $1`, [filingCaseId, status, currentVersion]);
}

async function finalize(query: Query, input: { organizationId: string; filingCaseId: string; snapshotId: string; scope?: string; excluded?: string[]; actor?: string }) {
  return (
    await one<{ id: string }>(
      query,
      `insert into tax_filing_finalizations (organization_id, filing_case_id, snapshot_id, scope, excluded_jurisdictions, finalized_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [input.organizationId, input.filingCaseId, input.snapshotId, input.scope ?? "FULL", input.excluded ?? [], input.actor ?? OWNER_A],
    )
  ).id;
}

/** A READY v1 snapshot, the case moved to READY_FOR_FILING at version 1. */
async function readySnapshotA(query: Query, actor = OWNER_A) {
  const snapshotId = await insertSnapshot(query, { organizationId: orgA, filingCaseId: filingA, preparationSnapshotId: preparationSnapshotA, version: 1, actor });
  await setCase(query, filingA, "READY_FOR_FILING", 1);
  return snapshotId;
}

async function filingRowA() {
  return db.asAdmin((query) =>
    one<Record<string, unknown>>(query, `select organization_id, preparation_case_id, tax_year, created_by, status, current_version from tax_filing_cases where id = $1`, [filingA]),
  );
}

beforeEach(async () => {
  db = await createTestDatabase();

  await db.asAdmin((query) =>
    query(`insert into auth.users (id, email) values ($1, 'a@example.test'), ($2, 'b@example.test'), ($3, 'v@example.test'), ($4, 'acct@example.test')`, [OWNER_A, OWNER_B, VIEWER_A, ACCOUNTANT_A]),
  );

  await db.asUser(OWNER_A);
  orgA = (await one<{ id: string }>(db.query, `insert into organizations (name, entity_type, created_by) values ('Acme', 'personal', $1) returning id`, [OWNER_A])).id;
  await db.asUser(OWNER_B);
  orgB = (await one<{ id: string }>(db.query, `insert into organizations (name, entity_type, created_by) values ('Rival', 'personal', $1) returning id`, [OWNER_B])).id;

  await db.asAdmin(async (query) => {
    await query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'viewer'), ($1, $3, 'accountant')`, [orgA, VIEWER_A, ACCOUNTANT_A]);
    ({ caseId: preparationA, snapshotId: preparationSnapshotA } = await createPreparation(query, orgA, OWNER_A));
    ({ caseId: preparationB, snapshotId: preparationSnapshotB } = await createPreparation(query, orgB, OWNER_B));
  });

  await asService(async (query) => {
    filingA = await createFilingCase(query, orgA, preparationA, OWNER_A);
    filingB = await createFilingCase(query, orgB, preparationB, OWNER_B);
  });
});

afterEach(async () => {
  await db.close();
});

// ══ Read-only for members ═════════════════════════════════════════════

describe("members can read their own filing records and write none", () => {
  it("shows the owner, a viewer and an accountant their own organization's filing case", async () => {
    for (const user of [OWNER_A, VIEWER_A, ACCOUNTANT_A]) {
      await db.asUser(user);
      expect((await db.query(`select id from tax_filing_cases where id = $1`, [filingA])).rows, user).toHaveLength(1);
    }
  });

  it("hides another organization's filing cases, snapshots and finalizations", async () => {
    await asService(async (query) => {
      const snapshotId = await readySnapshotA(query);
      await finalize(query, { organizationId: orgA, filingCaseId: filingA, snapshotId });
    });

    await db.asUser(OWNER_B);
    expect((await db.query(`select id from tax_filing_cases where organization_id = $1`, [orgA])).rows).toHaveLength(0);
    expect((await db.query(`select id from tax_filing_cases where id = $1`, [filingA])).rows).toHaveLength(0);
    expect((await db.query(`select id from tax_filing_snapshots`)).rows).toHaveLength(0);
    expect((await db.query(`select id from tax_filing_finalizations`)).rows).toHaveLength(0);
    expect((await db.query(`select id from tax_filing_cases`)).rows.map((row) => (row as { id: string }).id)).toEqual([filingB]);
  });

  it("refuses a member creating a filing case, even for their own preparation", async () => {
    const { caseId } = await db.asAdmin((query) => createPreparation(query, orgA, OWNER_A, "ARCHIVED"));
    await db.asUser(OWNER_A);
    const message = await refused(() => db.query(`insert into tax_filing_cases (organization_id, preparation_case_id, tax_year) values ($1, $2, 2026)`, [orgA, caseId]));
    expect(message).toMatch(/row-level security/);
  });

  it("refuses a member inserting a snapshot — even one every trigger would accept", async () => {
    await db.asUser(OWNER_A);
    const message = await refused(() => insertSnapshot(db.query, { organizationId: orgA, filingCaseId: filingA, preparationSnapshotId: preparationSnapshotA, version: 1 }));
    expect(message).toMatch(/row-level security/);
  });

  it("refuses a member inserting a finalization — even one every trigger would accept", async () => {
    const snapshotId = await asService((query) => readySnapshotA(query));
    await db.asUser(OWNER_A);
    const message = await refused(() => finalize(db.query, { organizationId: orgA, filingCaseId: filingA, snapshotId }));
    expect(message).toMatch(/row-level security/);
    await db.asAdmin(async (query) => expect((await query(`select id from tax_filing_finalizations`)).rows).toHaveLength(0));
  });

  it("gives a member's forged status update no effect", async () => {
    await asService((query) => readySnapshotA(query));
    await db.asUser(OWNER_A);
    const result = await db.query(`update tax_filing_cases set status = 'FINALIZED' where id = $1`, [filingA]);
    expect(result.affectedRows ?? 0).toBe(0);
    expect((await filingRowA()).status).toBe("READY_FOR_FILING");
  });

  it("refuses a member's upsert that tries to take a filing case over", async () => {
    await db.asUser(OWNER_A);
    const message = await refused(() =>
      db.query(
        `insert into tax_filing_cases (organization_id, preparation_case_id, tax_year) values ($1, $2, 2026)
         on conflict (preparation_case_id) do update set status = 'FINALIZED'`,
        [orgA, preparationA],
      ),
    );
    expect(message).toMatch(/row-level security/);
  });

  it("gives a member's delete of a filing case no effect", async () => {
    await db.asUser(OWNER_A);
    const result = await db.query(`delete from tax_filing_cases where id = $1`, [filingA]);
    expect(result.affectedRows ?? 0).toBe(0);
    await db.asAdmin(async (query) => expect((await query(`select id from tax_filing_cases where id = $1`, [filingA])).rows).toHaveLength(1));
  });

  it("does not let a member forge the actor of an audit event, or write one for another workspace", async () => {
    await db.asUser(OWNER_A);
    await db.query(`select record_audit_event($1, 'tax_filing.finalized', 'tax_filing_case', $2, '{}'::jsonb)`, [orgA, filingA]);
    await db.asAdmin(async (query) => {
      const row = await one<{ actor_id: string; actor_type: string }>(query, `select actor_id, actor_type from audit_logs where action = 'tax_filing.finalized' order by id desc limit 1`);
      expect(row).toEqual({ actor_id: OWNER_A, actor_type: "user" });
    });

    await db.asUser(OWNER_A);
    expect(await refused(() => db.query(`select record_audit_event($1, 'tax_filing.finalized', null, null, '{}'::jsonb, 'system')`, [orgA]))).toMatch(/not writable/);
    expect(await refused(() => db.query(`select record_audit_event($1, 'tax_filing.finalized', null, null, '{}'::jsonb)`, [orgB]))).toMatch(/not a member/);
  });
});

// ══ Identity ══════════════════════════════════════════════════════════

describe("filing case identity cannot be rewritten, even by the service role", () => {
  const attempts: [string, string, (ids: { filingA: string; orgB: string; preparationB: string }) => unknown[]][] = [
    ["id", `update tax_filing_cases set id = gen_random_uuid() where id = $1`, (ids) => [ids.filingA]],
    ["organization_id", `update tax_filing_cases set organization_id = $2 where id = $1`, (ids) => [ids.filingA, ids.orgB]],
    ["preparation_case_id", `update tax_filing_cases set preparation_case_id = $2 where id = $1`, (ids) => [ids.filingA, ids.preparationB]],
    ["tax_year", `update tax_filing_cases set tax_year = 2027 where id = $1`, (ids) => [ids.filingA]],
    ["created_at", `update tax_filing_cases set created_at = now() - interval '1 year' where id = $1`, (ids) => [ids.filingA]],
    ["created_by (reassigned)", `update tax_filing_cases set created_by = $2 where id = $1`, (ids) => [ids.filingA, OWNER_B]],
    ["created_by (cleared directly)", `update tax_filing_cases set created_by = null where id = $1`, (ids) => [ids.filingA]],
    ["several fields at once", `update tax_filing_cases set status = 'REVIEW_REQUIRED', organization_id = $2 where id = $1`, (ids) => [ids.filingA, ids.orgB]],
  ];

  it.each(attempts)("refuses changing %s", async (_label, sql, params) => {
    const before = await filingRowA();
    const message = await asService((query) => refused(() => query(sql, params({ filingA, orgB, preparationB }))));
    expect(message).toMatch(/cannot be changed|check constraint|violates/);
    expect(await filingRowA()).toEqual(before);
  });

  it("refuses an UPDATE … FROM that rewrites organization ids", async () => {
    const message = await asService((query) =>
      refused(() => query(`update tax_filing_cases c set organization_id = o.id from organizations o where o.id = $2 and c.id = $1`, [filingA, orgB])),
    );
    expect(message).toMatch(/cannot be changed|violates/);
  });

  it("refuses a multi-row update that would move every filing case", async () => {
    expect(await asService((query) => refused(() => query(`update tax_filing_cases set tax_year = 2027`)))).toMatch(/cannot be changed|check constraint/);
    await db.asAdmin(async (query) => expect((await query(`select id from tax_filing_cases where tax_year = 2026`)).rows).toHaveLength(2));
  });

  it("refuses an upsert that rewrites identity through ON CONFLICT", async () => {
    const message = await asService((query) =>
      refused(() =>
        query(
          `insert into tax_filing_cases (organization_id, preparation_case_id, tax_year) values ($1, $2, 2026)
           on conflict (preparation_case_id) do update set organization_id = $3`,
          [orgA, preparationA, orgB],
        ),
      ),
    );
    expect(message).toMatch(/cannot be changed|violates/);
  });

  it("refuses a filing case for another organization's preparation", async () => {
    const { caseId } = await db.asAdmin((query) => createPreparation(query, orgB, OWNER_B, "ARCHIVED"));
    expect(await asService((query) => refused(() => createFilingCase(query, orgA, caseId, OWNER_A)))).toMatch(/does not exist in this organization|foreign key/);
  });

  it("refuses a second filing case for the same preparation", async () => {
    expect(await asService((query) => refused(() => createFilingCase(query, orgA, preparationA, OWNER_A)))).toMatch(/unique|duplicate/);
  });

  it("refuses a filing case for any year but 2026, and one that starts anywhere but DRAFT at version 0", async () => {
    const { caseId } = await db.asAdmin((query) => createPreparation(query, orgA, OWNER_A, "ARCHIVED"));
    await asService(async (query) => {
      expect(await refused(() => query(`insert into tax_filing_cases (organization_id, preparation_case_id, tax_year) values ($1, $2, 2025)`, [orgA, caseId]))).toMatch(
        /check constraint|must equal the preparation case/,
      );
      expect(await refused(() => query(`insert into tax_filing_cases (organization_id, preparation_case_id, tax_year, status) values ($1, $2, 2026, 'FINALIZED')`, [orgA, caseId]))).toMatch(
        /starts as DRAFT/,
      );
      expect(await refused(() => query(`insert into tax_filing_cases (organization_id, preparation_case_id, tax_year, current_version) values ($1, $2, 2026, 4)`, [orgA, caseId]))).toMatch(
        /starts as DRAFT/,
      );
    });
  });

  it("pins tax_year to 2026 with a CHECK of its own, independent of the trigger", async () => {
    await db.asAdmin(async (query) => {
      const { definition } = await one<{ definition: string }>(
        query,
        `select pg_get_constraintdef(c.oid) as definition from pg_constraint c where c.conrelid = 'tax_filing_cases'::regclass and pg_get_constraintdef(c.oid) like '%tax_year%'`,
      );
      expect(definition).toMatch(/tax_year = 2026/);
    });
  });

  it("still allows the legitimate change: a status move along the machine", async () => {
    await asService((query) => setCase(query, filingA, "BLOCKED"));
    expect((await filingRowA()).status).toBe("BLOCKED");
  });
});

// ══ Status machine ════════════════════════════════════════════════════

describe("the status machine", () => {
  it("has no provider-only status to hold", async () => {
    for (const status of ["SUBMISSION_PENDING", "SUBMITTED", "ACCEPTED", "REJECTED", "FILED"]) {
      expect(await asService((query) => refused(() => setCase(query, filingA, status))), status).toMatch(/check constraint|cannot move/);
    }
    expect((await filingRowA()).status).toBe("DRAFT");
  });

  it("excludes provider-only statuses from the CHECK constraint itself", async () => {
    await db.asAdmin(async (query) => {
      const { definition } = await one<{ definition: string }>(
        query,
        `select pg_get_constraintdef(c.oid) as definition from pg_constraint c where c.conrelid = 'tax_filing_cases'::regclass and pg_get_constraintdef(c.oid) like '%READY_FOR_FILING%'`,
      );
      for (const status of ["DRAFT", "REVIEW_REQUIRED", "BLOCKED", "READY_FOR_FILING", "FINALIZED"]) expect(definition).toContain(status);
      for (const status of ["SUBMISSION_PENDING", "SUBMITTED", "ACCEPTED", "REJECTED"]) expect(definition).not.toContain(status);
    });
  });

  it("refuses FINALIZED without a finalization of the current snapshot", async () => {
    await asService(async (query) => {
      await readySnapshotA(query);
      expect(await refused(() => setCase(query, filingA, "FINALIZED"))).toMatch(/requires a finalization/);
    });
  });

  it("refuses skipping from DRAFT straight to FINALIZED", async () => {
    expect(await asService((query) => refused(() => setCase(query, filingA, "FINALIZED")))).toMatch(/cannot move from DRAFT to FINALIZED/);
  });

  it("refuses a current_version that no snapshot backs", async () => {
    expect(await asService((query) => refused(() => setCase(query, filingA, "READY_FOR_FILING", 3)))).toMatch(/latest filing snapshot version/);
  });

  it("finalizes through the full sequence, and keeps history when a new version follows", async () => {
    await asService(async (query) => {
      const v1 = await readySnapshotA(query);
      await finalize(query, { organizationId: orgA, filingCaseId: filingA, snapshotId: v1 });
      await setCase(query, filingA, "FINALIZED");

      // Information changed: a new version cannot stay FINALIZED...
      await insertSnapshot(query, { organizationId: orgA, filingCaseId: filingA, preparationSnapshotId: preparationSnapshotA, version: 2 });
      expect(await refused(() => setCase(query, filingA, "FINALIZED", 2))).toMatch(/requires a finalization/);
      // ...it moves back to readiness, and the finalized v1 survives untouched.
      await setCase(query, filingA, "READY_FOR_FILING", 2);
    });

    await db.asAdmin(async (query) => {
      expect((await query(`select version from tax_filing_snapshots where filing_case_id = $1 order by version`, [filingA])).rows).toEqual([{ version: 1 }, { version: 2 }]);
      expect((await query(`select id from tax_filing_finalizations where filing_case_id = $1`, [filingA])).rows).toHaveLength(1);
    });
  });
});

// ══ Snapshots ═════════════════════════════════════════════════════════

describe("filing snapshots", () => {
  it("must be the next version, for 2026, from this filing case's own preparation", async () => {
    const { snapshotId: otherPreparationSnapshot } = await db.asAdmin((query) => createPreparation(query, orgA, OWNER_A, "ARCHIVED"));

    await asService(async (query) => {
      const base = { organizationId: orgA, filingCaseId: filingA, preparationSnapshotId: preparationSnapshotA };
      expect(await refused(() => insertSnapshot(query, { ...base, version: 2 }))).toMatch(/next version/);
      expect(await refused(() => insertSnapshot(query, { ...base, version: 1, taxYear: 2025 }))).toMatch(/check constraint|must equal the filing case/);
      expect(await refused(() => insertSnapshot(query, { ...base, version: 1, preparationVersion: 7 }))).toMatch(/must match the preparation snapshot/);
      expect(await refused(() => insertSnapshot(query, { ...base, version: 1, preparationSnapshotId: otherPreparationSnapshot }))).toMatch(/different preparation case/);
      expect(await refused(() => insertSnapshot(query, { ...base, version: 1, preparationSnapshotId: preparationSnapshotB }))).toMatch(/does not exist in this organization|foreign key/);
      expect(await refused(() => insertSnapshot(query, { ...base, version: 1, readiness: "BLOCKED" }))).toMatch(/check constraint/);
    });
  });

  it("refuses a package that claims to be filed, submitted or a government form", async () => {
    for (const claim of [{ filed: true }, { submitted: true }, { governmentForm: true }, { electronicFilingAvailable: true }]) {
      const pkg = JSON.stringify({ ...JSON.parse(PACKAGE), ...claim });
      const message = await asService((query) =>
        refused(() => insertSnapshot(query, { organizationId: orgA, filingCaseId: filingA, preparationSnapshotId: preparationSnapshotA, version: 1, pkg })),
      );
      expect(message, JSON.stringify(claim)).toMatch(/package_is_not_a_filing/);
    }
  });

  it("cannot be updated or deleted by anyone — including the service role", async () => {
    const snapshotId = await asService((query) => readySnapshotA(query));

    await asService(async (query) => {
      expect(await refused(() => query(`update tax_filing_snapshots set package = jsonb_set(package, '{format}', '"tampered"') where id = $1`, [snapshotId]))).toMatch(/immutable/);
      expect(await refused(() => query(`update tax_filing_snapshots set readiness_status = 'REVIEW_REQUIRED' where id = $1`, [snapshotId]))).toMatch(/immutable/);
      expect(await refused(() => query(`update tax_filing_snapshots set created_by = null where id = $1`, [snapshotId]))).toMatch(/immutable/);
      expect(await refused(() => query(`delete from tax_filing_snapshots where id = $1`, [snapshotId]))).toMatch(/immutable/);
    });

    await db.asUser(OWNER_A);
    expect((await db.query(`update tax_filing_snapshots set readiness_status = 'READY' where id = $1`, [snapshotId])).affectedRows ?? 0).toBe(0);
    expect((await db.query(`delete from tax_filing_snapshots where id = $1`, [snapshotId])).affectedRows ?? 0).toBe(0);
    await db.asAdmin(async (query) => expect((await one<{ package: unknown }>(query, `select package from tax_filing_snapshots where id = $1`, [snapshotId])).package).toEqual(JSON.parse(PACKAGE)));
  });
});

// ══ Finalizations ═════════════════════════════════════════════════════

describe("finalizations", () => {
  it("require a READY snapshot for FULL and named exclusions for FEDERAL_ONLY", async () => {
    await asService(async (query) => {
      const review = await insertSnapshot(query, { organizationId: orgA, filingCaseId: filingA, preparationSnapshotId: preparationSnapshotA, version: 1, readiness: "REVIEW_REQUIRED" });
      await setCase(query, filingA, "REVIEW_REQUIRED", 1);

      expect(await refused(() => finalize(query, { organizationId: orgA, filingCaseId: filingA, snapshotId: review, scope: "FULL" }))).toMatch(/FULL finalization requires a READY/);
      expect(await refused(() => finalize(query, { organizationId: orgA, filingCaseId: filingA, snapshotId: review, scope: "FEDERAL_ONLY", excluded: [] }))).toMatch(/scope_exclusions/);

      await finalize(query, { organizationId: orgA, filingCaseId: filingA, snapshotId: review, scope: "FEDERAL_ONLY", excluded: ["US_AZ"] });
      await setCase(query, filingA, "FINALIZED");
    });
    expect((await filingRowA()).status).toBe("FINALIZED");
  });

  it("refuse an old snapshot, a blocked case, and another case's snapshot", async () => {
    await asService(async (query) => {
      const v1 = await readySnapshotA(query);
      const v2 = await insertSnapshot(query, { organizationId: orgA, filingCaseId: filingA, preparationSnapshotId: preparationSnapshotA, version: 2 });
      await setCase(query, filingA, "READY_FOR_FILING", 2);
      expect(await refused(() => finalize(query, { organizationId: orgA, filingCaseId: filingA, snapshotId: v1 }))).toMatch(/only the latest/);

      await setCase(query, filingA, "BLOCKED");
      expect(await refused(() => finalize(query, { organizationId: orgA, filingCaseId: filingA, snapshotId: v2 }))).toMatch(/BLOCKED filing case cannot be finalized/);

      const snapshotB = await insertSnapshot(query, { organizationId: orgB, filingCaseId: filingB, preparationSnapshotId: preparationSnapshotB, version: 1, actor: OWNER_B });
      await setCase(query, filingB, "READY_FOR_FILING", 1);
      await setCase(query, filingA, "READY_FOR_FILING");
      expect(await refused(() => finalize(query, { organizationId: orgA, filingCaseId: filingA, snapshotId: snapshotB }))).toMatch(/different filing case|foreign key/);
    });
  });

  it("cannot be updated or deleted", async () => {
    const finalizationId = await asService(async (query) => {
      const snapshotId = await readySnapshotA(query);
      return finalize(query, { organizationId: orgA, filingCaseId: filingA, snapshotId });
    });
    await asService(async (query) => {
      expect(await refused(() => query(`update tax_filing_finalizations set scope = 'FEDERAL_ONLY', excluded_jurisdictions = array['US_CA'] where id = $1`, [finalizationId]))).toMatch(/immutable/);
      expect(await refused(() => query(`update tax_filing_finalizations set finalized_by = $2 where id = $1`, [finalizationId, OWNER_B]))).toMatch(/immutable/);
      expect(await refused(() => query(`delete from tax_filing_finalizations where id = $1`, [finalizationId]))).toMatch(/immutable/);
    });
  });
});

// ══ Deletion ══════════════════════════════════════════════════════════

describe("deletion", () => {
  it("refuses deleting a filing case directly, even as the service role", async () => {
    expect(await asService((query) => refused(() => query(`delete from tax_filing_cases where id = $1`, [filingA])))).toMatch(/cannot be deleted directly/);
  });

  it("refuses deleting a preparation that has filing history, so history cannot vanish with it", async () => {
    await db.asUser(OWNER_A);
    expect(await refused(() => db.query(`delete from tax_preparation_cases where id = $1`, [preparationA]))).toMatch(/foreign key/);
  });

  it("lets account deletion detach attribution without touching the records", async () => {
    await asService(async (query) => {
      const snapshotId = await readySnapshotA(query, ACCOUNTANT_A);
      await finalize(query, { organizationId: orgA, filingCaseId: filingA, snapshotId, actor: ACCOUNTANT_A });
      await setCase(query, filingA, "FINALIZED");
    });

    await db.asAdmin((query) => query(`delete from auth.users where id = $1`, [ACCOUNTANT_A]));

    await db.asAdmin(async (query) => {
      expect((await query(`select created_by, readiness_status from tax_filing_snapshots where filing_case_id = $1`, [filingA])).rows).toEqual([{ created_by: null, readiness_status: "READY" }]);
      expect((await query(`select finalized_by, scope from tax_filing_finalizations where filing_case_id = $1`, [filingA])).rows).toEqual([{ finalized_by: null, scope: "FULL" }]);
      expect((await one<{ status: string }>(query, `select status from tax_filing_cases where id = $1`, [filingA])).status).toBe("FINALIZED");
    });
  });

  it("lets deleting the creator of a filing case clear created_by, and nothing else", async () => {
    const { caseId } = await db.asAdmin((query) => createPreparation(query, orgA, ACCOUNTANT_A, "ARCHIVED"));
    const created = await asService((query) => createFilingCase(query, orgA, caseId, ACCOUNTANT_A));
    await db.asAdmin((query) => query(`delete from auth.users where id = $1`, [ACCOUNTANT_A]));
    await db.asAdmin(async (query) =>
      expect(await one(query, `select created_by, status, tax_year from tax_filing_cases where id = $1`, [created])).toEqual({ created_by: null, status: "DRAFT", tax_year: 2026 }),
    );
  });

  it("removes every filing record with its organization, and nothing of another organization's", async () => {
    await asService(async (query) => {
      const snapshotId = await readySnapshotA(query);
      await finalize(query, { organizationId: orgA, filingCaseId: filingA, snapshotId });
      await setCase(query, filingA, "FINALIZED");
    });

    await db.asAdmin((query) => query(`delete from organizations where id = $1`, [orgA]));

    await db.asAdmin(async (query) => {
      for (const table of ["tax_filing_cases", "tax_filing_snapshots", "tax_filing_finalizations"]) {
        expect((await query(`select id from ${table} where organization_id = $1`, [orgA])).rows, table).toHaveLength(0);
      }
      expect((await query(`select id from tax_filing_cases where id = $1`, [filingB])).rows).toHaveLength(1);
    });
  });
});
