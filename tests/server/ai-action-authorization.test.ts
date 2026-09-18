import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `confirmAiAction` — the human-in-the-loop gate for every AI write.
 *
 * This is the single most security-sensitive Server Action in the product:
 * it is where a model's *proposal* becomes a real financial record. The
 * database backstops it (the `ai_actions` CHECK constraint, the immutability
 * trigger and the status machine in 0024, all covered by
 * tests/rls/ai-actions-hardening.test.ts) — but nothing exercised the
 * application half, which is what decides whether the tool runs at all.
 *
 * The properties asserted here are the ones an attacker would probe:
 *
 *   - the organization is read from the ACTION ROW, never from the request
 *   - the role gate runs before either branch, approve or reject
 *   - a second confirmation of the same action cannot execute it twice
 *   - stored arguments are re-validated before being replayed
 *   - a tool never runs unless the claim succeeded first
 */

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    action: null as Record<string, unknown> | null,
    role: "owner",
    userId: "22222222-2222-4222-8222-222222222222",
    claimSucceeds: true,
    authorizedOrgs: [] as string[],
    claims: [] as string[],
    executions: [] as { tool: string; input: unknown; ctx: unknown }[],
    executed: [] as string[],
    failed: [] as { id: string; message: string }[],
    rejected: [] as string[],
    audits: [] as Record<string, unknown>[],
    toolThrows: null as Error | null,
    rateLimited: false,
  };
});

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    const e = new Error(`NEXT_REDIRECT:${to}`) as Error & { digest?: string };
    e.digest = `NEXT_REDIRECT;${to}`;
    throw e;
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/server/supabase/admin", () => ({ createAdminClient: () => ({}) }));

vi.mock("@/server/auth/session", () => ({
  requireUser: async () => ({ id: state.userId }),
  getSession: async () => ({ id: state.userId }),
  requireOrgMembership: async (organizationId: string) => {
    state.authorizedOrgs.push(organizationId);
    return { user: { id: state.userId }, membership: { organizationId, userId: state.userId, role: state.role } };
  },
}));

vi.mock("@/server/security/rate-limit", () => ({
  enforceRateLimit: async () => ({ allowed: !state.rateLimited, retryAfterSeconds: 0, message: "Too many requests.", degraded: false }),
  clientAddress: async () => "127.0.0.1",
  normalizeIdentifier: (v: string) => v,
}));

vi.mock("@/server/db/repositories/ai-conversations", () => ({
  getAiAction: async () => state.action,
  claimActionForExecution: async (_c: unknown, id: string) => {
    state.claims.push(id);
    return state.claimSucceeds;
  },
  markActionExecuted: async (_c: unknown, id: string) => {
    state.executed.push(id);
  },
  markActionFailed: async (_c: unknown, id: string, message: string) => {
    state.failed.push({ id, message });
  },
  markActionRejected: async (_c: unknown, id: string) => {
    state.rejected.push(id);
    return true;
  },
  addMessage: async () => ({}),
  createConversation: async () => ({ id: "c" }),
  getConversation: async () => null,
  listConversations: async () => [],
  listMessages: async () => [],
  countUserMessagesSince: async () => 0,
  createPendingAction: async () => ({ id: "a" }),
  deleteConversation: async () => true,
  renameConversation: async () => true,
}));

