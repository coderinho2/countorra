import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * DATA-01: the deletion graph, executed rather than read.
 *
 * This file implements no deletion flow. It documents what the schema
 * permits and forbids, against real Postgres, so the design conversation
 * starts from verified behaviour instead of from a reading of the DDL.
 *
 * WHAT IT ORIGINALLY FOUND, AND WHAT CHANGED
 *
 * It was written before any deletion flow existed, and recorded that a USER
 * could not be deleted at all: eleven foreign keys referenced `auth.users`
 * with no ON DELETE action, one of them NOT NULL. That is no longer true, and
 * the assertions below have been updated to the current schema rather than
 * left describing the old one.
 *
 *   - 0029 converted every ATTRIBUTION column to ON DELETE SET NULL, and made
 *     `organizations.created_by` nullable. The record stays; the name comes
 *     off it.
 *   - 0033 did the same for `ai_actions.confirmed_by`, which 0029 had to skip
 *     because a CHECK required a confirmer on an approved AI write. See
 *     tests/rls/ai-action-confirmer-erasure.test.ts.
 *
 * Exactly ONE blocking reference remains by design: `ai_conversations.user_id`
 * is NOT NULL with no ON DELETE action, because a conversation is the person's
 * own data rather than an organization record with a name attached. The
 * deletion flow removes those rows explicitly instead of orphaning them.
 */

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let db: TestDatabase;
let orgId: string;

async function count(table: string, where = "", params: unknown[] = []): Promise<number> {
  return db.asAdmin(async (query) => {
    const r = await query(`select count(*)::int as n from ${table} ${where}`, params);
    return (r.rows[0] as { n: number }).n;
  });
}

