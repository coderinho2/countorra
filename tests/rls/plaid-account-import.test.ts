import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// See tests/rls/plaid-sync-integration.test.ts: none of these is a real
// credential, and no Plaid environment is reached — the gateway double speaks
// Plaid's response shapes, and everything behind it is the production code.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
});

import { createTestDatabase, type TestDatabase } from "./harness";
import { MemorySecretStore } from "../fixtures/bank-provider-fixture";
import { PlaidGatewayDouble } from "../fixtures/plaid-gateway-double";
import { createPgliteBankStore } from "../fixtures/bank-store-pglite";
import type { BankStore } from "@/server/bank-connections/store";
import { PlaidBankProvider } from "@/server/bank-connections/providers/plaid/adapter";
import { createPlaidWebhookVerifier } from "@/server/bank-connections/providers/plaid/webhook-verification";
import { completeBankLink, linkExternalAccount, type ServiceDependencies } from "@/server/bank-connections/service";
import { runBankSyncJob } from "@/server/bank-connections/sync";
import { importedAccountKind } from "@/domain/bank-connections/account-import";
import type { ExternalAccountType } from "@/domain/bank-connections/types";

/**
 * Plaid production phase (supabase/migrations/0054_plaid_account_import.sql):
 * a connected bank's checking, savings and credit card accounts become
 * Countorra accounts by themselves, their balances equal the bank's, and
 * nothing is imported twice.
 */

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTSIDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

let db: TestDatabase;
let org: string;
let double: PlaidGatewayDouble;
let provider: PlaidBankProvider;
let secrets: MemorySecretStore;
let store: BankStore;

const deps = (): ServiceDependencies => ({ store, providers: [provider], secrets, now: () => new Date(), hash, audit: async () => {} });

async function admin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return db.asAdmin(async (query) => (await query(sql, params)).rows as T[]);
}
async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await admin<Record<string, T>>(sql, params);
  return Object.values(row)[0];
}
async function asService<T>(fn: (query: TestDatabase["query"]) => Promise<T>): Promise<T> {
  return db.asAdmin(async (query) => {
    await query("set role service_role");
    try {
      return await fn(query);
    } finally {
      await query("reset role");
    }
  });
}

async function connect(publicToken = "public-1", organizationId = org) {
  const outcome = await completeBankLink(deps(), { organizationId, userId: OWNER, providerId: "plaid", publicToken });
  if (outcome.kind !== "connected") throw new Error(`link failed: ${outcome.kind}`);
  return { connectionId: outcome.connectionId, jobId: outcome.jobId! };
}

let keys = 0;
async function sync(connectionId: string, organizationId = org) {
  const active = await store.getActiveJob(organizationId, connectionId);
  const jobId = active?.id ?? (await store.enqueueJob({ organizationId, connectionId, trigger: "SCHEDULED", idempotencyKey: `import-test-${keys++}`, requestedBy: null, webhookEventId: null })).jobId!;
  return runBankSyncJob(deps(), { organizationId, jobId });
}

/** The ledger balance of an account, from the same function the product uses. */
async function ledgerBalance(accountId: string, organizationId = org): Promise<number> {
  return Number(await scalar(`select balance_minor from account_balances_minor($1) where account_id = $2`, [organizationId, accountId]));
}

const importedAccounts = (organizationId = org) =>
  admin<{ id: string; name: string; kind: string; currency: string; provider_account_id: string; current_balance_minor: string | number }>(
    `select a.id, a.name, a.kind, a.currency, l.provider_account_id, l.current_balance_minor
       from bank_linked_accounts l join accounts a on a.id = l.account_id
      where l.organization_id = $1 and l.ledger_account_created_by_import order by l.provider_account_id`,
    [organizationId],
  );

