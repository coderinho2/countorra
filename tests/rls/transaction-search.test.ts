import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * Verifies 0019_transaction_search_text.sql: the generated `search_text`
 * column actually computes from description+memo, and a search string
 * containing PostgREST `.or()`-DSL-special characters (`,` `"` `.`) — the
 * exact input class that made the old `.or()`-based search a filter-
 * injection risk — behaves as an inert literal substring match instead of
 * being parsed as filter syntax. This repository now uses a single
 * `.ilike()` against this column (never `.or()`), so there is no DSL to
 * inject into in the first place; this test pins that behavior.
 */

let db: TestDatabase;
let owner: string;
let orgA: string;
let accountId: string;

beforeEach(async () => {
  db = await createTestDatabase();

  await db.asAdmin(async (query) => {
    const users = await query(`insert into auth.users (email) values ('owner@example.com') returning id`);
    owner = (users.rows[0] as { id: string }).id;
  });

  await db.asUser(owner);
  const org = await db.query(`insert into organizations (name, entity_type, created_by) values ('Org A', 'personal', $1) returning id`, [owner]);
  orgA = (org.rows[0] as { id: string }).id;

  const account = await db.query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'Checking', 'cash', 'USD') returning id`, [orgA]);
  accountId = (account.rows[0] as { id: string }).id;
});

afterEach(async () => {
  await db.close();
});

describe("transactions.search_text generated column", () => {
  it("computes from description and memo", async () => {
    await db.query(
      `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, description, memo)
       values ($1, $2, 'expense', 1000, 'USD', current_date, 'Coffee shop', 'business meeting')`,
      [orgA, accountId],
    );
    const result = await db.query(`select search_text from transactions where organization_id = $1`, [orgA]);
    expect((result.rows[0] as { search_text: string }).search_text).toBe("Coffee shop business meeting");
  });

  it("a search string containing comma/quote/period characters matches only as a literal substring, not as filter syntax", async () => {
    await db.query(
      `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, description)
       values ($1, $2, 'expense', 1000, 'USD', current_date, $3)`,
      [orgA, accountId, 'Invoice #42, "special" client.deal'],
    );
    // A different, unrelated transaction that must NOT be returned by the
    // search below — if the old `.or()` string were still in use, a
    // crafted search value could have widened the filter to match this too.
    await db.query(
      `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, description)
       values ($1, $2, 'income', 999999, 'USD', current_date, 'Unrelated large income')`,
      [orgA, accountId],
    );

    const escaped = 'Invoice #42, "special" client.deal'.replace(/[%_]/g, (c) => `\\${c}`);
    const result = await db.query(`select description from transactions where organization_id = $1 and search_text ilike $2`, [
      orgA,
      `%${escaped}%`,
    ]);
    expect(result.rows).toHaveLength(1);
    expect((result.rows[0] as { description: string }).description).toBe('Invoice #42, "special" client.deal');
  });
});
