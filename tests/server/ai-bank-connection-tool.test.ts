import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Bank connections at the AI boundary.
 *
 * The assistant gets exactly one bank tool, read-only, reporting STATUS. It
 * cannot connect, refresh, disconnect or link; it receives no provider
 * identifier, no bank-reported balance and no bank transaction; and with no
 * provider configured it is told so in words it cannot mistake for a
 * connection.
 */

const ORG = "11111111-1111-4111-8111-111111111111";

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    connections: [] as Record<string, unknown>[],
    linked: [] as Record<string, unknown>[],
    subscription: { planId: "premium", status: "active" } as { planId: string; status: string } | null,
    writes: 0,
  };
});

vi.mock("@/lib/observability", () => ({ reportError: () => {}, reportEvent: () => {} }));
vi.mock("@/server/db/repositories/accounts", () => ({
  listAccounts: async () => [{ id: "acc-1", name: "Checking", currency: "USD", kind: "bank", openingBalanceMinor: 0, isArchived: false, organizationId: ORG }],
  listAccountBalances: async () => [],
}));
// The workspace reads the plan through the canonical entitlement source.
vi.mock("@/server/db/repositories/subscriptions", () => ({ getSubscription: async () => state.subscription }));
vi.mock("@/server/db/repositories/bank-connections", () => ({
  listBankConnections: async () => state.connections,
  listLinkedAccounts: async () => state.linked,
  listLatestSyncJobs: async () => new Map(),
  listReviewItems: async () => [],
  countExternalTransactions: async () => 2,
  createSupabaseBankStore: () => {
    state.writes += 1;
    return {};
  },
}));

const { createToolRegistry } = await import("@/domain/ai/tools/registry");
const { parseToolInput, InvalidToolInputError } = await import("@/domain/ai/tools/types");

const tools = createToolRegistry({} as never);
const statusTool = tools.find((tool) => tool.name === "getBankConnectionStatus")!;
const ctx = { organizationId: ORG, userId: "user-1" } as never;

beforeEach(() => {
  state.connections = [];
  state.linked = [];
  state.writes = 0;
});

describe("the assistant's bank tools", () => {
  it("are exactly one read-only status tool", () => {
    expect(tools.filter((tool) => /bank|plaid|institution/i.test(tool.name)).map((tool) => tool.name)).toEqual(["getBankConnectionStatus"]);
    expect(statusTool.operationMode).toBe("read");
    expect(tools.some((tool) => /connect|disconnect|link|sync|refresh/i.test(tool.name) && tool.name !== "getBankConnectionStatus")).toBe(false);
  });

  it("refuses any argument, so nothing can be smuggled in", () => {
    expect(() => parseToolInput(statusTool, { connect: true })).toThrow(InvalidToolInputError);
    expect(() => parseToolInput(statusTool, { connectionId: "x", status: "ACTIVE" })).toThrow(InvalidToolInputError);
    expect(parseToolInput(statusTool, {})).toEqual({});
  });

  it("says plainly that no provider is configured, and invents no connection", async () => {
    const result = (await statusTool.execute({}, ctx)) as { providerConfigured: boolean; providerNote: string; connections: unknown[]; guidance: string };
    expect(result.providerConfigured).toBe(false);
    expect(result.connections).toEqual([]);
    expect(result.providerNote).toMatch(/No bank connection provider is configured/);
    expect(result.guidance).toMatch(/Never describe a bank as connected unless/);
    expect(state.writes).toBe(0);
  });

  it("reports status without bank-reported balances or provider identifiers", async () => {
    state.connections = [
      {
        id: "conn-1",
        provider: "fixture",
        institutionName: "Synthetic Credit Union",
        status: "REQUIRES_REAUTH",
        statusReason: "PROVIDER_REPORTED_REAUTH",
        statusChangedAt: "2026-09-15T10:00:00Z",
        consecutiveFailedRuns: 0,
        lastFailureCategory: null,
        lastSuccessfulSyncAt: "2026-09-14T10:00:00Z",
        lastSyncAttemptAt: null,
        disconnectedAt: null,
        createdAt: "2026-09-01T10:00:00Z",
      },
    ];
    state.linked = [
      {
        id: "la-1",
        connectionId: "conn-1",
        accountId: "acc-1",
        importMode: "IMPORT",
        accountType: "DEPOSITORY",
        accountSubtype: "checking",
        displayName: "Everyday Checking",
        mask: "3333",
        currency: "USD",
        currentBalanceMinor: 12_345_678,
        availableBalanceMinor: 12_000_000,
        balancesAsOf: "2026-09-14T10:00:00Z",
        providerState: "OPEN",
        detached: false,
      },
    ];
    const result = await statusTool.execute({}, ctx);
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("REQUIRES_REAUTH");
    expect(serialized).toContain("Everyday Checking");
    expect(serialized).toContain("Checking");
    for (const forbidden of ["12345678", "123456.78", "12000000", "conn-1", "la-1", "provider_connection_id", "providerConnectionId", "Balance"]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });
});
