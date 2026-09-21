import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";
import { spendByCategoryFromTotals, summarizeTotals, type CategoryTotalRow, type TransactionTotalRow } from "@/domain/financial/calculation-engine";
import { totalInBaseCurrency } from "@/domain/money/aggregate";
import type { CurrencyCode } from "@/domain/money/currency";

/**
 * FIN-01 regression, against real Postgres.
 *
 * The bug these cover is not "the sum was computed wrongly" — the JavaScript
 * arithmetic was always right. It is that PostgREST handed that arithmetic
 * only the first `max_rows` (1000) rows and said nothing, so the sum was
 * exact over the wrong set. A unit test with a mocked client could never have
 * caught it, because the truncation happened below the mock.
 *
 * So the row-cap tests here deliberately seed **more than 1000 rows** and
 * assert an exact expected total. If aggregation ever moves back into
 * application code, these fail.
 *
 * They also assert the other half of the fix: these functions are
 * `security invoker`, so they must be governed by the same RLS that governs a
 * direct select — including for a non-member, who must get nothing rather
 * than a number.
 */

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACCOUNT_A2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ACCOUNT_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/** Comfortably past PostgREST's 1000-row cap, and an odd number so an
 *  off-by-one in any windowing shows up as a wrong total rather than a
 *  coincidentally-right one. */
const INCOME_ROWS = 900;
const EXPENSE_ROWS = 700;
const TOTAL_ROWS = INCOME_ROWS + EXPENSE_ROWS; // 1600

const INCOME_EACH = 1_000; // 10.00
const EXPENSE_EACH = 250; // 2.50
const OPENING = 50_000; // 500.00

const EXPECTED_INCOME = INCOME_ROWS * INCOME_EACH; // 900_000
const EXPECTED_EXPENSE = EXPENSE_ROWS * EXPENSE_EACH; // 175_000
const EXPECTED_BALANCE = OPENING + EXPECTED_INCOME - EXPECTED_EXPENSE; // 775_000

function rows<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