const CARD = { account_id: "plaid-acct-card", name: "Plaid Credit Card", subtype: "credit card", type: "credit", mask: "3333", balances: { available: 1500, current: 410.5, iso_currency_code: "USD", limit: 2000, unofficial_currency_code: null } };
const SAVINGS = { account_id: "plaid-acct-savings", name: "Plaid Saving", subtype: "savings", type: "depository", mask: "1111", balances: { available: 200, current: 210, iso_currency_code: "USD", limit: null, unofficial_currency_code: null } };
const LOAN = { account_id: "plaid-acct-loan", name: "Plaid Student Loan", subtype: "student", type: "loan", mask: "7777", balances: { available: null, current: 65262, iso_currency_code: "USD", limit: null, unofficial_currency_code: null } };
const BROKERAGE = { account_id: "plaid-acct-ira", name: "Plaid IRA", subtype: "ira", type: "investment", mask: "5555", balances: { available: null, current: 320.76, iso_currency_code: "USD", limit: null, unofficial_currency_code: null } };

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin((query) => query(`insert into auth.users (id, email) values ($1, 'owner@example.test'), ($2, 'outsider@example.test')`, [OWNER, OUTSIDER]));
  // A fresh personal workspace: no accounts kept by hand.
  await db.asUser(OWNER);
  org = ((await db.query(`insert into organizations (name, entity_type, created_by, state_region) values ('Mine', 'personal', $1, 'CA') returning id`, [OWNER])).rows[0] as { id: string }).id;

  double = new PlaidGatewayDouble({ environment: "sandbox" });
  provider = new PlaidBankProvider({
    gateway: double,
    config: { environment: "sandbox", webhookUrl: "https://example.test/api/bank-connections/webhooks/plaid", redirectUri: null },
    verifier: createPlaidWebhookVerifier({ fetchKey: (keyId) => double.getWebhookVerificationKey(keyId) }),
  });
  secrets = new MemorySecretStore();
  store = createPgliteBankStore(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db?.close();
});

