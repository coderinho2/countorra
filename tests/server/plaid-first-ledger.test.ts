import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Plaid-first ledger at the application layer (src/domain/accounts/manual-entry.ts):
 * only cash and wallet accounts are added by hand, and the assistant's drafts
 * land only in cash or wallet accounts no bank connection feeds. The database
 * enforces the same rule (tests/rls/plaid-first-ledger.test.ts); the hand-entry
 * server action is covered in tests/server/transfer-transactions.test.ts.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    accountsCreated: [] as Record<string, unknown>[],
    transactionsCreated: [] as Record<string, unknown>[],
    accounts: new Map<string, { id: string; organizationId: string; kind: string; currency: string }>(),
    connected: new Set<string>(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/server/auth/session", () => ({ requireOrgMembership: async () => ({ user: { id: "user-1" }, membership: { role: "owner" } }) }));
vi.mock("@/server/security/rate-limit", () => ({ enforceRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/domain/audit/audit-log", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/domain/audit/audit-log")>()), recordAuditEvent: async () => {} }));
vi.mock("@/server/db/repositories/accounts", () => ({
  createAccount: async (_c: unknown, input: Record<string, unknown>) => {
    state.accountsCreated.push(input);
    return { id: "acct-new" };
  },
  archiveAccount: async () => {},
  getAccount: async (_c: unknown, id: string) => state.accounts.get(id) ?? null,
  listAccounts: async () => [...state.accounts.values()],
  listAccountBalances: async () => [],
}));
vi.mock("@/server/db/repositories/bank-connections", () => ({
  listBankFedAccounts: async () => new Map([...state.connected].map((id) => [id, {}])),
}));
vi.mock("@/server/db/repositories/transactions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/db/repositories/transactions")>()),
  createTransaction: async (_c: unknown, input: Record<string, unknown>) => {
    state.transactionsCreated.push(input);
    return { id: "txn-new", ...input };
  },
}));

const { createAccountAction } = await import("@/server/accounts/actions");
const { createToolRegistry } = await import("@/domain/ai/tools/registry");
const { MANUAL_ACCOUNT_REFUSAL, MANUAL_ENTRY_REFUSAL } = await import("@/domain/accounts/manual-entry");

beforeEach(() => {
  state.accountsCreated = [];
  state.transactionsCreated = [];
  state.accounts = new Map([
    ["cash-1", { id: "cash-1", organizationId: ORG, kind: "cash", currency: "USD" }],
    ["bank-1", { id: "bank-1", organizationId: ORG, kind: "bank", currency: "USD" }],
    ["theirs", { id: "theirs", organizationId: OTHER_ORG, kind: "cash", currency: "USD" }],
  ]);
  state.connected = new Set();
});

function accountForm(kind: string) {
  const form = new FormData();
  form.set("organizationId", ORG);
  form.set("name", "Mine");
  form.set("kind", kind);
  form.set("currency", "USD");
  return form;
}

describe("adding an account by hand", () => {
  it.each(["cash", "wallet"])("allows %s", async (kind) => {
    expect(await createAccountAction({}, accountForm(kind))).toEqual({ success: true });
    expect(state.accountsCreated).toHaveLength(1);
  });

  it.each(["bank", "credit_card", "other"])("refuses %s — those come from connecting a bank", async (kind) => {
    expect((await createAccountAction({}, accountForm(kind))).error).toBe(MANUAL_ACCOUNT_REFUSAL);
    expect(state.accountsCreated).toEqual([]);
  });
});

describe("the assistant's transaction drafts", () => {
  const draft = async (tool: "createDraftTransaction" | "createDraftExpense", accountId: string) => {
    const t = createToolRegistry({} as never).find((x) => x.name === tool)!;
    const input = t.parseInput!({ accountId, kind: "expense", amount: "12.50", currency: "USD", occurredOn: "2026-09-01" });
    return t.execute(input, { organizationId: ORG, userId: "user-1" }) as Promise<Record<string, unknown>>;
  };

  beforeEach(() => {
    // parseInput requires uuids; map the fixture ids onto them.
    const uuids: Record<string, string> = { "cash-1": "22222222-2222-4222-8222-222222222222", "bank-1": "33333333-3333-4333-8333-333333333333", theirs: "44444444-4444-4444-8444-444444444444" };
    state.accounts = new Map([...state.accounts.values()].map((a) => [uuids[a.id], { ...a, id: uuids[a.id] }]));
  });

  it.each(["createDraftTransaction", "createDraftExpense"] as const)("%s records a cash transaction", async (tool) => {
    await draft(tool, "22222222-2222-4222-8222-222222222222");
    expect(state.transactionsCreated).toHaveLength(1);
    expect(state.transactionsCreated[0]).toMatchObject({ source: "ai" });
  });

  it.each(["createDraftTransaction", "createDraftExpense"] as const)("%s refuses a bank account, writing nothing", async (tool) => {
    expect(await draft(tool, "33333333-3333-4333-8333-333333333333")).toMatchObject({ refused: true, reason: "BANK_SOURCED_ACCOUNT", message: MANUAL_ENTRY_REFUSAL });
    expect(state.transactionsCreated).toEqual([]);
  });

  it("refuses a cash account a bank connection imports into", async () => {
    state.connected = new Set(["22222222-2222-4222-8222-222222222222"]);
    expect(await draft("createDraftExpense", "22222222-2222-4222-8222-222222222222")).toMatchObject({ refused: true, reason: "BANK_SOURCED_ACCOUNT" });
    expect(state.transactionsCreated).toEqual([]);
  });

  it("refuses another workspace's account", async () => {
    expect(await draft("createDraftExpense", "44444444-4444-4444-8444-444444444444")).toMatchObject({ refused: true, reason: "ACCOUNT_NOT_FOUND" });
    expect(state.transactionsCreated).toEqual([]);
  });

  it("tells the model bank transactions come only from the bank connection", () => {
    const t = createToolRegistry({} as never).find((x) => x.name === "createDraftTransaction")!;
    expect(t.description).toMatch(/come only from the bank connection/);
  });
});
