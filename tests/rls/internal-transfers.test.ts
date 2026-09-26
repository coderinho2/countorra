import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";
import { createPgliteBankStore } from "../fixtures/bank-store-pglite";
import { reconcileConnection } from "@/server/bank-connections/sync";

/**
 * supabase/migrations/0057_internal_transfers.sql, against the real
 * migrations (tests/rls/harness.ts).
 *
 * The application decides which two transactions look like a transfer; this
 * function is what actually moves the money, and it re-checks every one of
 * those decisions. These cases run it as the SERVICE ROLE — the most
 * privileged caller there is, and the one a future application bug would be
 * running as. If it refuses here, no application change can produce a wrong
 * pairing.
 *
 * The figures are asserted through the real balance view, so "one movement,
 * not two" is proven against the engine rather than against the row.
 */

const one = <T>(result: { rows: unknown[] }) => result.rows[0] as T;

let db: TestDatabase;
let owner: string;
let orgA: string;
let orgB: string;
let checking: string;
let savings: string;
let card: string;
let connectionA: string;
let linkChecking: string;
let linkSavings: string;
let linkCard: string;

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

async function account(org: string, name: string, kind: string): Promise<string> {
  return service(async (query) =>
    one<{ id: string }>(await query(`insert into accounts (organization_id, name, kind, currency) values ($1, $2, $3, 'USD') returning id`, [org, name, kind])).id,
  );
}

async function connection(org: string, providerId: string): Promise<string> {
  return service(async (query) => {
    const id = one<{ id: string }>(
      await query(`insert into bank_connections (organization_id, provider, provider_connection_id, institution_name) values ($1, 'fixture', $2, 'Synthetic Bank') returning id`, [org, providerId]),
    ).id;
    await query(`select bank_transition_connection($1, $2, 'PENDING', 'ACTIVE', 'LINK_COMPLETED', null)`, [org, id]);
    return id;
  });
}

/** An external account is always recorded unlinked and then linked on
 *  purpose, which is the guard in 0047 — the fixture follows the same path a
 *  person does rather than writing the end state directly. */
async function link(org: string, connectionId: string, accountId: string, providerAccountId: string, accountType = "DEPOSITORY"): Promise<string> {
  return service(async (query) => {
    const id = one<{ id: string }>(
      await query(
        `insert into bank_linked_accounts (organization_id, connection_id, provider_account_id, account_type, display_name, currency)
         values ($1, $2, $3, $4, 'Synthetic account', 'USD') returning id`,
        [org, connectionId, providerAccountId, accountType],
      ),
    ).id;
    await query(`select bank_link_account($1, $2, $3, 'IMPORT', null)`, [org, id, accountId]);
    return id;
  });
}

let hashSeed = 0;
async function external(
  org: string,
  connectionId: string,
  linkedId: string,
  over: { direction?: string; amountMinor?: number; date?: string; currency?: string; providerId?: string; category?: string } = {},
): Promise<string> {
  const amount = over.amountMinor ?? 50_000;
  hashSeed += 1;
  return service(async (query) =>
    one<{ id: string }>(
      await query(
        `insert into bank_external_transactions (organization_id, connection_id, linked_account_id, provider, provider_transaction_id, status, direction,
           amount_decimal, amount_minor, currency, transaction_date, merchant_name, category_hint, content_hash)
         values ($1, $2, $3, 'fixture', $4, 'POSTED', $5, $6, $7, $8, $9, 'Transfer', $11, $10) returning id`,
        [
          org,
          connectionId,
          linkedId,
          over.providerId ?? `tx-${hashSeed}`,
          over.direction ?? "DEBIT",
          (amount / 100).toFixed(2),
          amount,
          over.currency ?? "USD",
          over.date ?? "2026-09-10",
          String(hashSeed).padStart(64, "0"),
          over.category ?? null,
        ],
      ),
    ).id,
  );
}

const pair = (org: string, source: string, counterpart: string, sourceRev = 1, counterpartRev = 1) =>
  service(async (query) => one<{ r: string }>(await query(`select bank_pair_internal_transfer($1, $2, $3, $4, $5, null, null) as r`, [org, source, counterpart, sourceRev, counterpartRev])).r);

/** Read through the real balance function, so "the money moved" is proven
 *  against the engine the product uses rather than against the row. */
const balance = (org: string, accountId: string) =>
  service(async (query) =>
    Number(one<{ b: number }>(await query(`select balance_minor as b from account_balances_minor($1) where account_id = $2`, [org, accountId])).b),
  );