describe("automatic account import", () => {
  it("creates the Countorra account from the bank's checking account, imports its posted transactions, and matches the bank's balance", async () => {
    double.add(
      double.transaction({ transaction_id: "coffee", amount: 4.25 }),
      double.transaction({ transaction_id: "salary", amount: -2500, merchant_name: "Employer" }),
      double.transaction({ transaction_id: "hold", amount: 60, pending: true, authorized_date: null }),
    );
    const { connectionId, jobId } = await connect();
    const run = await runBankSyncJob(deps(), { organizationId: org, jobId });
    expect(run).toMatchObject({ kind: "succeeded", counts: { accountsImported: 1, balancesAnchored: 1, imported: 2 } });

    const [account] = await importedAccounts();
    expect(account).toMatchObject({ name: "Plaid Checking", kind: "bank", currency: "USD", provider_account_id: "plaid-acct-checking" });
    expect(await scalar(`select import_mode from bank_linked_accounts where connection_id = $1`, [connectionId])).toBe("IMPORT");

    // Two posted transactions in the ledger; the pending hold waits.
    expect(await scalar(`select count(*)::int from transactions where account_id = $1 and source = 'bank_sync'`, [account.id])).toBe(2);
    // The balance is the bank's current balance ($110.00), exactly.
    expect(await ledgerBalance(account.id)).toBe(11_000);
    // And it is made of real history plus one opening figure — no invented transaction.
    expect(Number(await scalar(`select opening_balance_minor from accounts where id = $1`, [account.id]))).toBe(11_000 - (250_000 - 425));
  });

  it("imports checking, savings and a credit card — and leaves a loan and an investment account visible but unimported", async () => {
    double.accounts = [double.account(), SAVINGS, CARD, LOAN, BROKERAGE];
    double.add(double.transaction({ transaction_id: "card-buy", account_id: "plaid-acct-card", amount: 25 }));
    const { connectionId, jobId } = await connect();
    await runBankSyncJob(deps(), { organizationId: org, jobId });

    const accounts = await importedAccounts();
    expect(accounts.map((a) => [a.provider_account_id, a.kind])).toEqual([
      ["plaid-acct-card", "credit_card"],
      ["plaid-acct-checking", "bank"],
      ["plaid-acct-savings", "bank"],
    ]);
    // A credit card's balance is money owed: negative, and equal to the bank's.
    const card = accounts.find((a) => a.kind === "credit_card")!;
    expect(await ledgerBalance(card.id)).toBe(-41_050);
    expect(await ledgerBalance(accounts.find((a) => a.provider_account_id === "plaid-acct-savings")!.id)).toBe(21_000);

    const unsupported = await admin<{ provider_account_id: string; import_mode: string; account_id: string | null }>(
      `select provider_account_id, import_mode, account_id from bank_linked_accounts where connection_id = $1 and provider_account_id in ('plaid-acct-loan', 'plaid-acct-ira') order by 1`,
      [connectionId],
    );
    expect(unsupported).toEqual([
      { provider_account_id: "plaid-acct-ira", import_mode: "AWAITING_DECISION", account_id: null },
      { provider_account_id: "plaid-acct-loan", import_mode: "AWAITING_DECISION", account_id: null },
    ]);
    expect(await scalar(`select count(*)::int from accounts where organization_id = $1`, [org])).toBe(3);
  });

  it("is idempotent: another sync creates no account and no transaction, and the balance still matches", async () => {
    double.add(double.transaction({ transaction_id: "coffee", amount: 4.25 }));
    const { connectionId, jobId } = await connect();
    await runBankSyncJob(deps(), { organizationId: org, jobId });
    const [account] = await importedAccounts();

    const again = await sync(connectionId);
    expect(again).toMatchObject({ kind: "succeeded", counts: { accountsImported: 0, imported: 0 } });
    await sync(connectionId);
    expect(await scalar(`select count(*)::int from accounts where organization_id = $1`, [org])).toBe(1);
    expect(await scalar(`select count(*)::int from transactions where organization_id = $1`, [org])).toBe(1);
    expect(await ledgerBalance(account.id)).toBe(11_000);
  });

  it("follows new transactions and a new bank balance on the next sync", async () => {
    const { connectionId, jobId } = await connect();
    await runBankSyncJob(deps(), { organizationId: org, jobId });
    const [account] = await importedAccounts();

    double.add(double.transaction({ transaction_id: "groceries", amount: 80 }));
    double.accounts = [double.account({ balances: { available: 20, current: 30, iso_currency_code: "USD", limit: null, unofficial_currency_code: null } })];
    await sync(connectionId);
    expect(await ledgerBalance(account.id)).toBe(3_000);
    expect(await scalar(`select count(*)::int from transactions where account_id = $1`, [account.id])).toBe(1);
  });

  it("picks up an account opened at the bank after the first sync (regression: accounts were only ever read once)", async () => {
    const { connectionId, jobId } = await connect();
    await runBankSyncJob(deps(), { organizationId: org, jobId });
    expect(await importedAccounts()).toHaveLength(1);

    double.accounts = [double.account(), SAVINGS];
    const run = await sync(connectionId);
    expect(run).toMatchObject({ kind: "succeeded", counts: { accountsImported: 1 } });
    const accounts = await importedAccounts();
    expect(accounts.map((a) => a.provider_account_id)).toEqual(["plaid-acct-checking", "plaid-acct-savings"]);
    expect(await ledgerBalance(accounts[1].id)).toBe(21_000);
  });

  it("settles pending into posted as ONE ledger row, and the balance never counts it twice", async () => {
    double.add(double.transaction({ transaction_id: "hold", amount: 60, pending: true, authorized_date: null }));
    const { connectionId, jobId } = await connect();
    await runBankSyncJob(deps(), { organizationId: org, jobId });
    const [account] = await importedAccounts();
    expect(await scalar(`select count(*)::int from transactions where account_id = $1`, [account.id])).toBe(0);

    double.remove("hold");
    double.add(double.transaction({ transaction_id: "posted", amount: 60, pending_transaction_id: "hold" }));
    await sync(connectionId);
    expect(await scalar(`select count(*)::int from transactions where account_id = $1`, [account.id])).toBe(1);
    expect(await ledgerBalance(account.id)).toBe(11_000);
  });

  it("stays equal to the bank when Plaid delivers older history later", async () => {
    double.add(double.transaction({ transaction_id: "recent", amount: 10, date: "2026-09-15" }));
    const { connectionId, jobId } = await connect();
    await runBankSyncJob(deps(), { organizationId: org, jobId });
    const [account] = await importedAccounts();
    expect(await ledgerBalance(account.id)).toBe(11_000);

    // History the bank's balance already included arrives afterwards.
    double.add(double.transaction({ transaction_id: "older", amount: 300, date: "2026-06-02" }));
    await sync(connectionId);
    expect(await scalar(`select count(*)::int from transactions where account_id = $1`, [account.id])).toBe(2);
    expect(await ledgerBalance(account.id)).toBe(11_000);
  });

  it("imports each institution's accounts separately, and never the same item twice", async () => {
    const first = await connect("public-bank-a");
    await runBankSyncJob(deps(), { organizationId: org, jobId: first.jobId });
    const second = await connect("public-bank-b");
    await runBankSyncJob(deps(), { organizationId: org, jobId: second.jobId });
    expect(await scalar(`select count(*)::int from bank_connections where organization_id = $1`, [org])).toBe(2);
    expect(await scalar(`select count(*)::int from accounts where organization_id = $1`, [org])).toBe(2);

    // Linking bank A's item again is recognised, not duplicated.
    expect(await completeBankLink(deps(), { organizationId: org, userId: OWNER, providerId: "plaid", publicToken: "public-bank-a" })).toEqual({ kind: "already_connected", connectionId: first.connectionId });
    expect(await scalar(`select count(*)::int from accounts where organization_id = $1`, [org])).toBe(2);
  });
});

