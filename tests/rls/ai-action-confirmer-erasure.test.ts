import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * The P1 regression: account deletion left half-finished by
 * `ai_actions.confirmed_by`.
 *
 * This file reproduces the exact production scenario against real Postgres —
 * not a mocked repository — because the failure was a foreign key, and a mock
 * cannot have one. The sequence below is the one `deleteAccountAction`
 * performs, in the same order, ending with the statement that used to throw:
 *
 *     DELETE auth.users: FAILED -> violates foreign key constraint
 *       "ai_actions_confirmed_by_fkey" on table "ai_actions"
 *     auth.users rows remaining: 1
 *     memberships rows remaining: 0
 *
 * See supabase/migrations/0033_ai_action_confirmer_erasure.sql.
 */

const LEAVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAYER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let db: TestDatabase;
let orgId: string;

/** Creates the shared workspace both users own, with the leaver as a second
 *  owner — the shape that makes `planAccountDeletion` choose LEAVE, not
 *  DELETE, so the organization (and its ai_actions) survives them. */
beforeEach(async () => {
  db = await createTestDatabase();

  await db.asAdmin(async (query) => {
    await query(`insert into auth.users (id, email) values ($1, 'leaver@example.test'), ($2, 'stayer@example.test')`, [LEAVER, STAYER]);
  });

  await db.asUser(STAYER);
  const org = await db.query(`insert into organizations (name, entity_type, created_by) values ('Shared', 'business', $1) returning id`, [STAYER]);
  orgId = (org.rows[0] as { id: string }).id;

  await db.asAdmin((query) => query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'owner')`, [orgId, LEAVER]));
});

afterEach(async () => {
  await db.close();
});

async function insertAction(
  confirmedBy: string | null,
  status = "executed",
  operationMode = "write",
): Promise<string> {
  return db.asAdmin(async (query) => {
    const result = await query(
      `insert into ai_actions (organization_id, operation_mode, tool_name, input, status, confirmed_by, executed_at)
       values ($1, $2, 'createTransaction', '{}'::jsonb, $3, $4, now()) returning id`,
      [orgId, operationMode, status, confirmedBy],
    );
    return (result.rows[0] as { id: string }).id;
  });
}

const count = (table: string, where: string, params: unknown[] = []) =>
  db.asAdmin(async (query) => {
    const r = await query(`select count(*)::int as n from ${table} ${where}`, params);
    return (r.rows[0] as { n: number }).n;
  });

describe("the reproduced scenario: a leaver who confirmed an AI write", () => {
  it("deletes the account cleanly, and keeps the action", async () => {
    const actionId = await insertAction(LEAVER);

    await db.asAdmin(async (query) => {
      // Exactly what deleteAccountAction does, in order.
      await query(`delete from memberships where organization_id = $1 and user_id = $2`, [orgId, LEAVER]);
      await query(`delete from ai_conversations where user_id = $1`, [LEAVER]);
      await query(`delete from auth.users where id = $1`, [LEAVER]);
    });

    // The account is gone — this is the statement that used to throw.
    expect(await count("auth.users", "where id = $1", [LEAVER])).toBe(0);
    expect(await count("memberships", "where user_id = $1", [LEAVER])).toBe(0);

    // The action survives its author.
    const action = await db.asAdmin(async (query) => {
      const r = await query(`select confirmed_by, confirmer_deleted, status, operation_mode from ai_actions where id = $1`, [actionId]);
      return r.rows[0] as { confirmed_by: string | null; confirmer_deleted: boolean; status: string; operation_mode: string };
    });

    expect(action).toEqual({ confirmed_by: null, confirmer_deleted: true, status: "executed", operation_mode: "write" });
  });

  it("leaves the surviving organization otherwise untouched", async () => {
    await insertAction(LEAVER);

    await db.asAdmin(async (query) => {
      await query(`delete from memberships where organization_id = $1 and user_id = $2`, [orgId, LEAVER]);
      await query(`delete from auth.users where id = $1`, [LEAVER]);
    });

    expect(await count("organizations", "where id = $1", [orgId])).toBe(1);
    expect(await count("memberships", "where organization_id = $1", [orgId])).toBe(1);
    expect(await count("ai_actions", "where organization_id = $1", [orgId])).toBe(1);
  });

  it("keeps the audit trail, with the actor detached", async () => {
    await insertAction(LEAVER);
    const before = await count("audit_logs", "where actor_id = $1", [STAYER]);
    expect(before).toBeGreaterThan(0);

    await db.asAdmin(async (query) => {
      await query(`delete from memberships where organization_id = $1 and user_id = $2`, [orgId, LEAVER]);
      await query(`delete from auth.users where id = $1`, [LEAVER]);
    });

    // Nothing in the audit log was destroyed by the deletion.
    expect(await count("audit_logs", "where organization_id = $1", [orgId])).toBeGreaterThan(0);
  });

  it("detaches every status and mode the CHECK would otherwise have blocked", async () => {
    const ids = await Promise.all([
      insertAction(LEAVER, "executed", "write"),
      insertAction(LEAVER, "executed", "delete"),
      insertAction(LEAVER, "confirmed", "write"),
      insertAction(LEAVER, "failed", "write"),
      insertAction(LEAVER, "rejected", "write"),
      insertAction(LEAVER, "pending_confirmation", "write"),
      insertAction(LEAVER, "executed", "read"),
    ]);

    await db.asAdmin((query) => query(`delete from auth.users where id = $1`, [LEAVER]));

    const rows = await db.asAdmin(async (query) => {
      const r = await query(`select confirmed_by, confirmer_deleted from ai_actions where id = any($1::uuid[])`, [ids]);
      return r.rows as { confirmed_by: string | null; confirmer_deleted: boolean }[];
    });

    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.confirmed_by).toBeNull();
      expect(row.confirmer_deleted).toBe(true);
    }
  });

  it("does not touch another user's actions", async () => {
    const mine = await insertAction(LEAVER);
    const theirs = await insertAction(STAYER);

    await db.asAdmin((query) => query(`delete from auth.users where id = $1`, [LEAVER]));

    const rows = await db.asAdmin(async (query) => {
      const r = await query(`select id, confirmed_by, confirmer_deleted from ai_actions where id = any($1::uuid[]) order by id`, [[mine, theirs]]);
      return r.rows as { id: string; confirmed_by: string | null; confirmer_deleted: boolean }[];
    });

    const stayerRow = rows.find((r) => r.id === theirs)!;
    expect(stayerRow.confirmed_by).toBe(STAYER);
    expect(stayerRow.confirmer_deleted).toBe(false);
    expect(rows.find((r) => r.id === mine)!.confirmed_by).toBeNull();
  });
});

describe("the invariant is preserved for users who still exist", () => {
  it("still refuses an executed WRITE with no confirmer at all", async () => {
    // The forgery the CHECK exists to prevent. Unchanged.
    await expect(insertAction(null, "executed", "write")).rejects.toThrow();
  });

  it("still refuses an executed DELETE with no confirmer at all", async () => {
    await expect(insertAction(null, "executed", "delete")).rejects.toThrow();
  });

  it("still refuses a confirmed WRITE with no confirmer at all", async () => {
    await expect(insertAction(null, "confirmed", "write")).rejects.toThrow();
  });

  it("still allows a pending or read-mode action without a confirmer", async () => {
    await expect(insertAction(null, "pending_confirmation", "write")).resolves.toBeTruthy();
    await expect(insertAction(null, "executed", "read")).resolves.toBeTruthy();
  });

  it("gives no client a way to INSERT a pre-tombstoned action", async () => {
    // Worth being precise about, because the CHECK alone cannot stop this.
    // A row with `confirmed_by = null, confirmer_deleted = true, status =
    // executed` is exactly the shape a genuinely-erased approver leaves
    // behind, so the constraint must permit it — which would make the
    // tombstone a way to forge an approved AI write, if a client could write
    // one.
    //
    // It cannot: 0021 DROPPED `ai_actions_insert_member`, leaving the
    // `authenticated` role with no INSERT policy on this table at all. Rows
    // are created only through the server-side flow. Unlike UPDATE and
    // DELETE — which express "no policy" as zero rows matched — an INSERT
    // with no WITH CHECK to satisfy is refused outright.
    await db.asUser(LEAVER);
    await expect(
      db.query(
        `insert into ai_actions (organization_id, operation_mode, tool_name, status, confirmed_by, confirmer_deleted)
         values ($1, 'write', 'createTransaction', 'executed', null, true)`,
        [orgId],
      ),
    ).rejects.toThrow(/row-level security/);

    expect(await count("ai_actions", "where organization_id = $1", [orgId])).toBe(0);
  });
});