const ledgerRows = () => service(async (query) => (await query(`select account_id, transfer_account_id, kind, amount_minor from transactions order by created_at`)).rows);

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin(async (query) => {
    owner = one<{ id: string }>(await query(`insert into auth.users (email) values ('owner@example.test') returning id`)).id;
  });
  await db.asUser(owner);
  orgA = one<{ id: string }>(await db.query(`insert into organizations (name, entity_type, created_by) values ('Mine', 'personal', $1) returning id`, [owner])).id;
  orgB = one<{ id: string }>(await db.query(`insert into organizations (name, entity_type, created_by) values ('Other', 'personal', $1) returning id`, [owner])).id;

  checking = await account(orgA, "Checking", "bank");
  savings = await account(orgA, "Savings", "bank");
  card = await account(orgA, "Card", "credit_card");
  connectionA = await connection(orgA, "item-a");
  linkChecking = await link(orgA, connectionA, checking, "acct-checking");
  linkSavings = await link(orgA, connectionA, savings, "acct-savings");
  linkCard = await link(orgA, connectionA, card, "acct-card", "CREDIT");
});

afterEach(async () => {
  await db.close();
});

describe("a transfer becomes one movement, not two", () => {
  it("writes a single transfer row and moves the money both ways", async () => {
    const debit = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    const creditLeg = await external(orgA, connectionA, linkSavings, { direction: "CREDIT" });

    expect(await pair(orgA, debit, creditLeg)).toBe("APPLIED");

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_id: checking, transfer_account_id: savings, kind: "transfer" });

    // The whole point: money left one account and arrived at the other.
    expect(await balance(orgA, checking)).toBe(-50_000);
    expect(await balance(orgA, savings)).toBe(50_000);
  });

  it("counts as neither income nor expense", async () => {
    const debit = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    const creditLeg = await external(orgA, connectionA, linkSavings, { direction: "CREDIT" });
    await pair(orgA, debit, creditLeg);

    const totals = await service(async (query) =>
      one<{ income: number; expense: number }>(
        await query(
          `select coalesce(sum(amount_minor) filter (where kind = 'income'), 0) as income,
                  coalesce(sum(amount_minor) filter (where kind = 'expense'), 0) as expense
             from transactions where organization_id = $1`,
          [orgA],
        ),
      ),
    );
    expect([Number(totals.income), Number(totals.expense)]).toEqual([0, 0]);
  });

  it("marks both legs, one owning the row and one owning none", async () => {
    const debit = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    const creditLeg = await external(orgA, connectionA, linkSavings, { direction: "CREDIT" });
    await pair(orgA, debit, creditLeg);

    const legs = await service(async (query) =>
      (await query(`select id, reconciliation_state, transfer_role, transfer_counterpart_id, ledger_transaction_id from bank_external_transactions order by transfer_role`)).rows,
    );
    expect(legs).toMatchObject([
      { id: creditLeg, reconciliation_state: "IGNORED", transfer_role: "COUNTERPART", transfer_counterpart_id: debit, ledger_transaction_id: null },
      { id: debit, reconciliation_state: "IMPORTED", transfer_role: "SOURCE", transfer_counterpart_id: creditLeg },
    ]);
  });

  it("records the pairing on both legs, so it can be traced", async () => {
    const debit = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    const creditLeg = await external(orgA, connectionA, linkSavings, { direction: "CREDIT" });
    await pair(orgA, debit, creditLeg);
    const revisions = await service(async (query) =>
      Number(one<{ n: number }>(await query(`select count(*)::int as n from bank_transaction_revisions where change_kind = 'TRANSFER_PAIRED'`)).n),
    );
    expect(revisions).toBe(2);
  });

  it("pays a credit card without adding an expense or an income", async () => {
    const payment = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    const received = await external(orgA, connectionA, linkCard, { direction: "CREDIT" });
    expect(await pair(orgA, payment, received)).toBe("APPLIED");

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "transfer", account_id: checking, transfer_account_id: card });
    // The card's own purchases are untouched and remain the expenses.
    expect(await balance(orgA, checking)).toBe(-50_000);
    expect(await balance(orgA, card)).toBe(50_000);
  });
});

