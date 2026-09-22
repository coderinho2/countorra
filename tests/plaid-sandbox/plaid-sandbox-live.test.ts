import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * LIVE Plaid SANDBOX verification — real Plaid API calls, the real Countorra
 * pipeline, a local database.
 *
 * WHAT IS REAL: every call to Plaid (link token, sandbox item, public-token
 * exchange, /item/get, /institutions/get_by_id, /accounts/get,
 * /transactions/sync, /sandbox/*, /item/remove) goes to sandbox.plaid.com
 * through Countorra's production gateway and adapter
 * (src/server/bank-connections/providers/plaid). Everything after that —
 * completeBankLink, the sync run, automatic account import, balance
 * anchoring, reconciliation, the reauth transition, disconnect — is the
 * production code, running against every migration in supabase/migrations
 * applied to an in-process Postgres (tests/rls/harness.ts).
 *
 * WHAT IS NOT: Plaid Link's browser UI (a sandbox public token is minted with
 * /sandbox/public_token/create instead — Plaid's documented way to test
 * without it), webhook DELIVERY (Plaid cannot reach this machine; signature
 * verification is covered with real ES256 JWTs in
 * tests/rls/plaid-sync-integration.test.ts), and the production Supabase
 * project (nothing here touches it).
 *
 * GATED, and never run by default: it needs network access and Plaid sandbox
 * credentials. Opt in with PLAID_SANDBOX_LIVE=1; credentials come from
 * .env.local and are never printed. It REFUSES to run against anything but
 * PLAID_ENV=sandbox — no test may create a production Item.
 *
 *   PLAID_SANDBOX_LIVE=1 npx vitest run tests/plaid-sandbox
 */

function readLocalEnv(): Record<string, string> {
  const file = path.resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const local = readLocalEnv();
const env = { ...local, ...process.env } as Record<string, string | undefined>;
const optedIn = process.env.PLAID_SANDBOX_LIVE === "1";
const sandbox = env.PLAID_ENV === "sandbox" && Boolean(env.PLAID_CLIENT_ID) && Boolean(env.PLAID_SECRET);

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
});

import { Configuration, PlaidApi, PlaidEnvironments, Products } from "plaid";
import { createTestDatabase, type TestDatabase } from "../rls/harness";
import { MemorySecretStore } from "../fixtures/bank-provider-fixture";
import { createPgliteBankStore } from "../fixtures/bank-store-pglite";
import type { BankStore } from "@/server/bank-connections/store";
import { createPlaidProvider } from "@/server/bank-connections/providers/plaid/adapter";
import type { PlaidConfig } from "@/server/bank-connections/providers/plaid/config";
import { completeBankLink, createBankLinkSession, disconnectBankConnection, type ServiceDependencies } from "@/server/bank-connections/service";
import { runBankSyncJob } from "@/server/bank-connections/sync";

describe("the gate", () => {
  it("refuses anything but the sandbox", () => {
    // A production PLAID_ENV must never enable this suite.
    expect(env.PLAID_ENV === "production" && optedIn && sandbox).toBe(false);
  });
});