describe("a workspace that already kept the account by hand", () => {
  let handKept: string;

  beforeEach(async () => {
    // A bank account entered by hand before 0053 (only the system can create one now).
    handKept = (await asService(async (query) => (await query(`insert into accounts (organization_id, name, kind, currency, opening_balance_minor) values ($1, 'My checking', 'bank', 'USD', 50000) returning id`, [org])).rows[0] as { id: string })).id;
  });

  it("does not import a second copy — the bank account waits for the person's choice", async () => {
    double.add(double.transaction({ transaction_id: "coffee", amount: 4.25 }));
    const { connectionId, jobId } = await connect();
    const run = await runBankSyncJob(deps(), { organizationId: org, jobId });
    expect(run).toMatchObject({ kind: "succeeded", counts: { accountsImported: 0, imported: 0 } });
    expect(await scalar(`select import_mode from bank_linked_accounts where connection_id = $1`, [connectionId])).toBe("AWAITING_DECISION");
    expect(await scalar(`select count(*)::int from accounts where organization_id = $1`, [org])).toBe(1);
  });

  it("continues the hand-kept account, keeping its own opening balance", async () => {
    const { connectionId, jobId } = await connect();
    await runBankSyncJob(deps(), { organizationId: org, jobId });
    const linkedAccountId = await scalar<string>(`select id from bank_linked_accounts where connection_id = $1`, [connectionId]);
    expect(await linkExternalAccount(deps(), { organizationId: org, linkedAccountId, accountId: handKept, importMode: "IMPORT", actorId: OWNER })).toMatchObject({ kind: "applied" });
    await sync(connectionId);
    expect(Number(await scalar(`select opening_balance_minor from accounts where id = $1`, [handKept]))).toBe(50_000);
  });

  it("imports it as a new account when the person asks", async () => {
    const { connectionId, jobId } = await connect();
    await runBankSyncJob(deps(), { organizationId: org, jobId });
    const linkedAccountId = await scalar<string>(`select id from bank_linked_accounts where connection_id = $1`, [connectionId]);
    expect(await asService(async (query) => (await query(`select bank_import_linked_account($1, $2, $3) as r`, [org, linkedAccountId, OWNER])).rows[0])).toEqual({ r: "APPLIED" });
    expect(await asService(async (query) => (await query(`select bank_import_linked_account($1, $2, $3) as r`, [org, linkedAccountId, OWNER])).rows[0])).toEqual({ r: "ALREADY_DECIDED" });
    await sync(connectionId);
    const [account] = await importedAccounts();
    expect(await ledgerBalance(account.id)).toBe(11_000);
  });

  it("refuses to feed a bank account into a cash account, and a loan into anything", async () => {
    double.accounts = [double.account(), LOAN];
    const cash = (await asService(async (query) => (await query(`insert into accounts (organization_id, name, kind, currency) values ($1, 'Wallet', 'cash', 'USD') returning id`, [org])).rows[0] as { id: string })).id;
    const { connectionId, jobId } = await connect();
    await runBankSyncJob(deps(), { organizationId: org, jobId });
    const idFor = (provider: string) => scalar<string>(`select id from bank_linked_accounts where connection_id = $1 and provider_account_id = $2`, [connectionId, provider]);

    expect(await linkExternalAccount(deps(), { organizationId: org, linkedAccountId: await idFor("plaid-acct-checking"), accountId: cash, importMode: "IMPORT", actorId: OWNER })).toEqual({ kind: "refused", reason: "ACCOUNT_KIND_MISMATCH" });
    expect(await linkExternalAccount(deps(), { organizationId: org, linkedAccountId: await idFor("plaid-acct-loan"), accountId: handKept, importMode: "IMPORT", actorId: OWNER })).toEqual({ kind: "refused", reason: "UNSUPPORTED_ACCOUNT_TYPE" });
    expect(await asService(async (query) => (await query(`select bank_import_linked_account($1, $2, null) as r`, [org, await idFor("plaid-acct-loan")])).rows[0])).toEqual({ r: "UNSUPPORTED_ACCOUNT_TYPE" });
  });
});

