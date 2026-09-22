import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * supabase/migrations/0053_plaid_first_ledger_and_operations.sql, against the
 * real migrations (tests/rls/harness.ts).
 *
 * Bank, credit card and other accounts — and their transactions — come from a
 * bank connection. A browser session can add only cash and wallet accounts,
 * and enter transactions by hand only into cash or wallet accounts no bank
 * connection feeds. Existing data of every kind stays readable and editable.
 * The bank pipeline itself (source 'bank_sync', service role) is covered in
 * tests/rls/bank-connections.test.ts and bank-sync-engine.test.ts.
 */

const one = <T>(result: { rows: unknown[] }) => result.rows[0] as T;
const REFUSED_ACCOUNT = /only cash and wallet accounts can be added by hand/;
const REFUSED_ENTRY = /only cash and wallet transactions can be entered by hand/;

let db: TestDatabase;
let owner: string;
let outsider: string;
let org: string;
let otherOrg: string;
let cash: string;
let legacyBank: string;

async function service<T>(fn: (query: TestDatabase["query"]) => Promise<T>): Promise<T> {
  return db.asAdmin(async (query) => {
    await query("set role service_role");
    try {
      return await fn(query);
    } finally {
      await query("reset role");
    }
  });
}

const manual = (accountId: string, extra = "") =>
  db.query(
    `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, source${extra ? ", transfer_account_id" : ""}) values ($1, $2, ${extra ? "'transfer'" : "'expense'"}, 1250, 'USD', '2026-09-01', 'manual'${extra ? ", $3" : ""}) returning id`,
    extra ? [org, accountId, extra] : [org, accountId],
  );

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin(async (query) => {
    const users = await query(`insert into auth.users (email) values ('owner@example.test'), ('outsider@example.test') returning id`);
    [owner, outsider] = users.rows.map((r) => (r as { id: string }).id);
  });
  await db.asUser(owner);
  org = one<{ id: string }>(await db.query(`insert into organizations (name, entity_type, created_by) values ('Mine', 'personal', $1) returning id`, [owner])).id;
  cash = one<{ id: string }>(await db.query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'Cash', 'cash', 'USD') returning id`, [org])).id;
  await db.asUser(outsider);
  otherOrg = one<{ id: string }>(await db.query(`insert into organizations (name, entity_type, created_by) values ('Theirs', 'personal', $1) returning id`, [outsider])).id;
  // A bank account entered by hand before this migration: created here by the
  // system, which is the only way such a row can exist now.
  legacyBank = await service(async (query) =>
    one<{ id: string }>(await query(`insert into accounts (organization_id, name, kind, currency, opening_balance_minor) values ($1, 'Old checking', 'bank', 'USD', 50000) returning id`, [org])).id,
  );
});

afterEach(async () => {
  await db.close();
});

describe("accounts a person can add", () => {
  it.each(["cash", "wallet"])("allows a %s account", async (kind) => {
    await db.asUser(owner);
    await db.query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'Mine', $2, 'USD')`, [org, kind]);
  });

  it.each(["bank", "credit_card", "other"])("refuses a hand-made %s account", async (kind) => {
    await db.asUser(owner);
    await expect(db.query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'Fake', $2, 'USD')`, [org, kind])).rejects.toThrow(REFUSED_ACCOUNT);
  });

  it("refuses turning a cash account into a bank account", async () => {
    await db.asUser(owner);
    await expect(db.query(`update accounts set kind = 'bank' where id = $1`, [cash])).rejects.toThrow(REFUSED_ACCOUNT);
  });

  it("lets the system create bank accounts — the bank-connection import", async () => {
    await service((query) => query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'Imported checking', 'bank', 'USD')`, [org]));
  });
});