describe("delayed arrival is corrected in place, never by deleting", () => {
  it("turns an already-imported expense into the transfer", async () => {
    const debit = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    // The debit leg imported days earlier, before its counterpart existed.
    const ledgerId = await service(async (query) => {
      const id = one<{ id: string }>(
        await query(
          `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, description, source)
           values ($1, $2, 'expense', 50000, 'USD', '2026-09-10', 'Transfer', 'bank_sync') returning id`,
          [orgA, checking],
        ),
      ).id;
      await query(
        `update bank_external_transactions set ledger_transaction_id = $2, ledger_link_kind = 'IMPORTED', ledger_linked_at = now(), reconciliation_state = 'IMPORTED',
           needs_reconciliation = false, ledger_written_account_id = $3, ledger_written_kind = 'expense', ledger_written_amount_minor = 50000,
           ledger_written_currency = 'USD', ledger_written_occurred_on = '2026-09-10', ledger_written_description = 'Transfer' where id = $1`,
        [debit, id, checking],
      );
      return id;
    });

    const creditLeg = await external(orgA, connectionA, linkSavings, { direction: "CREDIT" });
    expect(await pair(orgA, debit, creditLeg)).toBe("APPLIED");

    const rows = await ledgerRows();
    // Corrected, not duplicated: still exactly one row, and the same one.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "transfer", transfer_account_id: savings });
    expect(await service(async (query) => one<{ id: string }>(await query(`select id from transactions`)).id)).toBe(ledgerId);
    expect(await balance(orgA, savings)).toBe(50_000);
  });

  it("refuses to correct a row a person has edited", async () => {
    const debit = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    await service(async (query) => {
      const id = one<{ id: string }>(
        await query(
          `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, description, source)
           values ($1, $2, 'expense', 50000, 'USD', '2026-09-10', 'Renamed by the user', 'bank_sync') returning id`,
          [orgA, checking],
        ),
      ).id;
      // What the sync last wrote no longer matches the row: somebody changed it.
      await query(
        `update bank_external_transactions set ledger_transaction_id = $2, ledger_link_kind = 'IMPORTED', ledger_linked_at = now(), reconciliation_state = 'IMPORTED',
           needs_reconciliation = false, ledger_written_account_id = $3, ledger_written_kind = 'expense', ledger_written_amount_minor = 50000,
           ledger_written_currency = 'USD', ledger_written_occurred_on = '2026-09-10', ledger_written_description = 'Transfer' where id = $1`,
        [debit, id, checking],
      );
    });

    const creditLeg = await external(orgA, connectionA, linkSavings, { direction: "CREDIT" });
    expect(await pair(orgA, debit, creditLeg)).toBe("LEDGER_EDITED");
    // Their edit stands, untouched.
    expect((await ledgerRows())[0]).toMatchObject({ kind: "expense", transfer_account_id: null });
  });

  it("refuses when the credit leg is already in the books, rather than deleting it", async () => {
    const debit = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    const creditLeg = await external(orgA, connectionA, linkSavings, { direction: "CREDIT" });
    await service(async (query) => {
      const id = one<{ id: string }>(
        await query(
          `insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, source)
           values ($1, $2, 'income', 50000, 'USD', '2026-09-10', 'bank_sync') returning id`,
          [orgA, savings],
        ),
      ).id;
      await query(`update bank_external_transactions set ledger_transaction_id = $2, ledger_link_kind = 'IMPORTED', ledger_linked_at = now() where id = $1`, [creditLeg, id]);
    });

    expect(await pair(orgA, debit, creditLeg)).toBe("INVALID");
    // Nothing was removed; a person decides.
    expect(await ledgerRows()).toHaveLength(1);
  });
});