describe("Plaid data in Countorra's deterministic figures", () => {
  it("feeds spending, income, balances and net worth — exactly, with the pending hold left out", async () => {
    double.accounts = [double.account(), SAVINGS, CARD];
    double.add(
      double.transaction({ transaction_id: "rent", amount: 1500, date: "2026-09-01" }),
      double.transaction({ transaction_id: "salary", amount: -4200, date: "2026-09-02" }),
      double.transaction({ transaction_id: "card-buy", account_id: "plaid-acct-card", amount: 25, date: "2026-09-03" }),
      double.transaction({ transaction_id: "hold", amount: 60, pending: true, authorized_date: null, date: "2026-09-04" }),
    );
    const { jobId } = await connect();
    await runBankSyncJob(deps(), { organizationId: org, jobId });

    // The same SQL aggregates the dashboard, reports and the assistant's tools read.
    const totals = await admin<{ kind: string; total_minor: string | number }>(`select kind, total_minor from transaction_totals($1) order by kind`, [org]);
    expect(Object.fromEntries(totals.map((t) => [t.kind, Number(t.total_minor)]))).toEqual({ expense: 152_500, income: 420_000 });

    // Net worth from the balances: checking 110 + savings 210 − card 410.50.
    const { calculateNetWorth } = await import("@/domain/financial/net-worth");
    const accounts = await admin<{ id: string; name: string; kind: string; currency: string; is_archived: boolean }>(`select id, name, kind, currency, is_archived from accounts where organization_id = $1`, [org]);
    const balances = new Map((await admin<{ account_id: string; balance_minor: string | number }>(`select account_id, balance_minor from account_balances_minor($1)`, [org])).map((b) => [b.account_id, Number(b.balance_minor)]));
    const worth = calculateNetWorth(accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, currency: a.currency, isArchived: a.is_archived, balanceMinor: balances.get(a.id)! })), "USD");
    expect(worth.totalAssets.amountMinor).toBe(32_000);
    expect(worth.totalLiabilities.amountMinor).toBe(41_050);
    expect(worth.netWorth.amountMinor).toBe(-9_050);
  });
});

