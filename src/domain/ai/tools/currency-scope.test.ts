import { describe, expect, it } from "vitest";
import { createToolRegistry } from "./registry";
import type { AITool, ToolContext } from "./types";

/**
 * FIN-03 and FIN-04, asserted against the REAL registry — the same 35 tools
 * the model is handed, not a stand-in for them.
 *
 * Two bugs are covered here, and they compounded each other:
 *
 *   FIN-03  `getFinancialOverview` and `forecastCashFlow` reduced raw
 *           `amountMinor` integers across every account regardless of
 *           currency and stamped one currency label on the result. The
 *           accounts page had explicitly refused to do this; the assistant
 *           did it and then explained the number.
 *
 *   FIN-04  the currency those tools worked in came from the *user profile's*
 *           `default_currency`, not the organization's `base_currency` — so a
 *           user with a EUR display preference over a USD workspace made every
 *           aggregate tool throw `CurrencyMismatchError`.
 *
 * The stub below implements only the query shapes these tools actually use.
 * It deliberately reports a profile currency that DISAGREES with the
 * organization's, because that disagreement is the whole bug: if a tool ever
 * goes back to reading the profile, these tests fail.
 */

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const context: ToolContext = { organizationId: ORG_ID, userId: USER_ID };

interface StubData {
  baseCurrency: string;
  /** What `account_balances_minor` returns. */
  balances: { account_id: string; currency: string; balance_minor: number }[];
  /** What `transaction_totals` returns. */
  totals: { currency: string; kind: "income" | "expense" | "transfer"; total_minor: number; transaction_count: number; unreviewed_count: number }[];
}

/** A chainable stand-in for a PostgREST query builder: every filter returns
 *  `this`, and awaiting it resolves to the rows this table was given. */
function table(rows: unknown[]) {
  const builder: Record<string, unknown> = {
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    single: async () => ({ data: rows[0] ?? null, error: null }),
  };
  for (const method of ["select", "eq", "neq", "gte", "lte", "lt", "gt", "is", "in", "ilike", "order", "range", "limit", "filter"]) {
    builder[method] = () => builder;
  }
  return builder;
}

function stubClient(data: StubData) {
  const rpcCalls: { name: string; args: unknown }[] = [];
  const client = {
    from(name: string) {
      if (name === "organizations") {
        return table([{ id: ORG_ID, name: "Test Org", entity_type: "business", country: "US", base_currency: data.baseCurrency, tax_identifier: null, tax_identifier_type: null }]);
      }
      if (name === "profiles") {
        // Deliberately the WRONG answer for these tools. Any tool that reads
        // this instead of the organization will produce EUR and fail.
        return table([{ id: USER_ID, full_name: "Test", default_currency: "EUR", locale: "en-US" }]);
      }
      if (name === "accounts") {
        return table(data.balances.map((b) => ({ id: b.account_id, organization_id: ORG_ID, name: `Account ${b.account_id}`, kind: "bank", currency: b.currency, opening_balance_minor: 0, is_archived: false })));
      }
      return table([]);
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      if (name === "account_balances_minor") return Promise.resolve({ data: data.balances, error: null });
      if (name === "transaction_totals") return Promise.resolve({ data: data.totals, error: null });
      if (name === "transaction_category_totals") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: [], error: null });
    },
    rpcCalls,
  };
  return client as unknown as Parameters<typeof createToolRegistry>[0] & { rpcCalls: typeof rpcCalls };
}

function toolFrom(client: Parameters<typeof createToolRegistry>[0], name: string): AITool {
  const found = createToolRegistry(client).find((t) => t.name === name);
  if (!found) throw new Error(`No such tool: ${name}`);
  return found;
}

const USD_ONLY: StubData = {
  baseCurrency: "USD",
  balances: [
    { account_id: "a1", currency: "USD", balance_minor: 500_00 },
    { account_id: "a2", currency: "USD", balance_minor: 250_00 },
  ],
  totals: [
    { currency: "USD", kind: "income", total_minor: 900_00, transaction_count: 9, unreviewed_count: 2 },
    { currency: "USD", kind: "expense", total_minor: 400_00, transaction_count: 4, unreviewed_count: 0 },
  ],
};

const MIXED: StubData = {
  baseCurrency: "USD",
  balances: [
    { account_id: "a1", currency: "USD", balance_minor: 500_00 },
    { account_id: "a2", currency: "EUR", balance_minor: 900_00 },
    { account_id: "a3", currency: "GBP", balance_minor: 100_00 },
  ],
  totals: [
    { currency: "USD", kind: "income", total_minor: 900_00, transaction_count: 9, unreviewed_count: 0 },
    { currency: "EUR", kind: "income", total_minor: 700_00, transaction_count: 7, unreviewed_count: 0 },
  ],
};

interface OverviewResult {
  totalBalance: { amountMinor: number; currency: string };
  accountCount: number;
  accountsInTotal: number;
  thisMonth: { income: { amountMinor: number; currency: string } };
  currencyScope?: string;
}

describe("AI tools use the organization's base currency, not the user's profile (FIN-04)", () => {
  it("denominates an overview in the organization's base currency", async () => {
    const client = stubClient(USD_ONLY);
    const result = (await toolFrom(client, "getFinancialOverview").execute({}, context)) as OverviewResult;

    // The stubbed profile says EUR. The organization says USD. USD must win.
    expect(result.totalBalance.currency).toBe("USD");
    expect(result.thisMonth.income.currency).toBe("USD");
  });

  it("does not throw when the profile currency disagrees with the organization's", async () => {
    const client = stubClient(USD_ONLY);
    await expect(toolFrom(client, "getIncome").execute({ from: "2026-01-01", to: "2026-12-31" }, context)).resolves.toBeDefined();
  });

  it("honours an explicit currency when the user genuinely asked for one", async () => {
    const client = stubClient(MIXED);
    const result = (await toolFrom(client, "getIncome").execute({ from: "2026-01-01", to: "2026-12-31", currency: "EUR" }, context)) as {
      amountMinor: number;
      currency: string;
    };

    expect(result.currency).toBe("EUR");
    expect(result.amountMinor).toBe(700_00);
  });
});