describe("what the database refuses", () => {
  it("refuses two transactions from different organizations", async () => {
    const otherAccount = await account(orgB, "Their checking", "bank");
    const otherConnection = await connection(orgB, "item-b");
    const otherLink = await link(orgB, otherConnection, otherAccount, "acct-theirs");
    const mine = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    const theirs = await external(orgB, otherConnection, otherLink, { direction: "CREDIT" });

    // Not found rather than paired: the lookup is organization-scoped, so the
    // other workspace's row is not visible to this call at all.
    expect(await pair(orgA, mine, theirs)).toBe("NOT_FOUND");
    expect(await ledgerRows()).toHaveLength(0);
  });

  it.each([
    ["different amounts", { amountMinor: 49_900 }],
    ["different currencies", { currency: "EUR" }],
    ["a date outside the window", { date: "2026-09-20" }],
    ["the same direction", { direction: "DEBIT" }],
  ])("refuses %s", async (_label, over) => {
    const debit = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    const other = await external(orgA, connectionA, linkSavings, { direction: "CREDIT", ...over });
    expect(await pair(orgA, debit, other)).toBe("INVALID");
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("refuses the same transaction as both legs", async () => {
    const debit = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    expect(await pair(orgA, debit, debit)).toBe("INVALID");
  });

  it("refuses two transactions on the same account", async () => {
    const debit = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    const creditLeg = await external(orgA, connectionA, linkChecking, { direction: "CREDIT" });
    expect(await pair(orgA, debit, creditLeg)).toBe("INVALID");
  });

  it("refuses a stale revision, so a concurrent change cannot be overwritten", async () => {
    const debit = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    const creditLeg = await external(orgA, connectionA, linkSavings, { direction: "CREDIT" });
    expect(await pair(orgA, debit, creditLeg, 99, 1)).toBe("STALE");
  });
});

describe("pairing is idempotent", () => {
  it("refuses a second pairing of the same two transactions", async () => {
    const debit = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    const creditLeg = await external(orgA, connectionA, linkSavings, { direction: "CREDIT" });
    expect(await pair(orgA, debit, creditLeg)).toBe("APPLIED");

    // A duplicate webhook or a repeated sync lands here and changes nothing.
    expect(await pair(orgA, debit, creditLeg, 1, 1)).toBe("INVALID");
    expect(await ledgerRows()).toHaveLength(1);
  });

  it("refuses a third transaction trying to join an existing pair", async () => {
    const debit = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    const creditLeg = await external(orgA, connectionA, linkSavings, { direction: "CREDIT" });
    await pair(orgA, debit, creditLeg);

    const third = await external(orgA, connectionA, linkCard, { direction: "CREDIT" });
    expect(await pair(orgA, debit, third)).toBe("INVALID");
    expect(await ledgerRows()).toHaveLength(1);
  });

  it("stops a leg being claimed twice at the index level, whatever the application does", async () => {
    const debit = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    const creditLeg = await external(orgA, connectionA, linkSavings, { direction: "CREDIT" });
    await pair(orgA, debit, creditLeg);
    const third = await external(orgA, connectionA, linkCard, { direction: "CREDIT" });

    await expect(
      service((query) => query(`update bank_external_transactions set transfer_counterpart_id = $2, transfer_role = 'SOURCE' where id = $1`, [third, creditLeg])),
    ).rejects.toThrow(/transfer_counterpart_idx|duplicate key/i);
  });
});

describe("the pairing function is not reachable from a browser", () => {
  it("refuses a signed-in member", async () => {
    const debit = await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    const creditLeg = await external(orgA, connectionA, linkSavings, { direction: "CREDIT" });
    await db.asUser(owner);
    await expect(db.query(`select bank_pair_internal_transfer($1, $2, $3, 1, 1, null, null)`, [orgA, debit, creditLeg])).rejects.toThrow(/permission denied/);
  });
});

describe("through the real reconciliation loop", () => {
  /** The production reconcile pass, over the real store and the real SQL. */
  const reconcile = (org: string, connectionId: string, today = "2026-09-12") =>
    reconcileConnection(
      { store: createPgliteBankStore(db), now: () => new Date(`${today}T12:00:00.000Z`) },
      { organizationId: org, connectionId, runId: null, budget: { remaining: 100 } },
    );

  it("turns a bank-to-bank transfer into one movement instead of an expense and an income", async () => {
    await external(orgA, connectionA, linkChecking, { direction: "DEBIT", category: "TRANSFER_OUT" });
    await external(orgA, connectionA, linkSavings, { direction: "CREDIT", category: "TRANSFER_IN" });

    await reconcile(orgA, connectionA);

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "transfer", account_id: checking, transfer_account_id: savings });
    expect(await balance(orgA, checking)).toBe(-50_000);
    expect(await balance(orgA, savings)).toBe(50_000);
  });

  it("settles a credit-card payment without a second expense", async () => {
    // Plaid labels a card payment LOAN_PAYMENTS on at least one leg, which is
    // what brings the pair to the matcher's attention.
    await external(orgA, connectionA, linkChecking, { direction: "DEBIT", category: "LOAN_PAYMENTS" });
    await external(orgA, connectionA, linkCard, { direction: "CREDIT" });

    await reconcile(orgA, connectionA);

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "transfer", transfer_account_id: card });
  });

  it("finds an unlabelled card payment anyway, because a card account is always searched", async () => {
    await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    await external(orgA, connectionA, linkCard, { direction: "CREDIT" });

    await reconcile(orgA, connectionA);

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "transfer", transfer_account_id: card });
  });

  it("leaves an unlabelled bank-to-bank transfer alone — a miss, never a wrong pairing", async () => {
    // THE KNOWN GAP, stated rather than hidden. Neither leg carries a
    // provider label and no card is involved, so nothing brings the pair to
    // the matcher's attention and both legs stay classified as they are
    // today. That is the conservative direction: the figures are no worse
    // than before, and nothing is rewritten on a guess.
    await external(orgA, connectionA, linkChecking, { direction: "DEBIT" });
    await external(orgA, connectionA, linkSavings, { direction: "CREDIT" });

    await reconcile(orgA, connectionA);

    const rows = (await ledgerRows()) as { kind: string }[];
    expect(rows.map((row) => row.kind).sort()).toEqual(["expense", "income"]);
  });

  it("leaves ordinary spending and income exactly as they were", async () => {
    // No corroboration and no matching counterpart: the existing behaviour
    // must be untouched, which is the promise that makes this safe to ship.
    await external(orgA, connectionA, linkChecking, { direction: "DEBIT", category: "FOOD_AND_DRINK", amountMinor: 1_234 });
    await external(orgA, connectionA, linkSavings, { direction: "CREDIT", category: "INCOME", amountMinor: 9_999 });

    await reconcile(orgA, connectionA);

    const rows = (await ledgerRows()) as { kind: string; amount_minor: number | string }[];
    expect(rows.map((row) => row.kind).sort()).toEqual(["expense", "income"]);
  });

  it("does not pair two unrelated transactions that merely share an amount", async () => {
    await external(orgA, connectionA, linkChecking, { direction: "DEBIT", category: "FOOD_AND_DRINK" });
    await external(orgA, connectionA, linkSavings, { direction: "CREDIT", category: "INCOME" });

    await reconcile(orgA, connectionA);

    const rows = (await ledgerRows()) as { kind: string }[];
    expect(rows.map((row) => row.kind).sort()).toEqual(["expense", "income"]);
  });

  it("leaves a three-way ambiguity alone rather than guessing", async () => {
    await external(orgA, connectionA, linkChecking, { direction: "DEBIT", category: "TRANSFER_OUT" });
    await external(orgA, connectionA, linkSavings, { direction: "CREDIT", category: "TRANSFER_IN" });
    await external(orgA, connectionA, linkCard, { direction: "CREDIT", category: "TRANSFER_IN" });

    await reconcile(orgA, connectionA);

    const rows = (await ledgerRows()) as { kind: string }[];
    // Nothing paired: three rows, classified the old way.
    expect(rows.filter((row) => row.kind === "transfer")).toHaveLength(0);
    expect(rows).toHaveLength(3);
  });

  it("is idempotent across repeated runs", async () => {
    await external(orgA, connectionA, linkChecking, { direction: "DEBIT", category: "TRANSFER_OUT" });
    await external(orgA, connectionA, linkSavings, { direction: "CREDIT", category: "TRANSFER_IN" });

    await reconcile(orgA, connectionA);
    await reconcile(orgA, connectionA);
    await reconcile(orgA, connectionA);

    expect(await ledgerRows()).toHaveLength(1);
    expect(await balance(orgA, savings)).toBe(50_000);
  });

  it("corrects a delayed counterpart in place, within the window", async () => {
    await external(orgA, connectionA, linkChecking, { direction: "DEBIT", category: "TRANSFER_OUT" });
    // First run: the debit leg arrives alone and imports as an expense.
    await reconcile(orgA, connectionA);
    expect((await ledgerRows())[0]).toMatchObject({ kind: "expense" });

    // Days later the other leg is reported.
    await external(orgA, connectionA, linkSavings, { direction: "CREDIT", category: "TRANSFER_IN", date: "2026-09-11" });
    await reconcile(orgA, connectionA, "2026-09-14");

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "transfer", transfer_account_id: savings });
  });

  it("does not reach back past the correction window", async () => {
    await external(orgA, connectionA, linkChecking, { direction: "DEBIT", category: "TRANSFER_OUT" });
    await reconcile(orgA, connectionA);

    await external(orgA, connectionA, linkSavings, { direction: "CREDIT", category: "TRANSFER_IN", date: "2026-09-11" });
    // Two months on: a period somebody may already have reviewed or exported.
    await reconcile(orgA, connectionA, "2026-11-20");

    const rows = (await ledgerRows()) as { kind: string }[];
    expect(rows.some((row) => row.kind === "transfer")).toBe(false);
  });
});

describe("schema version", () => {
  it("is 0057", async () => {
    expect(await service(async (query) => one<{ v: string }>(await query(`select operations_schema_version() as v`)).v)).toBe("0059");
  });
});
