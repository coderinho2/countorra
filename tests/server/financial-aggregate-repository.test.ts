import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The repository seam between the SQL aggregates and the domain layer.
 *
 * tests/rls/financial-aggregates.test.ts proves the SQL is right against real
 * Postgres. src/domain/financial/aggregate-totals.test.ts proves the domain
 * functions are right. This covers the translation between them, where three
 * specific things can go wrong silently:
 *
 *   - a mis-named RPC argument (PostgREST would 404, or worse, apply a
 *     default and quietly widen the query)
 *   - a filter dropped on the way through, so the totals describe a different
 *     set from the list beside them (FIN-02)
 *   - a currency the build cannot format being coerced instead of dropped
 */

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    rpcData: [] as unknown[],
    rpcError: null as { message: string } | null,
  };
});

const client = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    state.rpcCalls.push({ name, args });
    return { data: state.rpcData, error: state.rpcError };
  },
} as never;

const { getTransactionTotals, getCategoryTotals, escapeLikePattern } = await import("@/server/db/repositories/transactions");
const { listAccountBalances } = await import("@/server/db/repositories/accounts");

const ORG = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  state.rpcCalls = [];
  state.rpcData = [];
  state.rpcError = null;
});

describe("getTransactionTotals", () => {
  it("calls the aggregate function, never a row select", async () => {
    await getTransactionTotals(client, { organizationId: ORG });
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].name).toBe("transaction_totals");
  });

  it("passes the organization through as the scan scope", async () => {
    await getTransactionTotals(client, { organizationId: ORG });
    expect(state.rpcCalls[0].args.p_organization_id).toBe(ORG);
  });

  it("forwards every filter under its SQL parameter name", async () => {
    await getTransactionTotals(client, {
      organizationId: ORG,
      kind: "expense",
      accountId: "22222222-2222-4222-8222-222222222222",
      categoryId: "33333333-3333-4333-8333-333333333333",
      merchantId: "44444444-4444-4444-8444-444444444444",
      dateFrom: "2026-01-01",
      dateTo: "2026-03-31",
      amountMinMinor: 500,
      amountMaxMinor: 50_000,
      isReviewed: false,
      categorizedBy: "ai",
      search: "coffee",
    });

    expect(state.rpcCalls[0].args).toEqual({
      p_organization_id: ORG,
      p_kind: "expense",
      p_account_id: "22222222-2222-4222-8222-222222222222",
      p_category_id: "33333333-3333-4333-8333-333333333333",
      p_merchant_id: "44444444-4444-4444-8444-444444444444",
      p_date_from: "2026-01-01",
      p_date_to: "2026-03-31",
      p_amount_min_minor: 500,
      p_amount_max_minor: 50_000,
      p_is_reviewed: false,
      p_categorized_by: "ai",
      p_search: "coffee",
    });
  });

  it("sends null, not undefined, for an absent filter", async () => {
    // PostgREST omits undefined keys, which would silently fall back to the
    // SQL default. Explicit nulls keep the two in step.
    await getTransactionTotals(client, { organizationId: ORG });
    for (const [key, value] of Object.entries(state.rpcCalls[0].args)) {
      if (key === "p_organization_id") continue;
      expect(value, `${key} should be null`).toBeNull();
    }
  });

  it("distinguishes isReviewed=false from isReviewed unset", async () => {
    await getTransactionTotals(client, { organizationId: ORG, isReviewed: false });
    expect(state.rpcCalls[0].args.p_is_reviewed).toBe(false);

    state.rpcCalls = [];
    await getTransactionTotals(client, { organizationId: ORG });
    expect(state.rpcCalls[0].args.p_is_reviewed).toBeNull();
  });

  it("escapes LIKE wildcards with the same function the list query uses", async () => {
    await getTransactionTotals(client, { organizationId: ORG, search: "50%_off" });
    expect(state.rpcCalls[0].args.p_search).toBe(escapeLikePattern("50%_off"));
    expect(state.rpcCalls[0].args.p_search).toBe("50\\%\\_off");
  });

  it("maps the returned rows into the domain shape", async () => {
    state.rpcData = [{ currency: "USD", kind: "income", total_minor: 90_000, transaction_count: 9, unreviewed_count: 2 }];
    const rows = await getTransactionTotals(client, { organizationId: ORG });

    expect(rows).toEqual([{ currency: "USD", kind: "income", totalMinor: 90_000, transactionCount: 9, unreviewedCount: 2 }]);
  });

  it("coerces bigints arriving as strings without losing exactness", async () => {
    state.rpcData = [{ currency: "USD", kind: "income", total_minor: "900000", transaction_count: "1600", unreviewed_count: "0" }];
    const [row] = await getTransactionTotals(client, { organizationId: ORG });

    expect(row.totalMinor).toBe(900_000);
    expect(row.transactionCount).toBe(1600);
  });

  it("drops an unformattable currency rather than folding it into another total", async () => {
    state.rpcData = [
      { currency: "USD", kind: "income", total_minor: 100, transaction_count: 1, unreviewed_count: 0 },
      { currency: "ZZZ", kind: "income", total_minor: 999_999, transaction_count: 1, unreviewed_count: 0 },
    ];
    const rows = await getTransactionTotals(client, { organizationId: ORG });

    expect(rows).toHaveLength(1);
    expect(rows[0].currency).toBe("USD");
    expect(rows.reduce((sum, r) => sum + r.totalMinor, 0)).toBe(100);
  });

  it("returns an empty list, not a zero row, when there is nothing", async () => {
    state.rpcData = [];
    await expect(getTransactionTotals(client, { organizationId: ORG })).resolves.toEqual([]);
  });

  it("throws rather than reporting zero when the query fails", async () => {
    // A failed aggregate must never look like "you have no money".
    state.rpcError = { message: "connection reset" };
    await expect(getTransactionTotals(client, { organizationId: ORG })).rejects.toBeDefined();
  });
});