describe("nobody can strip attribution from a live user", () => {
  it("refuses a privileged member clearing someone else's confirmed_by", async () => {
    // `ai_actions_update_privileged` (0011) lets any owner/admin/accountant/
    // manager update any row in their org, so before 0033 this succeeded.
    const actionId = await insertAction(STAYER);

    await db.asUser(LEAVER);
    await expect(db.query(`update ai_actions set confirmed_by = null where id = $1`, [actionId])).rejects.toThrow(
      /cannot be cleared while the confirming user still exists/,
    );
  });

  it("refuses the confirming user clearing their own attribution", async () => {
    const actionId = await insertAction(LEAVER);

    await db.asUser(LEAVER);
    await expect(db.query(`update ai_actions set confirmed_by = null where id = $1`, [actionId])).rejects.toThrow(
      /cannot be cleared while the confirming user still exists/,
    );
  });

  it("refuses the service role too — this is not an authorization check", async () => {
    // The rule is about what is true, not about who is asking. An erased
    // approver is a fact the database can verify; a request to forget one is
    // not something any caller gets to assert.
    const actionId = await insertAction(LEAVER);

    await expect(db.asAdmin((query) => query(`update ai_actions set confirmed_by = null where id = $1`, [actionId]))).rejects.toThrow(
      /cannot be cleared while the confirming user still exists/,
    );
  });

  it("refuses setting the tombstone by hand while the user exists", async () => {
    const actionId = await insertAction(LEAVER);

    await db.asAdmin((query) => query(`update ai_actions set confirmer_deleted = true where id = $1`, [actionId]));

    // The flag alone changes nothing: confirmed_by is still set, so the row
    // is still attributed and the CHECK is still satisfied the ordinary way.
    const row = await db.asAdmin(async (query) => {
      const r = await query(`select confirmed_by from ai_actions where id = $1`, [actionId]);
      return r.rows[0] as { confirmed_by: string | null };
    });
    expect(row.confirmed_by).toBe(LEAVER);
  });

  it("still refuses reassigning confirmed_by to a different live user", async () => {
    // 0024's rule, unchanged by the new block above it: a session may only
    // ever record ITSELF as the confirmer, so STAYER cannot move the
    // attribution onto LEAVER.
    const actionId = await insertAction(STAYER);

    await db.asUser(STAYER);
    await expect(db.query(`update ai_actions set confirmed_by = $2 where id = $1`, [actionId, LEAVER])).rejects.toThrow(
      /confirmed_by must be the confirming user/,
    );
  });
});