describe("AI tools never fabricate a mixed-currency total (FIN-03)", () => {
  it("sums accounts that all share the base currency", async () => {
    const client = stubClient(USD_ONLY);
    const result = (await toolFrom(client, "getFinancialOverview").execute({}, context)) as OverviewResult;

    expect(result.totalBalance).toMatchObject({ amountMinor: 750_00, currency: "USD" });
    expect(result.accountsInTotal).toBe(2);
    expect(result.currencyScope).toBeUndefined();
  });

  it("excludes foreign-currency accounts instead of adding them at 1:1", async () => {
    const client = stubClient(MIXED);
    const result = (await toolFrom(client, "getFinancialOverview").execute({}, context)) as OverviewResult;

    // The old behaviour produced 1_500_00 "USD" from USD 500 + EUR 900 + GBP 100.
    expect(result.totalBalance.amountMinor).toBe(500_00);
    expect(result.totalBalance.amountMinor).not.toBe(1_500_00);
    expect(result.accountCount).toBe(3);
    expect(result.accountsInTotal).toBe(1);
  });

  it("states the exclusion in the tool result, so the model cannot omit it silently", async () => {
    const client = stubClient(MIXED);
    const result = (await toolFrom(client, "getFinancialOverview").execute({}, context)) as OverviewResult;

    expect(result.currencyScope).toContain("USD only");
    expect(result.currencyScope).toContain("EUR");
    expect(result.currencyScope).toContain("GBP");
    expect(result.currencyScope).toContain("never converted");
  });

  it("applies the same rule to a period total", async () => {
    const client = stubClient(MIXED);
    const result = (await toolFrom(client, "getIncome").execute({ from: "2026-01-01", to: "2026-12-31" }, context)) as {
      amountMinor: number;
      currency: string;
      currencyScope?: string;
    };

    expect(result).toMatchObject({ amountMinor: 900_00, currency: "USD" });
    expect(result.amountMinor).not.toBe(1_600_00);
    expect(result.currencyScope).toContain("EUR");
  });

  it("starts a cash-flow forecast from a base-currency-only balance", async () => {
    const client = stubClient(MIXED);
    const result = (await toolFrom(client, "forecastCashFlow").execute({ horizonDays: 7 }, context)) as {
      points: { balance: { amountMinor: number; currency: string } }[];
      currencyScope?: string;
    };

    expect(result.points.length).toBeGreaterThan(0);
    expect(result.points[0].balance.currency).toBe("USD");
    // Day one starts at the real USD balance, not the fabricated 1_500_00.
    expect(result.points[0].balance.amountMinor).toBe(500_00);
    expect(result.currencyScope).toContain("EUR");
  });

  it("returns a zero total, not a foreign-currency one, when nothing is in the base currency", async () => {
    const client = stubClient({
      baseCurrency: "USD",
      balances: [{ account_id: "a1", currency: "EUR", balance_minor: 900_00 }],
      totals: [{ currency: "EUR", kind: "income", total_minor: 700_00, transaction_count: 7, unreviewed_count: 0 }],
    });
    const result = (await toolFrom(client, "getFinancialOverview").execute({}, context)) as OverviewResult;

    expect(result.totalBalance).toMatchObject({ amountMinor: 0, currency: "USD" });
    expect(result.accountsInTotal).toBe(0);
    expect(result.currencyScope).toContain("EUR");
  });

  it("handles an organization with no accounts and no transactions", async () => {
    const client = stubClient({ baseCurrency: "USD", balances: [], totals: [] });
    const result = (await toolFrom(client, "getFinancialOverview").execute({}, context)) as OverviewResult;

    expect(result.totalBalance).toMatchObject({ amountMinor: 0, currency: "USD" });
    expect(result.accountCount).toBe(0);
    expect(result.currencyScope).toBeUndefined();
  });
});

describe("aggregate tools read through the SQL aggregates, not row lists (FIN-01)", () => {
  it("asks Postgres for the period total rather than fetching transactions", async () => {
    const client = stubClient(USD_ONLY);
    await toolFrom(client, "getProfitAndLoss").execute({ from: "2026-01-01", to: "2026-03-31" }, context);

    const names = client.rpcCalls.map((c) => c.name);
    expect(names).toContain("transaction_totals");
    expect(names).toContain("transaction_category_totals");
  });

  it("passes the requested period through to the aggregate unchanged", async () => {
    const client = stubClient(USD_ONLY);
    await toolFrom(client, "getExpenses").execute({ from: "2026-02-01", to: "2026-02-28" }, context);

    const call = client.rpcCalls.find((c) => c.name === "transaction_totals");
    expect(call?.args).toMatchObject({ p_organization_id: ORG_ID, p_date_from: "2026-02-01", p_date_to: "2026-02-28" });
  });

  it("scopes every aggregate to the authorized organization from the tool context", async () => {
    const client = stubClient(USD_ONLY);
    await toolFrom(client, "getFinancialOverview").execute({}, context);

    for (const call of client.rpcCalls) {
      expect(call.args).toMatchObject({ p_organization_id: ORG_ID });
    }
  });
});