describe("hand-entered transactions", () => {
  it("are allowed in a cash account", async () => {
    await db.asUser(owner);
    await manual(cash);
  });

  it("are refused in a bank account", async () => {
    await db.asUser(owner);
    await expect(manual(legacyBank)).rejects.toThrow(REFUSED_ENTRY);
  });

  it("are refused as a transfer into or out of a bank account", async () => {
    await db.asUser(owner);
    await expect(manual(cash, legacyBank)).rejects.toThrow(REFUSED_ENTRY);
    await expect(manual(legacyBank, cash)).rejects.toThrow(REFUSED_ENTRY);
  });

  it("cannot be moved into a bank account after the fact", async () => {
    await db.asUser(owner);
    const id = one<{ id: string }>(await manual(cash)).id;
    await expect(db.query(`update transactions set account_id = $1 where id = $2`, [legacyBank, id])).rejects.toThrow(REFUSED_ENTRY);
  });

  it("from an AI draft follow the same rule", async () => {
    await db.asUser(owner);
    await expect(
      db.query(`insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, source) values ($1, $2, 'expense', 100, 'USD', '2026-09-01', 'ai')`, [org, legacyBank]),
    ).rejects.toThrow(REFUSED_ENTRY);
  });
});

describe("existing data stays intact and usable", () => {
  it("keeps a hand-entered bank account readable, renamable and its history editable", async () => {
    const old = await service(async (query) =>
      one<{ id: string }>(await query(`insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, source) values ($1, $2, 'expense', 900, 'USD', '2026-08-01', 'manual') returning id`, [org, legacyBank])).id,
    );
    await db.asUser(owner);
    expect((await db.query(`select name, kind from accounts where id = $1`, [legacyBank])).rows).toEqual([{ name: "Old checking", kind: "bank" }]);
    await db.query(`update accounts set name = 'Checking (old)' where id = $1`, [legacyBank]);
    await db.query(`update transactions set memo = 'lunch', amount_minor = 950 where id = $1`, [old]);
    const edited = one<{ memo: string; amount_minor: number | string }>(await db.query(`select memo, amount_minor from transactions where id = $1`, [old]));
    expect([edited.memo, Number(edited.amount_minor)]).toEqual(["lunch", 950]);
    await db.query(`delete from transactions where id = $1`, [old]);
  });
});

describe("tenant isolation of the manual-entry check", () => {
  it("does not answer about another workspace's account", async () => {
    const theirs = await service(async (query) => one<{ id: string }>(await query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'Their cash', 'cash', 'USD') returning id`, [otherOrg])).id);
    await db.asUser(owner);
    expect(one<{ ok: boolean }>(await db.query(`select account_accepts_manual_entry($1) as ok`, [theirs])).ok).toBe(false);
    expect(one<{ ok: boolean }>(await db.query(`select account_accepts_manual_entry($1) as ok`, [cash])).ok).toBe(true);
  });
});

describe("operations reporting", () => {
  it("is callable by the service role, and returns counts only", async () => {
    const summary = await service(async (query) => one<{ s: Record<string, unknown> }>(await query(`select operations_summary(now() - interval '1 day') as s`)).s);
    expect(Object.keys(summary).sort()).toEqual(
      ["aiActions", "aiRequests", "bankConnections", "bankSyncJobsActive", "bankSyncRuns", "bankWebhooks", "emails", "generatedAt", "securityEvents", "since", "stripeWebhooks"].sort(),
    );
    for (const [key, value] of Object.entries(summary)) {
      if (key === "since" || key === "generatedAt") continue;
      if (typeof value === "object" && value) for (const n of Object.values(value)) expect(typeof n).toBe("number");
      else expect(typeof value).toBe("number");
    }
    expect(await service(async (query) => one<{ v: string }>(await query(`select operations_schema_version() as v`)).v)).toBe("0053");
  });

  it("is not callable by a signed-in member or an anonymous visitor", async () => {
    await db.asUser(owner);
    await expect(db.query(`select operations_summary(now())`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select operations_schema_version()`)).rejects.toThrow(/permission denied/);
  });
});