describe.runIf(optedIn && sandbox)("LIVE Plaid sandbox → Countorra", () => {
  const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const plaid = new PlaidApi(
    new Configuration({ basePath: PlaidEnvironments.sandbox, baseOptions: { headers: { "PLAID-CLIENT-ID": env.PLAID_CLIENT_ID!, "PLAID-SECRET": env.PLAID_SECRET! } } }),
  );
  const config = { clientId: env.PLAID_CLIENT_ID!, secret: env.PLAID_SECRET!, environment: "sandbox", basePath: "https://sandbox.plaid.com", webhookUrl: null, redirectUri: null, keyset: null } as unknown as PlaidConfig;

  let db: TestDatabase;
  let org: string;
  let store: BankStore;
  const secrets = new MemorySecretStore();
  const provider = createPlaidProvider(config);
  const deps = (): ServiceDependencies => ({ store, providers: [provider], secrets, now: () => new Date(), hash, audit: async () => {} });
  const connections: string[] = [];

  const rows = <T,>(sql: string, params: unknown[] = []) => db.asAdmin(async (query) => (await query(sql, params)).rows as T[]);
  const one = async <T,>(sql: string, params: unknown[] = []) => (await rows<T>(sql, params))[0];
  const accessTokenFor = async (connectionId: string) => secrets.secrets.get((await one<{ secret_ref: string }>(`select secret_ref from bank_connection_credentials where connection_id = $1`, [connectionId])).secret_ref)!;

  let keys = 0;
  const sync = async (connectionId: string) => {
    const active = await store.getActiveJob(org, connectionId);
    const jobId = active?.id ?? (await store.enqueueJob({ organizationId: org, connectionId, trigger: "SCHEDULED", idempotencyKey: `live-${keys++}`, requestedBy: null, webhookEventId: null })).jobId!;
    return runBankSyncJob(deps(), { organizationId: org, jobId });
  };
  /** Plaid prepares a new item's transactions asynchronously; sync until they arrive. */
  const syncUntilTransactions = async (connectionId: string) => {
    for (let attempt = 0; attempt < 12; attempt++) {
      await sync(connectionId);
      const { n } = await one<{ n: number }>(`select count(*)::int as n from bank_external_transactions where connection_id = $1`, [connectionId]);
      if (n > 0) return n;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error("Plaid sandbox delivered no transactions within 60 seconds");
  };

  const sandboxItem = async (institutionId: string) => {
    const created = await plaid.sandboxPublicTokenCreate({
      institution_id: institutionId,
      initial_products: [Products.Transactions],
      options: { override_username: "user_transactions_dynamic", override_password: "pass_good" },
    });
    const outcome = await completeBankLink(deps(), { organizationId: org, userId: OWNER, providerId: "plaid", publicToken: created.data.public_token });
    expect(outcome.kind).toBe("connected");
    const connectionId = (outcome as { connectionId: string }).connectionId;
    connections.push(connectionId);
    return connectionId;
  };

  let bankA: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.asAdmin((query) => query(`insert into auth.users (id, email) values ($1, 'sandbox-owner@example.test')`, [OWNER]));
    await db.asUser(OWNER);
    org = ((await db.query(`insert into organizations (name, entity_type, created_by, state_region) values ('Sandbox verification', 'personal', $1, 'CA') returning id`, [OWNER])).rows[0] as { id: string }).id;
    store = createPgliteBankStore(db);
  }, 60_000);

  afterAll(async () => {
    // A summary for the report: counts and types only — no token, id, amount or name.
    try {
      const summary = await rows<Record<string, unknown>>(
        `select c.provider_environment, c.status, l.account_type, l.account_subtype, l.import_mode, (l.account_id is not null) as imported,
                (select count(*)::int from bank_external_transactions e where e.linked_account_id = l.id and e.status = 'POSTED') as posted,
                (select count(*)::int from bank_external_transactions e where e.linked_account_id = l.id and e.status = 'PENDING') as pending,
                (select count(*)::int from transactions t where t.account_id = l.account_id and t.source = 'bank_sync') as ledger,
                (select b.balance_minor = l.current_balance_minor from account_balances_minor($1) b where b.account_id = l.account_id) as balance_matches_bank
           from bank_linked_accounts l join bank_connections c on c.id = l.connection_id where l.organization_id = $1 order by c.created_at, l.account_type, l.account_subtype`,
        [org],
      );
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(path.resolve(process.cwd(), "test-results"), { recursive: true });
      writeFileSync(path.resolve(process.cwd(), "test-results/plaid-sandbox-summary.json"), JSON.stringify({ at: new Date().toISOString(), accounts: summary }, null, 2));
    } catch {
      // The summary is a convenience; it never fails the run.
    }
    // Remove every sandbox item at Plaid, through the real disconnect path.
    for (const connectionId of connections) {
      await disconnectBankConnection(deps(), { organizationId: org, connectionId, actorId: OWNER }).catch(() => {});
    }
    await db?.close();
  }, 120_000);

  it("creates a real Plaid Link token", async () => {
    const session = await createBankLinkSession(deps(), { organizationId: org, userId: OWNER });
    expect(session.kind).toBe("created");
    expect((session as { linkToken: string }).linkToken).toMatch(/^link-sandbox-/);
  }, 60_000);

  it("exchanges a real public token, records the institution, and keeps the access token out of the database", async () => {
    bankA = await sandboxItem("ins_109508");
    const connection = await one<Record<string, unknown>>(`select status, provider, provider_environment, institution_name from bank_connections where id = $1`, [bankA]);
    expect(connection).toMatchObject({ status: "ACTIVE", provider: "plaid", provider_environment: "sandbox" });
    expect(String(connection.institution_name).length).toBeGreaterThan(0);
    expect(await accessTokenFor(bankA)).toMatch(/^access-sandbox-/);
    const everything = await one<{ dump: string }>(
      `select concat_ws('|', (select string_agg(c::text, '|') from bank_connections c), (select string_agg(c::text, '|') from bank_connection_credentials c), (select string_agg(l::text, '|') from bank_linked_accounts l)) as dump`,
    );
    expect(everything.dump).not.toContain("access-sandbox");
  }, 60_000);

  it("imports the item's checking, savings and credit card as Countorra accounts, with Plaid's real balances", async () => {
    await syncUntilTransactions(bankA);
    const linked = await rows<{ account_type: string; account_subtype: string | null; import_mode: string; account_id: string | null; current_balance_minor: string | null; kind: string | null; balance: string | null }>(
      `select l.account_type, l.account_subtype, l.import_mode, l.account_id, l.current_balance_minor, a.kind, b.balance_minor as balance
         from bank_linked_accounts l
         left join accounts a on a.id = l.account_id
         left join account_balances_minor($1) b on b.account_id = l.account_id
        where l.connection_id = $2`,
      [org, bankA],
    );
    const supported = linked.filter((l) => (l.account_type === "DEPOSITORY" && ["checking", "savings"].includes(l.account_subtype ?? "")) || (l.account_type === "CREDIT" && l.account_subtype === "credit_card"));
    const unsupported = linked.filter((l) => !supported.includes(l));
    console.info(`[sandbox] accounts reported: ${linked.length}; imported: ${supported.length}; not supported: ${unsupported.map((l) => `${l.account_type}/${l.account_subtype}`).join(", ")}`);

    expect(supported.length).toBeGreaterThanOrEqual(2);
    for (const account of supported) {
      expect(account.import_mode).toBe("IMPORT");
      expect(account.kind).toBe(account.account_type === "CREDIT" ? "credit_card" : "bank");
      // The Countorra balance equals the bank's current balance, to the cent.
      expect(Number(account.balance)).toBe(Number(account.current_balance_minor));
    }
    for (const account of unsupported) {
      expect(account.import_mode).toBe("AWAITING_DECISION");
      expect(account.account_id).toBeNull();
    }
  }, 180_000);

  it("puts every posted transaction in the ledger exactly once, and no pending one", async () => {
    const counts = await one<{ posted: number; pending: number; ledger: number; ledger_distinct: number }>(
      `select
         (select count(*)::int from bank_external_transactions e join bank_linked_accounts l on l.id = e.linked_account_id where e.connection_id = $1 and e.status = 'POSTED' and l.import_mode = 'IMPORT' and e.currency is not null) as posted,
         (select count(*)::int from bank_external_transactions where connection_id = $1 and status = 'PENDING') as pending,
         (select count(*)::int from transactions t where t.organization_id = $2 and t.source = 'bank_sync') as ledger,
         (select count(distinct e.ledger_transaction_id)::int from bank_external_transactions e where e.connection_id = $1 and e.ledger_transaction_id is not null) as ledger_distinct`,
      [bankA, org],
    );
    console.info(`[sandbox] posted ${counts.posted}, pending ${counts.pending}, ledger rows ${counts.ledger}`);
    expect(counts.ledger).toBe(counts.posted);
    expect(counts.ledger_distinct).toBe(counts.ledger);
    const pendingInLedger = await one<{ n: number }>(`select count(*)::int as n from bank_external_transactions where connection_id = $1 and status = 'PENDING' and ledger_transaction_id is not null`, [bankA]);
    expect(pendingInLedger.n).toBe(0);
  }, 60_000);

  it("adds nothing on a repeat sync, once Plaid has delivered the item's history", async () => {
    // Plaid delivers a new item's history in stages (recent first, older
    // later — HISTORICAL_UPDATE). Sync until two runs in a row bring nothing.
    let previous = -1;
    for (let attempt = 0; attempt < 12; attempt++) {
      await sync(bankA);
      const { n } = await one<{ n: number }>(`select count(*)::int as n from bank_external_transactions where connection_id = $1`, [bankA]);
      if (n === previous) break;
      previous = n;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    const before = await one<{ accounts: number; ledger: number }>(`select (select count(*)::int from accounts where organization_id = $1) as accounts, (select count(*)::int from transactions where organization_id = $1) as ledger`, [org]);
    await sync(bankA);
    await sync(bankA);
    const after = await one<{ accounts: number; ledger: number }>(`select (select count(*)::int from accounts where organization_id = $1) as accounts, (select count(*)::int from transactions where organization_id = $1) as ledger`, [org]);
    expect(after).toEqual(before);
    // And the whole history is in the ledger exactly once.
    const check = await one<{ posted: number; ledger: number }>(
      `select (select count(*)::int from bank_external_transactions e join bank_linked_accounts l on l.id = e.linked_account_id where e.connection_id = $1 and e.status = 'POSTED' and l.import_mode = 'IMPORT' and e.currency is not null) as posted,
              (select count(*)::int from transactions where organization_id = $2 and source = 'bank_sync') as ledger`,
      [bankA, org],
    );
    expect(check.ledger).toBe(check.posted);
  }, 300_000);

  it("imports a transaction the bank adds later, once (incremental sync)", async () => {
    const accessToken = await accessTokenFor(bankA);
    const today = new Date().toISOString().slice(0, 10);
    await plaid.sandboxTransactionsCreate({ access_token: accessToken, transactions: [{ date_transacted: today, date_posted: today, amount: 12.34, description: "COUNTORRA SANDBOX VERIFICATION", iso_currency_code: "USD" }] });
    let found = 0;
    for (let attempt = 0; attempt < 12 && found === 0; attempt++) {
      await plaid.transactionsRefresh({ access_token: accessToken }).catch(() => {});
      await sync(bankA);
      found = (await one<{ n: number }>(`select count(*)::int as n from bank_external_transactions where connection_id = $1 and amount_minor = 1234 and transaction_date = $2`, [bankA, today])).n;
      if (found === 0) await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    expect(found).toBe(1);
    await sync(bankA);
    expect((await one<{ n: number }>(`select count(*)::int as n from transactions where organization_id = $1 and amount_minor = 1234 and occurred_on = $2`, [org, today])).n).toBe(1);
  }, 180_000);

  it("connects a second institution alongside the first", async () => {
    const bankB = await sandboxItem("ins_109511");
    await syncUntilTransactions(bankB);
    expect((await one<{ n: number }>(`select count(*)::int as n from bank_connections where organization_id = $1 and status = 'ACTIVE'`, [org])).n).toBe(2);
    expect((await one<{ n: number }>(`select count(distinct connection_id)::int as n from bank_linked_accounts where organization_id = $1 and import_mode = 'IMPORT'`, [org])).n).toBe(2);
  }, 180_000);

  it("moves to 'needs sign-in' when the bank requires it, keeping every account and transaction", async () => {
    const before = await one<{ accounts: number; ledger: number }>(`select (select count(*)::int from accounts where organization_id = $1) as accounts, (select count(*)::int from transactions where organization_id = $1) as ledger`, [org]);
    await plaid.sandboxItemResetLogin({ access_token: await accessTokenFor(bankA) });
    const run = await sync(bankA);
    expect(run.kind).toBe("failed");
    expect((await one<{ status: string }>(`select status from bank_connections where id = $1`, [bankA])).status).toBe("REQUIRES_REAUTH");
    const after = await one<{ accounts: number; ledger: number }>(`select (select count(*)::int from accounts where organization_id = $1) as accounts, (select count(*)::int from transactions where organization_id = $1) as ledger`, [org]);
    expect(after).toEqual(before);
    // Update mode is offered for exactly this connection.
    const session = await createBankLinkSession(deps(), { organizationId: org, userId: OWNER, connectionId: bankA });
    expect(session).toMatchObject({ kind: "created", mode: "reauthenticate" });
  }, 120_000);
});
