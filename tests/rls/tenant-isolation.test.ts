import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * Executes the real migrations in supabase/migrations against an in-process
 * Postgres and drives them as two different authenticated users, to verify
 * the RLS policies in 0011_rls_policies.sql actually isolate tenants —
 * not just that the SQL reads correctly. See tests/rls/harness.ts for how
 * `auth.uid()` is mocked.
 */

/** PGlite's query results are untyped by design (raw SQL, not the app's
 *  Supabase client) — this is the one, explicit place a row shape is
 *  asserted for these tests, rather than scattering `as any` at each call. */
function row<T>(rows: unknown[], index = 0): T {
  return rows[index] as T;
}

let db: TestDatabase;
let userA: string;
let userB: string;
let userC: string;
let orgA: string;
let orgB: string;

beforeEach(async () => {
  db = await createTestDatabase();

  await db.asAdmin(async (query) => {
    const users = await query(
      `insert into auth.users (email) values ('a@example.com'), ('b@example.com'), ('c@example.com') returning id`,
    );
    [userA, userB, userC] = users.rows.map((r) => row<{ id: string }>([r]).id);
  });

  await db.asUser(userA);
  const orgAResult = await db.query(
    `insert into organizations (name, entity_type, created_by) values ('Org A', 'business', $1) returning id`,
    [userA],
  );
  orgA = row<{ id: string }>(orgAResult.rows).id;

  await db.asUser(userB);
  const orgBResult = await db.query(
    `insert into organizations (name, entity_type, created_by) values ('Org B', 'business', $1) returning id`,
    [userB],
  );
  orgB = row<{ id: string }>(orgBResult.rows).id;
});

afterEach(async () => {
  await db.close();
});

describe("organization data isolation", () => {
  it("a member sees only their own organization", async () => {
    await db.asUser(userA);
    const result = await db.query(`select id from organizations`);
    const ids = result.rows.map((r) => row<{ id: string }>([r]).id);
    expect(ids).toEqual([orgA]);
    expect(ids).not.toContain(orgB);
  });

  it("a member cannot read another organization's transactions", async () => {
    await db.asUser(userA);
    const account = await db.query(
      `insert into accounts (organization_id, name, kind, currency) values ($1, 'Checking', 'bank', 'RON') returning id`,
      [orgA],
    );
    const accountId = row<{ id: string }>(account.rows).id;
    await db.query(
      `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on)
       values ($1, $2, 'expense', 5000, 'RON', current_date)`,
      [orgA, accountId],
    );

    await db.asUser(userB);
    const asB = await db.query(`select * from transactions`);
    expect(asB.rows).toHaveLength(0);

    await db.asUser(userA);
    const asA = await db.query(`select * from transactions`);
    expect(asA.rows).toHaveLength(1);
  });

  it("a member cannot read another organization's memberships", async () => {
    await db.asUser(userB);
    const result = await db.query(`select * from memberships where organization_id = $1`, [orgA]);
    expect(result.rows).toHaveLength(0);
  });

  it("a member cannot insert data into another organization", async () => {
    await db.asUser(userB);
    await expect(
      db.query(
        `insert into accounts (organization_id, name, kind, currency) values ($1, 'Hostile', 'bank', 'RON')`,
        [orgA],
      ),
    ).rejects.toThrow();
  });

  it("a non-member cannot see another organization's AI conversations", async () => {
    await db.asUser(userA);
    await db.query(
      `insert into ai_conversations (organization_id, user_id, title) values ($1, $2, 'Q1 spend')`,
      [orgA, userA],
    );

    await db.asUser(userB);
    const result = await db.query(`select * from ai_conversations`);
    expect(result.rows).toHaveLength(0);
  });
});

describe("membership self-escalation guard", () => {
  it("blocks a member from changing their own role", async () => {
    await db.asUser(userA);
    const ownRow = await db.query(`select id from memberships where organization_id = $1 and user_id = $2`, [
      orgA,
      userA,
    ]);
    const membershipId = row<{ id: string }>(ownRow.rows).id;

    // RLS silently filters this row out of the UPDATE's USING clause —
    // exactly the same shape a real self-escalation attempt would take.
    const attempt = await db.query(`update memberships set role = 'owner' where id = $1 returning id`, [
      membershipId,
    ]);
    expect(attempt.rows).toHaveLength(0);
  });

  it("still allows an owner to change another member's role", async () => {
    await db.asAdmin((query) =>
      query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'viewer')`, [orgA, userC]),
    );

    await db.asUser(userA);
    const result = await db.query(
      `update memberships set role = 'accountant' where organization_id = $1 and user_id = $2 returning role`,
      [orgA, userC],
    );
    expect(row<{ role: string }>(result.rows).role).toBe("accountant");
  });

  it("blocks a non-admin member from changing anyone's role", async () => {
    await db.asAdmin((query) =>
      query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'viewer')`, [orgA, userC]),
    );

    await db.asUser(userC);
    const attempt = await db.query(
      `update memberships set role = 'owner' where organization_id = $1 and user_id = $2 returning id`,
      [orgA, userC],
    );
    expect(attempt.rows).toHaveLength(0);
  });
});

describe("append-only audit log", () => {
  it("rejects UPDATE even from an unrestricted session", async () => {
    let logId: number;
    await db.asAdmin(async (query) => {
      // Seeded with a direct service-role INSERT rather than
      // record_audit_event(): since 0024 that RPC requires an
      // authenticated member session (it was previously callable by
      // anyone, for any organization), and `asAdmin` deliberately has no
      // session. What's under test here is the append-only trigger, which
      // fires the same way regardless of how the row got in.
      const result = await query(
        `insert into audit_logs (organization_id, actor_type, action, resource_type, resource_id)
         values ($1, 'system', 'organization.created', 'organization', $1) returning id`,
        [orgA],
      );
      logId = row<{ id: number }>(result.rows).id;
    });

    await db.asAdmin(async (query) => {
      await expect(query(`update audit_logs set action = 'tampered' where id = $1`, [logId])).rejects.toThrow(
        /append-only/,
      );
    });
  });

  it("rejects DELETE even from an unrestricted session", async () => {
    let logId: number;
    await db.asAdmin(async (query) => {
      // Seeded with a direct service-role INSERT rather than
      // record_audit_event(): since 0024 that RPC requires an
      // authenticated member session (it was previously callable by
      // anyone, for any organization), and `asAdmin` deliberately has no
      // session. What's under test here is the append-only trigger, which
      // fires the same way regardless of how the row got in.
      const result = await query(
        `insert into audit_logs (organization_id, actor_type, action, resource_type, resource_id)
         values ($1, 'system', 'organization.created', 'organization', $1) returning id`,
        [orgA],
      );
      logId = row<{ id: number }>(result.rows).id;
    });

    await db.asAdmin(async (query) => {
      await expect(query(`delete from audit_logs where id = $1`, [logId])).rejects.toThrow(/append-only/);
    });
  });

  it("a non-admin member cannot read the audit log", async () => {
    await db.asAdmin((query) =>
      query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'employee')`, [orgA, userC]),
    );

    await db.asUser(userC);
    const result = await db.query(`select * from audit_logs where organization_id = $1`, [orgA]);
    expect(result.rows).toHaveLength(0);
  });
});

describe("billing tamper resistance", () => {
  it("blocks a client from upgrading their own plan directly", async () => {
    await db.asUser(userA);
    const attempt = await db.query(
      `update subscriptions set plan_id = 'business' where organization_id = $1 returning id`,
      [orgA],
    );
    expect(attempt.rows).toHaveLength(0);
  });
});