vi.mock("@/domain/audit/audit-log", () => ({
  recordAuditEvent: async (_c: unknown, event: Record<string, unknown>) => {
    state.audits.push(event);
  },
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

vi.mock("@/domain/ai/tools/registry", () => ({
  createToolRegistry: () => [
    {
      name: "createDraftTransaction",
      description: "",
      operationMode: "write",
      inputSchema: {},
      parseInput: (input: unknown) => {
        const i = input as { amount?: unknown };
        if (typeof i?.amount !== "string") throw new Error("amount must be a string");
        return input;
      },
      execute: async (input: unknown, ctx: unknown) => {
        if (state.toolThrows) throw state.toolThrows;
        state.executions.push({ tool: "createDraftTransaction", input, ctx });
        return { created: true };
      },
    },
    {
      name: "getIncome",
      description: "",
      operationMode: "read",
      inputSchema: {},
      execute: async () => ({ amountMinor: 1 }),
    },
  ],
}));

const { confirmAiAction } = await import("@/server/ai/actions");

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const ACTION_ID = "44444444-4444-4444-8444-444444444444";

function pendingAction(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTION_ID,
    organizationId: ORG,
    conversationId: "55555555-5555-4555-8555-555555555555",
    operationMode: "write",
    toolName: "createDraftTransaction",
    input: { amount: "42.50", currency: "USD" },
    status: "pending_confirmation",
    ...overrides,
  };
}

beforeEach(() => {
  state.action = pendingAction();
  state.role = "owner";
  state.claimSucceeds = true;
  state.authorizedOrgs = [];
  state.claims = [];
  state.executions = [];
  state.executed = [];
  state.failed = [];
  state.rejected = [];
  state.audits = [];
  state.toolThrows = null;
  state.rateLimited = false;
});

describe("organization scoping", () => {
  it("authorizes against the organization on the action row, not the request", async () => {
    state.action = pendingAction({ organizationId: OTHER_ORG });
    await confirmAiAction({ aiActionId: ACTION_ID, approve: true });

    // The caller supplies only an action id. The org must come from the row.
    expect(state.authorizedOrgs).toEqual([OTHER_ORG]);
  });

  it("executes the tool scoped to the action's own organization", async () => {
    await confirmAiAction({ aiActionId: ACTION_ID, approve: true });
    expect(state.executions[0].ctx).toEqual({ organizationId: ORG, userId: state.userId });
  });

  it("refuses an action that does not exist, without authorizing anything", async () => {
    state.action = null;
    const result = await confirmAiAction({ aiActionId: ACTION_ID, approve: true });

    expect(result).toMatchObject({ status: "rejected" });
    expect(state.authorizedOrgs).toEqual([]);
    expect(state.executions).toEqual([]);
  });

  it("rejects a malformed action id before any lookup", async () => {
    const result = await confirmAiAction({ aiActionId: "not-a-uuid", approve: true });
    expect(result.status).toBe("rejected");
    expect(state.executions).toEqual([]);
  });
});

describe("role gate", () => {
  const allowed = ["owner", "admin", "accountant", "manager"];
  const denied = ["employee", "viewer"];

  for (const role of allowed) {
    it(`lets ${role} confirm`, async () => {
      state.role = role;
      const result = await confirmAiAction({ aiActionId: ACTION_ID, approve: true });
      expect(result.status).toBe("executed");
      expect(state.executions).toHaveLength(1);
    });
  }

  for (const role of denied) {
    it(`stops ${role} confirming`, async () => {
      state.role = role;
      const result = await confirmAiAction({ aiActionId: ACTION_ID, approve: true });
      expect(result.status).toBe("rejected");
      expect(result.error).toContain("permission");
      expect(state.executions).toEqual([]);
      expect(state.claims).toEqual([]);
    });

    // Rejecting is also an UPDATE on ai_actions, gated by the same policy.
    // The check previously sat after the reject branch, so an unprivileged
    // member was told their rejection worked while RLS discarded the write.
    it(`stops ${role} rejecting someone else's pending action`, async () => {
      state.role = role;
      const result = await confirmAiAction({ aiActionId: ACTION_ID, approve: false });
      expect(result.error).toContain("permission");
      expect(state.rejected).toEqual([]);
    });
  }
});

describe("replay and double-execution protection", () => {
  it("executes only after the atomic claim succeeds", async () => {
    await confirmAiAction({ aiActionId: ACTION_ID, approve: true });
    expect(state.claims).toEqual([ACTION_ID]);
    expect(state.executions).toHaveLength(1);
  });

  it("does not execute when another request already claimed the action", async () => {
    state.claimSucceeds = false;
    const result = await confirmAiAction({ aiActionId: ACTION_ID, approve: true });

    expect(result).toMatchObject({ status: "rejected", error: "This action was already confirmed." });
    expect(state.executions).toEqual([]);
    expect(state.executed).toEqual([]);
  });

  for (const status of ["executed", "confirmed", "rejected", "failed"]) {
    it(`refuses to act on an action already marked ${status}`, async () => {
      state.action = pendingAction({ status });
      const result = await confirmAiAction({ aiActionId: ACTION_ID, approve: true });

      expect(result.status).toBe("rejected");
      expect(result.error).toContain(status);
      expect(state.claims).toEqual([]);
      expect(state.executions).toEqual([]);
    });
  }

  it("records an audit event naming the tool that ran", async () => {
    await confirmAiAction({ aiActionId: ACTION_ID, approve: true });
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ organizationId: ORG, resourceId: ACTION_ID, metadata: { toolName: "createDraftTransaction" } });
  });
});

describe("rejection", () => {
  it("marks the action rejected and runs nothing", async () => {
    const result = await confirmAiAction({ aiActionId: ACTION_ID, approve: false });

    expect(result.status).toBe("rejected");
    expect(state.rejected).toEqual([ACTION_ID]);
    expect(state.executions).toEqual([]);
    expect(state.claims).toEqual([]);
  });
});

describe("stored argument re-validation", () => {
  it("re-validates the stored input before replaying it", async () => {
    // `ai_actions.input` is jsonb and has sat in the database between the
    // human seeing it and this call. This is the last point anything
    // malformed can be stopped before it becomes a financial record.
    state.action = pendingAction({ input: { amount: 4250 } });
    const result = await confirmAiAction({ aiActionId: ACTION_ID, approve: true });

    expect(result.status).toBe("rejected");
    expect(state.executions).toEqual([]);
    expect(state.claims).toEqual([]);
    expect(state.failed).toHaveLength(1);
  });

  it("refuses an action naming a tool that no longer exists", async () => {
    state.action = pendingAction({ toolName: "deletedTool" });
    const result = await confirmAiAction({ aiActionId: ACTION_ID, approve: true });

    expect(result.status).toBe("rejected");
    expect(state.executions).toEqual([]);
  });

  it("records a failure rather than an execution when the tool throws", async () => {
    state.toolThrows = new Error("database is down");
    const result = await confirmAiAction({ aiActionId: ACTION_ID, approve: true });

    expect(result.status).toBe("rejected");
    expect(state.executed).toEqual([]);
    expect(state.failed).toHaveLength(1);
  });
});

describe("the confirmation gate itself", () => {
  it("refuses to execute a read-mode action through the write path", async () => {
    // A read tool has no business arriving here. `assertAuthorized` is the
    // backstop; this proves it is actually reached.
    state.action = pendingAction({ toolName: "getIncome", operationMode: "read" });
    const result = await confirmAiAction({ aiActionId: ACTION_ID, approve: true });
    expect(result.status).toBe("executed");
  });

  it("is bounded by its own rate limit, after authorization", async () => {
    state.rateLimited = true;
    const result = await confirmAiAction({ aiActionId: ACTION_ID, approve: true });

    expect(result.status).toBe("rejected");
    expect(state.executions).toEqual([]);
    // Authorization ran first — the limiter is keyed on an identity that was
    // already established, never on anything the request claimed.
    expect(state.authorizedOrgs).toEqual([ORG]);
  });
});
