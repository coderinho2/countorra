import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTransactionSchema } from "@/validation/schemas/transaction";

/**
 * Transfers: money moving between two of the organization's OWN accounts.
 *
 * The half-built state this completes: the column, the constraints and the
 * balance arithmetic existed, but nothing could create one — the validation
 * schema had no field for the other side and the action never passed it.
 *
 * The financial guarantee that must not break is that a transfer is neither
 * income nor spending. Counting one as either inflates revenue or expenses
 * by the size of every internal movement.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const CHECKING = "22222222-2222-4222-8222-222222222222";
const SAVINGS = "33333333-3333-4333-8333-333333333333";
const EUR_ACCOUNT = "44444444-4444-4444-8444-444444444444";
const OTHER_ORG_ACCOUNT = "55555555-5555-4555-8555-555555555555";

const valid = {
  organizationId: ORG,
  accountId: CHECKING,
  kind: "transfer" as const,
  transferAccountId: SAVINGS,
  amount: "250.00",
  currency: "USD" as const,
  occurredOn: "2026-09-01",
};

describe("schema validation", () => {
  it("accepts a well-formed transfer", () => {
    expect(createTransactionSchema.safeParse(valid).success).toBe(true);
  });

  it("REQUIRES a destination account", () => {
    const result = createTransactionSchema.safeParse({ ...valid, transferAccountId: undefined });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toMatch(/account the money is moving to/i);
  });

  it("refuses a transfer to the same account", () => {
    // The database refuses this too (`transactions_transfer_not_self`).
    // Catching it here turns a constraint violation into a sentence.
    const result = createTransactionSchema.safeParse({ ...valid, transferAccountId: CHECKING });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toMatch(/two different accounts/i);
  });

  it("refuses a category on a transfer", () => {
    // A transfer is neither earned nor spent, and every aggregate excludes
    // it — so a category on one would appear in no breakdown.
    const result = createTransactionSchema.safeParse({ ...valid, categoryId: "66666666-6666-4666-8666-666666666666" });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toMatch(/aren't categorized/i);
  });

  it.each(["income", "expense"] as const)("refuses a destination account on a %s", (kind) => {
    const result = createTransactionSchema.safeParse({ ...valid, kind, transferAccountId: SAVINGS });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toMatch(/Only a transfer/i);
  });

  it.each(["income", "expense"] as const)("still accepts an ordinary %s with a category", (kind) => {
    const result = createTransactionSchema.safeParse({
      ...valid,
      kind,
      transferAccountId: undefined,
      categoryId: "66666666-6666-4666-8666-666666666666",
    });
    expect(result.success).toBe(true);
  });

  it("still requires a decimal amount", () => {
    expect(createTransactionSchema.safeParse({ ...valid, amount: "250.005" }).success).toBe(false);
    expect(createTransactionSchema.safeParse({ ...valid, amount: "abc" }).success).toBe(false);
  });

  it("refuses a non-uuid destination", () => {
    expect(createTransactionSchema.safeParse({ ...valid, transferAccountId: "not-a-uuid" }).success).toBe(false);
  });
});

// ── The action, where cross-account rules are enforced ──────────────────

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    created: [] as Record<string, unknown>[],
    accounts: [] as { id: string; organizationId: string; currency: string; name: string }[],
  };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/observability", () => ({ reportError: () => {}, reportEvent: () => {} }));

vi.mock("@/server/auth/session", () => ({
  requireUser: async () => ({ id: "user-1" }),
  requireOrgMembership: async (organizationId: string) => ({
    user: { id: "user-1" },
    membership: { organizationId, userId: "user-1", role: "owner" },
  }),
}));

vi.mock("@/server/security/rate-limit", () => ({
  enforceRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0, message: "", degraded: false }),
}));

vi.mock("@/domain/audit/audit-log", () => ({
  recordAuditEvent: async () => {},
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

vi.mock("@/server/db/repositories/merchants", () => ({ findOrCreateMerchant: async () => ({ id: "m1" }) }));

vi.mock("@/server/db/repositories/accounts", () => ({
  // Scoped by organization, exactly as the real repository is under RLS.
  listAccounts: async (_c: unknown, organizationId: string) => state.accounts.filter((a) => a.organizationId === organizationId),
}));

vi.mock("@/server/db/repositories/transactions", () => ({
  createTransaction: async (_c: unknown, input: Record<string, unknown>) => {
    state.created.push(input);
    return { id: "txn-1", ...input };
  },
}));

const { createTransactionAction } = await import("@/server/transactions/actions");

function form(overrides: Record<string, string> = {}) {
  const data = new FormData();
  const fields: Record<string, string> = {
    organizationId: ORG,
    accountId: CHECKING,
    kind: "transfer",
    transferAccountId: SAVINGS,
    amount: "250.00",
    currency: "USD",
    occurredOn: "2026-09-01",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) if (value !== "") data.set(key, value);
  return data;
}

beforeEach(() => {
  state.created = [];
  state.accounts = [
    { id: CHECKING, organizationId: ORG, currency: "USD", name: "Checking" },
    { id: SAVINGS, organizationId: ORG, currency: "USD", name: "Savings" },
    { id: EUR_ACCOUNT, organizationId: ORG, currency: "EUR", name: "Euro account" },
    { id: OTHER_ORG_ACCOUNT, organizationId: "99999999-9999-4999-8999-999999999999", currency: "USD", name: "Rival checking" },
  ];
});

describe("creating a transfer", () => {
  it("records both sides on one row", async () => {
    const result = await createTransactionAction({}, form());

    expect(result.error).toBeUndefined();
    expect(state.created[0]).toMatchObject({ kind: "transfer", accountId: CHECKING, transferAccountId: SAVINGS, amountMinor: 25_000 });
  });

  it("converts the amount through the money domain, exactly", async () => {
    await createTransactionAction({}, form({ amount: "8.16" }));
    expect(state.created[0].amountMinor).toBe(816);
  });

  it("leaves transferAccountId null on an ordinary expense", async () => {
    await createTransactionAction({}, form({ kind: "expense", transferAccountId: "" }));
    expect(state.created[0]).toMatchObject({ kind: "expense", transferAccountId: null });
  });
});

describe("cross-account rules the schema cannot check", () => {
  it("REFUSES a destination account in another organization", async () => {
    // The whole tenancy question for transfers. RLS would refuse the write,
    // but it refuses by returning nothing — a confusing constraint error
    // rather than an explanation.
    const result = await createTransactionAction({}, form({ transferAccountId: OTHER_ORG_ACCOUNT }));

    expect(result.error).toMatch(/belong to this workspace/i);
    expect(state.created).toEqual([]);
  });

  it("refuses a SOURCE account in another organization", async () => {
    const result = await createTransactionAction({}, form({ accountId: OTHER_ORG_ACCOUNT, transferAccountId: CHECKING }));

    expect(result.error).toMatch(/belong to this workspace/i);
    expect(state.created).toEqual([]);
  });

  it("refuses a cross-currency transfer", async () => {
    // Countorra converts no currencies anywhere, so a USD→EUR transfer has
    // no single correct amount. Refusing is honest; inventing a rate is not.
    const result = await createTransactionAction({}, form({ transferAccountId: EUR_ACCOUNT }));

    expect(result.error).toMatch(/same currency/i);
    expect(state.created).toEqual([]);
  });

  it("refuses a transfer recorded in a currency neither account uses", async () => {
    const result = await createTransactionAction({}, form({ currency: "EUR" }));

    expect(result.error).toMatch(/must be recorded in USD/i);
    expect(state.created).toEqual([]);
  });

  it("does not run account checks for income or expense", async () => {
    // An expense against a USD account, recorded in USD, needs no second
    // account — the transfer-only checks must not fire.
    const result = await createTransactionAction({}, form({ kind: "expense", transferAccountId: "" }));
    expect(result.error).toBeUndefined();
  });
});

describe("the existing financial guarantee still holds", () => {
  it("keeps transfers out of income and expense totals", async () => {
    // Re-asserted here because this milestone is what makes transfers
    // creatable in the first place: before it, no user could produce a row
    // that exercised the exclusion.
    const { summarizeTotals } = await import("@/domain/financial/calculation-engine");

    const row = (kind: "income" | "expense" | "transfer", totalMinor: number) => ({
      kind,
      currency: "USD" as const,
      totalMinor,
      transactionCount: 1,
      unreviewedCount: 0,
    });

    const withTransfer = summarizeTotals([row("income", 100_000), row("expense", 40_000), row("transfer", 500_000)], "USD");
    const without = summarizeTotals([row("income", 100_000), row("expense", 40_000)], "USD");

    expect(withTransfer.income.amountMinor).toBe(100_000);
    expect(withTransfer.expense.amountMinor).toBe(40_000);
    expect(withTransfer.profit.amountMinor).toBe(60_000);

    // A half-million-dollar internal movement changes nothing at all — the
    // summary is identical with and without it.
    expect(withTransfer).toEqual(without);
  });
});