beforeEach(async () => {
  db = await createTestDatabase();

  await db.asAdmin(async (query) => {
    await query(`insert into auth.users (id, email) values ($1, 'owner@example.test'), ($2, 'member@example.test')`, [OWNER, MEMBER]);
  });

  // Created as the owner: the bootstrap trigger writes an audit event and
  // `record_audit_event` refuses to run without a session.
  await db.asUser(OWNER);
  const org = await db.query(`insert into organizations (name, entity_type, created_by) values ('Acme', 'business', $1) returning id`, [OWNER]);
  orgId = (org.rows[0] as { id: string }).id;

  await db.asAdmin(async (query) => {
    await query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'employee')`, [orgId, MEMBER]);
    const acct = await query(
      `insert into accounts (organization_id, name, kind, currency, opening_balance_minor) values ($1, 'Main', 'bank', 'USD', 0) returning id`,
      [orgId],
    );
    const accountId = (acct.rows[0] as { id: string }).id;
    await query(
      `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, created_by)
       values ($1, $2, 'expense', 1000, 'USD', date '2026-09-01', $3)`,
      [orgId, accountId, OWNER],
    );
    const cust = await query(`insert into customers (organization_id, display_name) values ($1, 'Client') returning id`, [orgId]);
    const customerId = (cust.rows[0] as { id: string }).id;
    await query(
      `insert into invoices (organization_id, customer_id, invoice_number, status, currency, issue_date, subtotal_minor, tax_minor, total_minor, created_by)
       values ($1, $2, 'INV-1', 'draft', 'USD', date '2026-09-01', 1000, 0, 1000, $3)`,
      [orgId, customerId, OWNER],
    );
    await query(`insert into documents (organization_id, kind, storage_path, original_filename, uploaded_by) values ($1, 'receipt', $2, 'r.pdf', $3)`, [
      orgId,
      `${orgId}/r.pdf`,
      OWNER,
    ]);
    const conv = await query(`insert into ai_conversations (organization_id, user_id, title) values ($1, $2, 'chat') returning id`, [orgId, OWNER]);
    await query(`insert into ai_messages (conversation_id, role, content) values ($1, 'user', 'hi')`, [(conv.rows[0] as { id: string }).id]);
    await query(`insert into ai_usage (organization_id, user_id, provider, model, input_tokens, output_tokens) values ($1, $2, 'anthropic', 'm', 1, 1)`, [
      orgId,
      OWNER,
    ]);
    await query(`insert into notifications (organization_id, user_id, kind, title) values ($1, $2, 'financial_insight', 'hello')`, [orgId, OWNER]);
  });
});

afterEach(async () => {
  await db?.close();
});

describe("organization deletion", () => {
  it("succeeds and takes its whole subtree with it", async () => {
    await db.asAdmin(async (query) => {
      await query(`delete from organizations where id = $1`, [orgId]);
    });

    for (const table of [
      "memberships",
      "accounts",
      "transactions",
      "customers",
      "invoices",
      "documents",
      "ai_conversations",
      "ai_usage",
      "notifications",
      "subscriptions",
      "transaction_categories",
    ]) {
      expect(await count(table, "where organization_id = $1", [orgId]), `${table} should be empty`).toBe(0);
    }
  });

  it("cascades through the second level too", async () => {
    // ai_messages and invoice_line_items hang off rows that hang off the org.
    await db.asAdmin(async (query) => {
      await query(`delete from organizations where id = $1`, [orgId]);
    });

    expect(await count("ai_messages")).toBe(0);
    expect(await count("invoice_line_items")).toBe(0);
  });

  it("keeps the audit trail, detached rather than destroyed", async () => {
    // `audit_logs.organization_id` is ON DELETE SET NULL by design: the record
    // that something happened outlives the tenant it happened in.
    const before = await count("audit_logs");
    expect(before).toBeGreaterThan(0);

    await db.asAdmin(async (query) => {
      await query(`delete from organizations where id = $1`, [orgId]);
    });

    expect(await count("audit_logs")).toBe(before);
    expect(await count("audit_logs", "where organization_id is null")).toBe(before);
  });

  it("leaves storage objects behind — the database cannot reach them", async () => {
    // The row goes; the file in the bucket does not. Any real deletion flow
    // has to remove the object too, and nothing in the schema can do that.
    await db.asAdmin(async (query) => {
      await query(`insert into storage.objects (bucket_id, name) values ('documents', $1)`, [`${orgId}/r.pdf`]);
      await query(`delete from organizations where id = $1`, [orgId]);
      const orphans = await query(`select count(*)::int as n from storage.objects where name like $1`, [`${orgId}/%`]);
      expect((orphans.rows[0] as { n: number }).n).toBe(1);
    });
  });
});

describe("user deletion", () => {
  it("is blocked for the SOLE OWNER of a surviving workspace — by the owner rule, not by attribution", async () => {
    // The old comment here said "organizations.created_by is NOT NULL with no
    // ON DELETE action". 0029 made that false, and the test kept passing
    // anyway because something ELSE throws — so it documented a schema that
    // no longer existed while still going green.
    //
    // The actual blocker, asserted by message rather than assumed: deleting
    // the user cascades their `memberships` row, and the last-owner trigger
    // refuses to leave a live organization ownerless. This is exactly why
    // `planAccountDeletion` refuses a sole owner up front, with an error that
    // tells the user to transfer ownership first — the database would refuse
    // regardless, and it is much better to say so before deleting anything.
    await db.asAdmin(async (query) => {
      await expect(query(`delete from auth.users where id = $1`, [OWNER])).rejects.toThrow(/at least one owner/i);
    });
  });

  it("is blocked for anyone who still owns a conversation", async () => {
    // The one remaining NOT NULL / NO ACTION reference to auth.users, kept on
    // purpose: a conversation is the person's own content, not an
    // organization record with their name attached, so it is deleted rather
    // than orphaned. `deleteAccountAction` removes these explicitly.
    await db.asAdmin(async (query) => {
      await query(`insert into ai_conversations (organization_id, user_id, title) values ($1, $2, 'Chat')`, [orgId, MEMBER]);
      await expect(query(`delete from auth.users where id = $1`, [MEMBER])).rejects.toThrow(/ai_conversations/);
    });
  });

  it("succeeds for a member once their conversations are gone, leaving the workspace whole", async () => {
    // The path `deleteAccountAction` takes for a workspace the user LEAVES:
    // conversations removed, membership cascaded, account deleted, and every
    // record they touched still present with the name detached.
    await db.asAdmin(async (query) => {
      await query(`insert into ai_conversations (organization_id, user_id, title) values ($1, $2, 'Chat')`, [orgId, MEMBER]);
      await query(
        `insert into ai_usage (organization_id, user_id, provider, model, input_tokens, output_tokens) values ($1, $2, 'anthropic', 'm', 1, 1)`,
        [orgId, MEMBER],
      );

      await query(`delete from ai_conversations where user_id = $1`, [MEMBER]);
      await query(`delete from auth.users where id = $1`, [MEMBER]);
    });

    expect(await count("auth.users", "where id = $1", [MEMBER])).toBe(0);
    expect(await count("memberships", "where user_id = $1", [MEMBER])).toBe(0);

    // The workspace and its financial records are untouched.
    expect(await count("organizations", "where id = $1", [orgId])).toBe(1);
    expect(await count("transactions", "where organization_id = $1", [orgId])).toBe(1);
    expect(await count("invoices", "where organization_id = $1", [orgId])).toBe(1);

    // Their usage row survives with the name off it, rather than being
    // deleted — the cost record belongs to the organization.
    expect(await count("ai_usage", "where organization_id = $1 and user_id is null", [orgId])).toBe(1);
  });

  it("SUCCEEDS once the organization is gone, because everything cascaded with it", async () => {
    // The important nuance for any account-deletion design: the user is not
    // permanently undeletable. Every row that referenced them belonged to the
    // organization, so removing the organization removes the references too.
    //
    // Which makes the hard problem a product one rather than a schema one:
    // deleting the organization to free the user also destroys every OTHER
    // member's data. "Delete my account" cannot simply cascade.
    await db.asAdmin(async (query) => {
      await query(`delete from organizations where id = $1`, [orgId]);
      await query(`delete from auth.users where id = $1`, [OWNER]);
    });

    expect(await count("auth.users", "where id = $1", [OWNER])).toBe(0);
  });

  it("removes a non-owner member cleanly, because membership cascades", async () => {
    await db.asAdmin(async (query) => {
      await query(`delete from auth.users where id = $1`, [MEMBER]);
    });

    expect(await count("memberships", "where user_id = $1", [MEMBER])).toBe(0);
    expect(await count("auth.users", "where id = $1", [MEMBER])).toBe(0);
  });

  it("keeps audit and security history, with the actor detached", async () => {
    await db.asAdmin(async (query) => {
      const before = await query(`select count(*)::int as n from audit_logs where actor_id = $1`, [OWNER]);
      expect((before.rows[0] as { n: number }).n).toBeGreaterThan(0);

      await query(`delete from organizations where id = $1`, [orgId]);
      await query(`delete from auth.users where id = $1`, [OWNER]);

      const after = await query(`select count(*)::int as n from audit_logs where actor_id is null`);
      expect((after.rows[0] as { n: number }).n).toBeGreaterThan(0);
    });
  });
});

describe("intra-tenant restrictions that shape any deletion flow", () => {
  it("refuses to delete an account that still has transactions", async () => {
    await db.asAdmin(async (query) => {
      const a = await query(`select id from accounts where organization_id = $1`, [orgId]);
      await expect(query(`delete from accounts where id = $1`, [(a.rows[0] as { id: string }).id])).rejects.toThrow();
    });
  });

  it("refuses to delete a customer that still has invoices", async () => {
    await db.asAdmin(async (query) => {
      const c = await query(`select id from customers where organization_id = $1`, [orgId]);
      await expect(query(`delete from customers where id = $1`, [(c.rows[0] as { id: string }).id])).rejects.toThrow();
    });
  });

  it("still refuses to strip the last owner from a live organization", async () => {
    await db.asAdmin(async (query) => {
      await expect(query(`delete from memberships where organization_id = $1 and role = 'owner'`, [orgId])).rejects.toThrow();
    });
  });
});