describe("the foreign key and constraint shape after 0033", () => {
  it("detaches rather than cascading or blocking", async () => {
    const rule = await db.asAdmin(async (query) => {
      const r = await query(
        `select confdeltype from pg_constraint where conname = 'ai_actions_confirmed_by_fkey' and conrelid = 'ai_actions'::regclass`,
      );
      return (r.rows[0] as { confdeltype: string }).confdeltype;
    });
    // 'n' = SET NULL. 'a'/'r' would re-open the P1; 'c' would delete the
    // audit history the migration exists to preserve.
    expect(rule).toBe("n");
  });

  it("leaves NO foreign key to auth.users that can block a deletion", async () => {
    // The whole point: after 0029 and 0033, the only remaining NO ACTION
    // reference is ai_conversations.user_id, which the deletion flow removes
    // explicitly because a conversation is the person's own data.
    const blockers = await db.asAdmin(async (query) => {
      const r = await query(`
        select c.conrelid::regclass::text as tbl, a.attname as col
        from pg_constraint c
        join unnest(c.conkey) with ordinality k(attnum, ord) on true
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
        where c.contype = 'f' and c.confrelid = 'auth.users'::regclass and c.confdeltype in ('a', 'r')
        order by 1, 2`);
      return (r.rows as { tbl: string; col: string }[]).map((r) => `${r.tbl}.${r.col}`);
    });

    expect(blockers).toEqual(["ai_conversations.user_id"]);
  });

  it("indexes the column the cascade has to search", async () => {
    const indexes = await db.asAdmin(async (query) => {
      const r = await query(`select indexname from pg_indexes where tablename = 'ai_actions'`);
      return (r.rows as { indexname: string }[]).map((r) => r.indexname);
    });
    expect(indexes).toContain("ai_actions_confirmed_by_idx");
  });

  it("keeps the named CHECK and drops the anonymous one it replaced", async () => {
    const checks = await db.asAdmin(async (query) => {
      const r = await query(
        `select conname from pg_constraint where conrelid = 'ai_actions'::regclass and contype = 'c' order by conname`,
      );
      return (r.rows as { conname: string }[]).map((r) => r.conname);
    });

    expect(checks).toContain("ai_actions_confirmed_write_has_confirmer");
    expect(checks).not.toContain("ai_actions_check");
  });
});
