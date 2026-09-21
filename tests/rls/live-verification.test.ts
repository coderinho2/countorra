import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * Regression tests for the three findings of the LIVE verification against the
 * real Supabase project, fixed in 0025_live_verification_fixes.sql.
 *
 * All three were found by attacking or operating the remote database rather
 * than by reading SQL, and two of them only appear when something is deleted —
 * which is why the previous suite, which never deleted an organization or a
 * user, did not catch them.
 */

function row<T>(rows: unknown[], index = 0): T {
  return rows[index] as T;
}

let db: TestDatabase;
let owner: string;
let other: string;
let orgA: string;
let orgB: string;

beforeEach(async () => {
  db = await createTestDatabase();

  await db.asAdmin(async (query) => {
    const users = await query(`insert into auth.users (email) values ('owner@a.test'), ('other@b.test') returning id`);
    [owner, other] = users.rows.map((r) => row<{ id: string }>([r]).id);
  });

  await db.asUser(owner);
  orgA = row<{ id: string }>(
    (await db.query(`insert into organizations (name, entity_type, created_by) values ('Org A', 'personal', $1) returning id`, [owner])).rows,
  ).id;

  await db.asUser(other);
  orgB = row<{ id: string }>(
    (await db.query(`insert into organizations (name, entity_type, created_by) values ('Org B', 'personal', $1) returning id`, [other])).rows,
  ).id;
});

afterEach(async () => {
  await db.close();
});

describe("org_id_of_* is not a cross-tenant oracle for authenticated users", () => {
  // These helpers are SECURITY DEFINER, so they ignore RLS. 0024 revoked them
  // from anon/PUBLIC, but `authenticated` must keep EXECUTE for the policies
  // that call them — which left them callable directly, by anyone, for any id.
  it("returns null when the caller is not a member of the owning organization", async () => {
    await db.asUser(other);
    const invoiceId = await db.asAdmin(async (query) => {
      const customer = await query(`insert into customers (organization_id, display_name) values ($1, 'C') returning id`, [orgB]);
      const inv = await query(
        `insert into invoices (organization_id, customer_id, invoice_number, currency) values ($1, $2, 'INV-1', 'USD') returning id`,
        [orgB, row<{ id: string }>(customer.rows).id],
      );
      return row<{ id: string }>(inv.rows).id;
    });

    await db.asUser(owner);
    const leaked = await db.query(`select org_id_of_invoice($1) as org`, [invoiceId]);
    expect(row<{ org: string | null }>(leaked.rows).org).toBeNull();
  });

  it("returns the real organization id to an actual member", async () => {
    await db.asUser(other);
    const customer = await db.query(`insert into customers (organization_id, display_name) values ($1, 'C') returning id`, [orgB]);
    const inv = await db.query(
      `insert into invoices (organization_id, customer_id, invoice_number, currency) values ($1, $2, 'INV-2', 'USD') returning id`,
      [orgB, row<{ id: string }>(customer.rows).id],
    );
    const invoiceId = row<{ id: string }>(inv.rows).id;

    const seen = await db.query(`select org_id_of_invoice($1) as org`, [invoiceId]);
    expect(row<{ org: string }>(seen.rows).org).toBe(orgB);
  });

  it("does not leak a document's or conversation's organization either", async () => {
    const { docId, convId } = await db.asAdmin(async (query) => {
      const d = await query(`insert into documents (organization_id, storage_path) values ($1, 'x/y.pdf') returning id`, [orgB]);
      const c = await query(`insert into ai_conversations (organization_id, user_id) values ($1, $2) returning id`, [orgB, other]);
      return { docId: row<{ id: string }>(d.rows).id, convId: row<{ id: string }>(c.rows).id };
    });

    await db.asUser(owner);
    expect(row<{ org: string | null }>((await db.query(`select org_id_of_document($1) as org`, [docId])).rows).org).toBeNull();
    expect(row<{ org: string | null }>((await db.query(`select org_id_of_conversation($1) as org`, [convId])).rows).org).toBeNull();
  });

  it("keeps the policies that depend on these helpers working", async () => {
    // The helpers are wrapped in is_org_member()/is_org_role() at every call
    // site, so returning null for a non-member must produce exactly the same
    // denial as before — and must not break the member's own access.
    await db.asUser(other);
    const customer = await db.query(`insert into customers (organization_id, display_name) values ($1, 'C') returning id`, [orgB]);
    const inv = await db.query(
      `insert into invoices (organization_id, customer_id, invoice_number, currency) values ($1, $2, 'INV-3', 'USD') returning id`,
      [orgB, row<{ id: string }>(customer.rows).id],
    );
    const invoiceId = row<{ id: string }>(inv.rows).id;
    await db.query(
      `insert into invoice_line_items (invoice_id, description, quantity, unit_price_minor, amount_minor) values ($1, 'work', 1, 1000, 1000)`,
      [invoiceId],
    );

    // the member still reads their own line items
    expect((await db.query(`select * from invoice_line_items where invoice_id = $1`, [invoiceId])).rows).toHaveLength(1);

    // the non-member still cannot
    await db.asUser(owner);
    expect((await db.query(`select * from invoice_line_items where invoice_id = $1`, [invoiceId])).rows).toHaveLength(0);
  });
});