describe("provider data and Countorra enrichment", () => {
  it("lets a person categorise and annotate an imported transaction, never change the bank's facts or delete it", async () => {
    double.add(double.transaction({ transaction_id: "coffee", amount: 4.25 }));
    const { jobId } = await connect();
    await runBankSyncJob(deps(), { organizationId: org, jobId });
    const id = await scalar<string>(`select id from transactions where organization_id = $1`, [org]);
    const category = await scalar<string>(`select id from transaction_categories where organization_id = $1 and kind = 'expense' limit 1`, [org]);

    await db.asUser(OWNER);
    await db.query(`update transactions set category_id = $1, memo = 'with Sam', is_reviewed = true, description = 'Coffee' where id = $2`, [category, id]);
    for (const change of ["amount_minor = 1", "occurred_on = '2020-01-01'", "kind = 'income'", "currency = 'EUR'"]) {
      await expect(db.query(`update transactions set ${change} where id = $1`, [id]), change).rejects.toThrow(/come from the bank/);
    }
    await expect(db.query(`delete from transactions where id = $1`, [id])).rejects.toThrow(/it follows the bank/);
  });
});

describe("isolation and authority", () => {
  it("gives no browser session the import, anchoring or single-account import functions", async () => {
    const { connectionId } = await connect();
    await db.asUser(OWNER);
    for (const sql of [`select bank_auto_import_accounts($1, $2)`, `select bank_anchor_account_balances($1, $2)`]) {
      await expect(db.query(sql, [org, connectionId])).rejects.toThrow(/permission denied/);
    }
    await expect(db.query(`select bank_import_linked_account($1, $2, null)`, [org, connectionId])).rejects.toThrow(/permission denied/);
  });

  it("cannot import another workspace's bank account into this one", async () => {
    const { connectionId, jobId } = await connect();
    await runBankSyncJob(deps(), { organizationId: org, jobId });
    await db.asUser(OUTSIDER);
    const theirs = ((await db.query(`insert into organizations (name, entity_type, created_by) values ('Theirs', 'personal', $1) returning id`, [OUTSIDER])).rows[0] as { id: string }).id;
    const ours = await scalar<string>(`select id from bank_linked_accounts where connection_id = $1`, [connectionId]);
    expect(await asService(async (query) => (await query(`select bank_import_linked_account($1, $2, null) as r`, [theirs, ours])).rows[0])).toEqual({ r: "NOT_FOUND" });
    expect(await asService(async (query) => (await query(`select bank_auto_import_accounts($1, $2) as n`, [theirs, connectionId])).rows[0])).toEqual({ n: 0 });
    // And nothing of ours is visible to them.
    await db.asUser(OUTSIDER);
    expect((await db.query(`select id from bank_linked_accounts`)).rows).toEqual([]);
    expect((await db.query(`select id from accounts where organization_id = $1`, [org])).rows).toEqual([]);
  });

  it("maps account types in the application exactly as the database does", async () => {
    const cases: [ExternalAccountType, string | null][] = [
      ["DEPOSITORY", "checking"],
      ["DEPOSITORY", "savings"],
      ["DEPOSITORY", "money_market"],
      ["DEPOSITORY", "cd"],
      ["DEPOSITORY", "hsa"],
      ["DEPOSITORY", null],
      ["CREDIT", "credit_card"],
      // The raw spelling never reaches the mapping, and must not match if it did.
      ["CREDIT", "credit card"],
      ["CREDIT", "paypal"],
      ["LOAN", "student"],
      ["LOAN", "mortgage"],
      ["INVESTMENT", "ira"],
      ["OTHER", null],
    ];
    for (const [type, subtype] of cases) {
      expect(await scalar(`select bank_import_account_kind($1, $2)`, [type, subtype]), `${type}/${subtype}`).toBe(importedAccountKind(type, subtype));
    }
  });
});