describe("getCategoryTotals", () => {
  it("calls the category aggregate with the period", async () => {
    await getCategoryTotals(client, { organizationId: ORG, from: "2026-01-01", to: "2026-03-31" });
    expect(state.rpcCalls[0]).toEqual({
      name: "transaction_category_totals",
      args: { p_organization_id: ORG, p_date_from: "2026-01-01", p_date_to: "2026-03-31" },
    });
  });

  it("keeps the null category, which is real uncategorised spend", async () => {
    state.rpcData = [{ category_id: null, currency: "USD", total_minor: 5_000 }];
    const rows = await getCategoryTotals(client, { organizationId: ORG });

    expect(rows).toEqual([{ categoryId: null, currency: "USD", totalMinor: 5_000 }]);
  });

  it("drops an unformattable currency", async () => {
    state.rpcData = [
      { category_id: "c1", currency: "USD", total_minor: 100 },
      { category_id: "c1", currency: "ZZZ", total_minor: 999 },
    ];
    await expect(getCategoryTotals(client, { organizationId: ORG })).resolves.toHaveLength(1);
  });

  it("throws rather than reporting no spend when the query fails", async () => {
    state.rpcError = { message: "boom" };
    await expect(getCategoryTotals(client, { organizationId: ORG })).rejects.toBeDefined();
  });
});

describe("listAccountBalances", () => {
  it("returns every account in one call, not one call per account", async () => {
    state.rpcData = [
      { account_id: "a1", currency: "USD", balance_minor: 50_000 },
      { account_id: "a2", currency: "EUR", balance_minor: 90_000 },
      { account_id: "a3", currency: "GBP", balance_minor: 10_000 },
    ];
    const balances = await listAccountBalances(client, ORG);

    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toEqual({ name: "account_balances_minor", args: { p_organization_id: ORG } });
    expect(balances).toHaveLength(3);
  });

  it("preserves each account's own currency rather than normalizing it", async () => {
    state.rpcData = [
      { account_id: "a1", currency: "USD", balance_minor: 50_000 },
      { account_id: "a2", currency: "EUR", balance_minor: 90_000 },
    ];
    const balances = await listAccountBalances(client, ORG);

    expect(balances.map((b) => b.currency)).toEqual(["USD", "EUR"]);
  });

  it("carries a negative balance through unchanged", async () => {
    state.rpcData = [{ account_id: "a1", currency: "USD", balance_minor: -1_327_440 }];
    const [balance] = await listAccountBalances(client, ORG);

    expect(balance.balanceMinor).toBe(-1_327_440);
  });

  it("coerces a string bigint exactly", async () => {
    state.rpcData = [{ account_id: "a1", currency: "USD", balance_minor: "100775000" }];
    const [balance] = await listAccountBalances(client, ORG);

    expect(balance.balanceMinor).toBe(100_775_000);
  });

  it("throws rather than reporting a zero balance when the query fails", async () => {
    state.rpcError = { message: "boom" };
    await expect(listAccountBalances(client, ORG)).rejects.toBeDefined();
  });

  it("returns nothing for an organization with no accounts", async () => {
    await expect(listAccountBalances(client, ORG)).resolves.toEqual([]);
  });
});

describe("escapeLikePattern", () => {
  it("escapes both LIKE wildcards", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeLikePattern("Northwind Traders")).toBe("Northwind Traders");
  });

  it("is the single implementation shared by the list and the totals", async () => {
    // If these ever diverge, a filtered page shows a total for a different
    // set of rows than it lists — the FIN-02 failure in a new disguise.
    await getTransactionTotals(client, { organizationId: ORG, search: "a_b%c" });
    expect(state.rpcCalls[0].args.p_search).toBe(escapeLikePattern("a_b%c"));
  });
});