describe("an organization can actually be deleted", () => {
  // 0024's last-owner trigger fired on the membership rows that an
  // organization delete cascades to, aborting every organization deletion.
  //
  // Since 0050 the deletion is server-side only (the re-authenticated
  // account flow, which cancels Stripe billing and releases bank credentials
  // first), so it runs as the service role here. The owner's own session is
  // refused outright — see tests/rls/billing-safe-deletion.test.ts.
  it("the owner's own session can no longer delete it directly", async () => {
    await db.asUser(owner);
    await expect(db.query(`delete from organizations where id = $1 returning id`, [orgA])).rejects.toThrow(/permission denied/i);
  });

  it("the server-side deletion removes the organization, cascading its members", async () => {
    const deleted = await db.asAdmin((query) => query(`delete from organizations where id = $1 returning id`, [orgA]));
    expect(deleted.rows).toHaveLength(1);

    await db.asAdmin(async (query) => {
      expect((await query(`select * from memberships where organization_id = $1`, [orgA])).rows).toHaveLength(0);
      expect((await query(`select * from organizations where id = $1`, [orgA])).rows).toHaveLength(0);
    });
  });

  it("deletion still works when the organization has audit history", async () => {
    // Every organization does: bootstrap records `organization.created`.
    await db.asAdmin(async (query) => {
      expect((await query(`select * from audit_logs where organization_id = $1`, [orgA])).rows.length).toBeGreaterThan(0);
    });

    expect((await db.asAdmin((query) => query(`delete from organizations where id = $1 returning id`, [orgA]))).rows).toHaveLength(1);

    await db.asAdmin(async (query) => {
      // The audit rows survive, detached rather than deleted.
      const detached = await query(`select organization_id, action from audit_logs where action = 'organization.created' and organization_id is null`);
      expect(detached.rows.length).toBeGreaterThan(0);
    });
  });

  it("still refuses to strip the last owner from a LIVE organization", async () => {
    // Through RLS this is unreachable for a normal user — 0024 already stops
    // an owner editing their own row, and only an owner may touch an owner —
    // so the policy denies it first, with zero rows rather than an error.
    await db.asUser(owner);
    expect((await db.query(`delete from memberships where organization_id = $1 and user_id = $2`, [orgA, owner])).rows).toHaveLength(0);

    // The trigger is the backstop behind that, for the paths RLS does not
    // govern: the service role, the admin client, a future SECURITY DEFINER
    // function. It must still fire there — that is the whole point of it
    // being a trigger and not another policy.
    await db.asAdmin(async (query) => {
      await expect(query(`delete from memberships where organization_id = $1 and user_id = $2`, [orgA, owner])).rejects.toThrow(
        /at least one owner/i,
      );
      await expect(
        query(`update memberships set role = 'viewer' where organization_id = $1 and user_id = $2`, [orgA, owner]),
      ).rejects.toThrow(/at least one owner/i);
    });
  });
});

describe("append-only audit log: immutable content, severable references", () => {
  async function seedAuditRow(): Promise<number> {
    return db.asAdmin(async (query) => {
      const r = await query(
        `insert into audit_logs (organization_id, actor_id, actor_type, action, resource_type, metadata)
         values ($1, $2, 'user', 'transaction.created', 'transaction', '{"a":1}'::jsonb) returning id`,
        [orgA, owner],
      );
      return row<{ id: number }>(r.rows).id;
    });
  }

  it("still rejects DELETE outright, even from an unrestricted session", async () => {
    const id = await seedAuditRow();
    await db.asAdmin(async (query) => {
      await expect(query(`delete from audit_logs where id = $1`, [id])).rejects.toThrow(/append-only/);
    });
  });

  it("still rejects any change to what the event says", async () => {
    const id = await seedAuditRow();
    await db.asAdmin(async (query) => {
      for (const patch of [
        `action = 'tampered'`,
        `actor_type = 'system'`,
        `resource_type = 'invoice'`,
        `metadata = '{"a":2}'::jsonb`,
        `created_at = now() - interval '1 year'`,
      ]) {
        await expect(query(`update audit_logs set ${patch} where id = ${id}`)).rejects.toThrow(/append-only/);
      }
    });
  });

  it("still rejects re-pointing an event at a different actor or organization", async () => {
    const id = await seedAuditRow();
    await db.asAdmin(async (query) => {
      await expect(query(`update audit_logs set actor_id = $1 where id = $2`, [other, id])).rejects.toThrow(/append-only/);
      await expect(query(`update audit_logs set organization_id = $1 where id = $2`, [orgB, id])).rejects.toThrow(/append-only/);
    });
  });

  it("permits only the null-ing of a reference, which is what account deletion needs", async () => {
    const id = await seedAuditRow();
    await db.asAdmin(async (query) => {
      await query(`update audit_logs set actor_id = null where id = $1`, [id]);
      const after = await query(`select actor_id, action, metadata from audit_logs where id = $1`, [id]);
      const r = row<{ actor_id: string | null; action: string }>(after.rows);
      expect(r.actor_id).toBeNull();
      expect(r.action).toBe("transaction.created");
    });
  });

  it("lets a user with audit history be deleted, keeping the event", async () => {
    const id = await seedAuditRow();
    await db.asAdmin(async (query) => {
      // Nothing else may reference the user, so drop their org first.
      await query(`delete from organizations where id = $1`, [orgA]);
      await query(`delete from auth.users where id = $1`, [owner]);

      const surviving = await query(`select actor_id, action from audit_logs where id = $1`, [id]);
      expect(surviving.rows).toHaveLength(1);
      expect(row<{ actor_id: string | null }>(surviving.rows).actor_id).toBeNull();
      expect(row<{ action: string }>(surviving.rows).action).toBe("transaction.created");
    });
  });
});