describe("financial aggregates (FIN-01)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();

    await db.asAdmin(async (query) => {
      await query(`insert into auth.users (id, email) values ($1, 'a@example.test'), ($2, 'b@example.test')`, [OWNER_A, OWNER_B]);
    });

    // Organizations are created AS the owner, not as admin: the
    // `bootstrap_new_organization` trigger writes an audit event, and
    // `record_audit_event` refuses to run without an authenticated session.
    // Seeding through the real path is also what gives each owner a real
    // membership row for RLS to key on below.
    await db.asUser(OWNER_A);
    await db.query(`insert into organizations (id, name, entity_type, country, base_currency, created_by) values ($1, 'Org A', 'personal', 'US', 'USD', $2)`, [ORG_A, OWNER_A]);
    await db.asUser(OWNER_B);
    await db.query(`insert into organizations (id, name, entity_type, country, base_currency, created_by) values ($1, 'Org B', 'personal', 'US', 'USD', $2)`, [ORG_B, OWNER_B]);

    await db.asAdmin(async (query) => {
      await query(`insert into accounts (id, organization_id, name, kind, currency, opening_balance_minor) values ($1, $2, 'Main', 'bank', 'USD', $3)`, [ACCOUNT_A, ORG_A, OPENING]);
      await query(`insert into accounts (id, organization_id, name, kind, currency, opening_balance_minor) values ($1, $2, 'Euro', 'bank', 'EUR', 0)`, [ACCOUNT_A2, ORG_A]);
      await query(`insert into accounts (id, organization_id, name, kind, currency, opening_balance_minor) values ($1, $2, 'B Main', 'bank', 'USD', 999999)`, [ACCOUNT_B, ORG_B]);

      // generate_series rather than 1600 round trips.
      await query(
        `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, description, is_reviewed)
         select $1, $2, 'income', $3, 'USD', date '2026-03-01', 'salary ' || g, (g % 2 = 0)
         from generate_series(1, $4) g`,
        [ORG_A, ACCOUNT_A, INCOME_EACH, INCOME_ROWS],
      );
      await query(
        `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, description, is_reviewed)
         select $1, $2, 'expense', $3, 'USD', date '2026-03-02', 'coffee ' || g, false
         from generate_series(1, $4) g`,
        [ORG_A, ACCOUNT_A, EXPENSE_EACH, EXPENSE_ROWS],
      );

      // One row far outside the period, to prove date filtering is real.
      await query(
        `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, description)
         values ($1, $2, 'income', 99999999, 'USD', date '2020-01-01', 'ancient')`,
        [ORG_A, ACCOUNT_A],
      );

      await query(
        `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, description)
         values ($1, $2, 'expense', 500000, 'USD', date '2026-03-01', 'org b spend')`,
        [ORG_B, ACCOUNT_B],
      );
    });
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  describe("above the 1000-row cap", () => {
    it("sums an account balance over 1600 transactions exactly", async () => {
      await db.asUser(OWNER_A);
      const result = await db.query(`select * from account_balances_minor($1) where account_id = $2`, [ORG_A, ACCOUNT_A]);
      const [balance] = rows<{ balance_minor: string | number }>(result);

      // 1600 rows in the period + 1 ancient one, all on this account.
      expect(Number(balance.balance_minor)).toBe(EXPECTED_BALANCE + 99999999);
    });

    it("sums period totals over 1600 transactions exactly", async () => {
      await db.asUser(OWNER_A);
      const result = await db.query(`select * from transaction_totals($1, null, null, null, null, $2, $3)`, [ORG_A, "2026-03-01", "2026-03-31"]);
      const totals = rows<{ kind: string; total_minor: string; transaction_count: string }>(result);

      const income = totals.find((t) => t.kind === "income");
      const expense = totals.find((t) => t.kind === "expense");

      expect(Number(income?.total_minor)).toBe(EXPECTED_INCOME);
      expect(Number(income?.transaction_count)).toBe(INCOME_ROWS);
      expect(Number(expense?.total_minor)).toBe(EXPECTED_EXPENSE);
      expect(Number(expense?.transaction_count)).toBe(EXPENSE_ROWS);
    });

    it("counts every matching row, not the first 1000", async () => {
      await db.asUser(OWNER_A);
      const result = await db.query(`select * from transaction_totals($1, null, null, null, null, $2, $3)`, [ORG_A, "2026-03-01", "2026-03-31"]);
      const total = rows<{ transaction_count: string }>(result).reduce((sum, r) => sum + Number(r.transaction_count), 0);
      expect(total).toBe(TOTAL_ROWS);
      expect(total).toBeGreaterThan(1000);
    });

    it("sums spend by category over the full set", async () => {
      await db.asUser(OWNER_A);
      const result = await db.query(`select * from transaction_category_totals($1, $2, $3)`, [ORG_A, "2026-03-01", "2026-03-31"]);
      const totals = rows<{ total_minor: string }>(result);
      expect(totals.reduce((sum, r) => sum + Number(r.total_minor), 0)).toBe(EXPECTED_EXPENSE);
    });
  });

  describe("filters", () => {
    it("respects the date range", async () => {
      await db.asUser(OWNER_A);
      const result = await db.query(`select * from transaction_totals($1, 'income', null, null, null, $2, $3)`, [ORG_A, "2020-01-01", "2020-12-31"]);
      const [income] = rows<{ total_minor: string; transaction_count: string }>(result);
      expect(Number(income.total_minor)).toBe(99999999);
      expect(Number(income.transaction_count)).toBe(1);
    });

    it("respects the kind filter", async () => {
      await db.asUser(OWNER_A);
      const result = await db.query(`select * from transaction_totals($1, 'expense', null, null, null, $2, $3)`, [ORG_A, "2026-03-01", "2026-03-31"]);
      expect(rows(result)).toHaveLength(1);
      expect(Number(rows<{ total_minor: string }>(result)[0].total_minor)).toBe(EXPECTED_EXPENSE);
    });

    it("respects the reviewed filter and reports unreviewed counts", async () => {
      await db.asUser(OWNER_A);
      const result = await db.query(
        `select * from transaction_totals($1, 'income', null, null, null, $2, $3, null, null, false)`,
        [ORG_A, "2026-03-01", "2026-03-31"],
      );
      const [income] = rows<{ transaction_count: string; unreviewed_count: string }>(result);
      // Odd-numbered income rows were seeded unreviewed.
      expect(Number(income.transaction_count)).toBe(INCOME_ROWS / 2);
      expect(Number(income.unreviewed_count)).toBe(INCOME_ROWS / 2);
    });

    it("respects the amount range", async () => {
      await db.asUser(OWNER_A);
      const result = await db.query(
        `select * from transaction_totals($1, null, null, null, null, $2, $3, $4, $5)`,
        [ORG_A, "2026-03-01", "2026-03-31", 500, 5000],
      );
      const totals = rows<{ kind: string; transaction_count: string }>(result);
      // Only the 10.00 income rows fall in [5.00, 50.00]; 2.50 expenses don't.
      expect(totals).toHaveLength(1);
      expect(totals[0].kind).toBe("income");
      expect(Number(totals[0].transaction_count)).toBe(INCOME_ROWS);
    });

    it("respects an escaped search pattern", async () => {
      await db.asUser(OWNER_A);
      const result = await db.query(
        `select * from transaction_totals($1, null, null, null, null, null, null, null, null, null, null, $2)`,
        [ORG_A, "coffee"],
      );
      const [expense] = rows<{ total_minor: string; transaction_count: string }>(result);
      expect(Number(expense.transaction_count)).toBe(EXPENSE_ROWS);
      expect(Number(expense.total_minor)).toBe(EXPECTED_EXPENSE);
    });
  });

  describe("tenant isolation (security invoker + RLS)", () => {
    it("returns nothing to a non-member asking about another organization", async () => {
      await db.asUser(OWNER_B);
      const totals = await db.query(`select * from transaction_totals($1)`, [ORG_A]);
      const balances = await db.query(`select * from account_balances_minor($1)`, [ORG_A]);
      const categories = await db.query(`select * from transaction_category_totals($1)`, [ORG_A]);

      expect(rows(totals)).toHaveLength(0);
      expect(rows(balances)).toHaveLength(0);
      expect(rows(categories)).toHaveLength(0);
    });

    it("never leaks another organization's rows into a member's own aggregate", async () => {
      await db.asUser(OWNER_A);
      const result = await db.query(`select * from transaction_totals($1)`, [ORG_A]);
      const totals = rows<{ kind: string; total_minor: string }>(result);
      const expense = totals.find((t) => t.kind === "expense");
      // Org B's 5000.00 expense must not appear in Org A's total.
      expect(Number(expense?.total_minor)).toBe(EXPECTED_EXPENSE);
    });

    it("gives each organization only its own account balances", async () => {
      await db.asUser(OWNER_B);
      const result = await db.query(`select * from account_balances_minor($1)`, [ORG_B]);
      const balances = rows<{ account_id: string; balance_minor: string }>(result);
      expect(balances).toHaveLength(1);
      expect(balances[0].account_id).toBe(ACCOUNT_B);
      expect(Number(balances[0].balance_minor)).toBe(999999 - 500000);
    });

    it("returns nothing at all to an unauthenticated caller", async () => {
      await db.asAdmin(async (query) => {
        await query(`set role anon`);
        // anon has no EXECUTE grant, so this must fail rather than answer.
        await expect(query(`select * from transaction_totals($1)`, [ORG_A])).rejects.toThrow();
        await query(`reset role`);
      });
    });
  });

  /**
   * FIN-02. The transactions page showed "In / Out / Net" reduced from the 50
   * rows of the current page, rendered in the same strip as `result.total` —
   * the count across the entire filtered set. Both numbers were individually
   * correct and the pair was badly misleading.
   *
   * The property that fixes it is structural: `transaction_totals` takes no
   * page or page-size argument at all, so it cannot express a page-scoped
   * answer. These assert that the property actually holds against the same
   * 1,600-row fixture — well past both the 50-row page and the 1000-row cap.
   */
  describe("page-independent totals (FIN-02)", () => {
    const PERIOD: [string, string] = ["2026-03-01", "2026-03-31"];

    async function totalsForPeriod() {
      const result = await db.query(`select * from transaction_totals($1, null, null, null, null, $2, $3)`, [ORG_A, ...PERIOD]);
      return rows<{ kind: string; total_minor: string; transaction_count: string }>(result);
    }

    /** The same query listTransactions issues for one page. */
    async function pageOfRows(page: number, pageSize = 50) {
      const result = await db.query(
        `select id, kind, amount_minor from transactions
         where organization_id = $1 and occurred_on between $2 and $3
         order by occurred_on desc, id
         limit $4 offset $5`,
        [ORG_A, ...PERIOD, pageSize, (page - 1) * pageSize],
      );
      return rows<{ id: string; kind: string; amount_minor: string }>(result);
    }

    it("has far more matching transactions than fit on one 50-row page", async () => {
      await db.asUser(OWNER_A);
      const [page1, totals] = [await pageOfRows(1), await totalsForPeriod()];
      const matching = totals.reduce((sum, t) => sum + Number(t.transaction_count), 0);

      expect(page1).toHaveLength(50);
      expect(matching).toBe(TOTAL_ROWS);
      expect(matching).toBeGreaterThan(50);
    });

    it("totals cover every matching transaction, not the 50 on screen", async () => {
      await db.asUser(OWNER_A);
      const totals = await totalsForPeriod();
      const income = Number(totals.find((t) => t.kind === "income")?.total_minor);

      expect(income).toBe(EXPECTED_INCOME);
      // What the page used to display: the income among the first 50 rows.
      const page1 = await pageOfRows(1);
      const pageIncome = page1.filter((r) => r.kind === "income").reduce((sum, r) => sum + Number(r.amount_minor), 0);
      expect(pageIncome).toBeLessThan(income);
    });

    it("does not change when the reader moves to another page", async () => {
      await db.asUser(OWNER_A);
      const first = await totalsForPeriod();
      const page2 = await pageOfRows(2);
      const page10 = await pageOfRows(10);
      const after = await totalsForPeriod();

      expect(page2).toHaveLength(50);
      expect(page10).toHaveLength(50);
      expect(after).toEqual(first);
    });

    it("returns different rows per page while the totals stay fixed", async () => {
      await db.asUser(OWNER_A);
      const [page1, page2] = [await pageOfRows(1), await pageOfRows(2)];
      const overlap = page1.filter((r) => page2.some((o) => o.id === r.id));

      expect(overlap).toHaveLength(0);
      expect(await totalsForPeriod()).toEqual(await totalsForPeriod());
    });

    it("changes correctly when a filter changes", async () => {
      await db.asUser(OWNER_A);
      const all = await totalsForPeriod();
      const expensesOnly = rows<{ kind: string; total_minor: string }>(
        await db.query(`select * from transaction_totals($1, 'expense', null, null, null, $2, $3)`, [ORG_A, ...PERIOD]),
      );

      expect(all).toHaveLength(2);
      expect(expensesOnly).toHaveLength(1);
      expect(Number(expensesOnly[0].total_minor)).toBe(EXPECTED_EXPENSE);
      expect(Number(expensesOnly[0].total_minor)).not.toBe(Number(all.find((t) => t.kind === "income")?.total_minor));
    });

    it("reports an unreviewed count across the whole filtered set, not the page", async () => {
      await db.asUser(OWNER_A);
      const totals = await totalsForPeriod();
      const unreviewed = totals.reduce((sum, t) => sum + Number((t as unknown as { unreviewed_count: string }).unreviewed_count), 0);

      // Every expense plus the odd-numbered income rows were seeded unreviewed.
      expect(unreviewed).toBe(EXPENSE_ROWS + INCOME_ROWS / 2);
      expect(unreviewed).toBeGreaterThan(50);
    });

    it("does not change when the page size changes", async () => {
      await db.asUser(OWNER_A);
      const totals = await totalsForPeriod();

      // The three page sizes the app can produce: the default, the clamp
      // ceiling, and one in between. None is an input to the totals query.
      for (const pageSize of [25, 50, 200]) {
        const page = await pageOfRows(1, pageSize);
        expect(page).toHaveLength(pageSize);
        expect(await totalsForPeriod()).toEqual(totals);
      }
    });

    it("still returns totals for a filtered set smaller than one page", async () => {
      await db.asUser(OWNER_A);
      const result = await db.query(`select * from transaction_totals($1, null, null, null, null, $2, $3)`, [ORG_A, "2020-01-01", "2020-12-31"]);
      const totals = rows<{ total_minor: string; transaction_count: string }>(result);

      expect(totals).toHaveLength(1);
      expect(Number(totals[0].transaction_count)).toBe(1);
      expect(Number(totals[0].total_minor)).toBe(99999999);
    });
  });

  /**
   * The other half of FIN-01: the SQL is only correct if what the application
   * builds ON TOP of it is correct too. These take the real aggregate output —
   * over 1,600 rows, past the cap — and run it through the exact domain
   * functions the dashboard and the reports page use, asserting the composed
   * figures rather than the raw sums.
   *
   * Without this, the SQL tests above and the domain tests in
   * src/domain/financial could both pass while the seam between them is wrong.
   */
  describe("dashboard and report composition above the row limit", () => {
    async function totalRows(from: string, to: string): Promise<TransactionTotalRow[]> {
      await db.asUser(OWNER_A);
      const result = await db.query(`select * from transaction_totals($1, null, null, null, null, $2, $3)`, [ORG_A, from, to]);
      return rows<{ currency: string; kind: string; total_minor: string; transaction_count: string; unreviewed_count: string }>(result).map((r) => ({
        currency: r.currency as CurrencyCode,
        kind: r.kind as TransactionTotalRow["kind"],
        totalMinor: Number(r.total_minor),
        transactionCount: Number(r.transaction_count),
        unreviewedCount: Number(r.unreviewed_count),
      }));
    }

    it("produces an exact profit-and-loss over 1600 transactions", async () => {
      const summary = summarizeTotals(await totalRows("2026-03-01", "2026-03-31"), "USD");

      expect(summary.income.amountMinor).toBe(EXPECTED_INCOME);
      expect(summary.expense.amountMinor).toBe(EXPECTED_EXPENSE);
      expect(summary.profit.amountMinor).toBe(EXPECTED_INCOME - EXPECTED_EXPENSE);
      expect(summary.transactionCount).toBe(TOTAL_ROWS);
      expect(summary.transactionCount).toBeGreaterThan(1000);
    });

    it("produces an exact dashboard balance total over 1600 transactions", async () => {
      await db.asUser(OWNER_A);
      const balanceRows = rows<{ account_id: string; currency: string; balance_minor: string }>(
        await db.query(`select * from account_balances_minor($1)`, [ORG_A]),
      );
      const total = totalInBaseCurrency(
        balanceRows.map((b) => ({ amountMinor: Number(b.balance_minor), currency: b.currency as CurrencyCode })),
        "USD",
      );

      // The USD account only — the EUR one is excluded, not converted.
      expect(total.total.amountMinor).toBe(EXPECTED_BALANCE + 99999999);
      expect(total.includedCount).toBe(1);
    });

    it("produces exact category totals over 1600 transactions", async () => {
      await db.asUser(OWNER_A);
      const categoryRows: CategoryTotalRow[] = rows<{ category_id: string | null; currency: string; total_minor: string }>(
        await db.query(`select * from transaction_category_totals($1, $2, $3)`, [ORG_A, "2026-03-01", "2026-03-31"]),
      ).map((r) => ({ categoryId: r.category_id, currency: r.currency as CurrencyCode, totalMinor: Number(r.total_minor) }));

      const byCategory = spendByCategoryFromTotals(categoryRows, "USD");
      expect(byCategory.reduce((sum, c) => sum + c.total.amountMinor, 0)).toBe(EXPECTED_EXPENSE);
    });

    it("keeps a period comparison exact when both periods exceed the cap", async () => {
      const current = summarizeTotals(await totalRows("2026-03-01", "2026-03-31"), "USD");
      const previous = summarizeTotals(await totalRows("2020-01-01", "2020-12-31"), "USD");

      expect(current.income.amountMinor).toBe(EXPECTED_INCOME);
      expect(previous.income.amountMinor).toBe(99999999);
      expect(current.income.amountMinor - previous.income.amountMinor).toBe(EXPECTED_INCOME - 99999999);
    });

    it("never silently reports a round 1000 anywhere", async () => {
      // The signature of the original bug: a count that lands exactly on the
      // cap. Nothing the pipeline produces should equal it by coincidence.
      const summary = summarizeTotals(await totalRows("2026-03-01", "2026-03-31"), "USD");
      expect(summary.transactionCount).not.toBe(1000);
      expect(summary.income.amountMinor).not.toBe(1000 * INCOME_EACH);
    });
  });

  describe("mixed currency (FIN-03 groundwork)", () => {
    it("keeps currencies in separate rows rather than collapsing them", async () => {
      await db.asAdmin(async (query) => {
        await query(
          `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, description)
           values ($1, $2, 'income', 12345, 'EUR', date '2026-03-05', 'euro invoice')`,
          [ORG_A, ACCOUNT_A2],
        );
      });

      await db.asUser(OWNER_A);
      const result = await db.query(`select * from transaction_totals($1, 'income', null, null, null, $2, $3)`, [ORG_A, "2026-03-01", "2026-03-31"]);
      const totals = rows<{ currency: string; total_minor: string }>(result);

      expect(totals).toHaveLength(2);
      expect(Number(totals.find((t) => t.currency === "USD")?.total_minor)).toBe(EXPECTED_INCOME);
      expect(Number(totals.find((t) => t.currency === "EUR")?.total_minor)).toBe(12345);
    });
  });
});
