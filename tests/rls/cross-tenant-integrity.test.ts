import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * Verifies 0020_cross_table_tenant_integrity.sql: a row can no longer
 * reference another organization's account/category/merchant/customer/
 * conversation, even when the referencing row's own `organization_id` is
 * "correct" and RLS alone would have let the insert proceed to this
 * point. Found during the Phase 2 security review — see that
 * migration's module comment for the full reasoning (the AI write path
 * is what made this a real risk, not just a theoretical one).
 */

let db: TestDatabase;
let owner: string;
let orgA: string;
let orgB: string;
let accountA: string;
let accountB: string;
let categoryB: string;
let merchantB: string;
let customerB: string;

beforeEach(async () => {
  db = await createTestDatabase();

  await db.asAdmin(async (query) => {
    const users = await query(`insert into auth.users (email) values ('owner@example.com') returning id`);
    owner = (users.rows[0] as { id: string }).id;
  });

  await db.asUser(owner);
  const a = await db.query(`insert into organizations (name, entity_type, created_by) values ('Org A', 'personal', $1) returning id`, [owner]);
  orgA = (a.rows[0] as { id: string }).id;
  const b = await db.query(`insert into organizations (name, entity_type, created_by) values ('Org B', 'personal', $1) returning id`, [owner]);
  orgB = (b.rows[0] as { id: string }).id;

  const accA = await db.query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'A Checking', 'cash', 'USD') returning id`, [orgA]);
  accountA = (accA.rows[0] as { id: string }).id;
  const accB = await db.query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'B Checking', 'cash', 'USD') returning id`, [orgB]);
  accountB = (accB.rows[0] as { id: string }).id;

  const cat = await db.query(`insert into transaction_categories (organization_id, kind, name) values ($1, 'expense', 'B Category') returning id`, [orgB]);
  categoryB = (cat.rows[0] as { id: string }).id;
  const merch = await db.query(`insert into merchants (organization_id, name, normalized_name) values ($1, 'B Merchant', 'b merchant') returning id`, [orgB]);
  merchantB = (merch.rows[0] as { id: string }).id;
  const cust = await db.query(`insert into customers (organization_id, display_name) values ($1, 'B Customer') returning id`, [orgB]);
  customerB = (cust.rows[0] as { id: string }).id;
});

afterEach(async () => {
  await db.close();
});

describe("cross-tenant foreign key integrity", () => {
  it("allows a transaction whose account belongs to the same organization", async () => {
    const result = await db.query(
      `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on) values ($1, $2, 'expense', 1000, 'USD', current_date) returning id`,
      [orgA, accountA],
    );
    expect(result.rows).toHaveLength(1);
  });

  it("rejects a transaction whose account_id belongs to a different organization, even with a matching organization_id", async () => {
    await expect(
      db.query(
        `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on) values ($1, $2, 'expense', 1000, 'USD', current_date)`,
        [orgA, accountB],
      ),
    ).rejects.toThrow();
  });

  it("rejects a transaction whose category_id belongs to a different organization", async () => {
    await expect(
      db.query(
        `insert into transactions (organization_id, account_id, category_id, kind, amount_minor, currency, occurred_on) values ($1, $2, $3, 'expense', 1000, 'USD', current_date)`,
        [orgA, accountA, categoryB],
      ),
    ).rejects.toThrow();
  });

  it("rejects a transaction whose merchant_id belongs to a different organization", async () => {
    await expect(
      db.query(
        `insert into transactions (organization_id, account_id, merchant_id, kind, amount_minor, currency, occurred_on) values ($1, $2, $3, 'expense', 1000, 'USD', current_date)`,
        [orgA, accountA, merchantB],
      ),
    ).rejects.toThrow();
  });

  it("rejects an invoice whose customer_id belongs to a different organization", async () => {
    await expect(
      db.query(
        `insert into invoices (organization_id, customer_id, invoice_number, currency) values ($1, $2, 'INV-1', 'USD')`,
        [orgA, customerB],
      ),
    ).rejects.toThrow();
  });

  it("still allows a null category_id/merchant_id (optional fields)", async () => {
    const result = await db.query(
      `insert into transactions (organization_id, account_id, category_id, merchant_id, kind, amount_minor, currency, occurred_on) values ($1, $2, null, null, 'expense', 1000, 'USD', current_date) returning id`,
      [orgA, accountA],
    );
    expect(result.rows).toHaveLength(1);
  });
});
