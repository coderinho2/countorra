import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Conversation memory at the Server Action boundary.
 *
 * `budgetHistory` is unit-tested in the domain, and AIService's wiring is
 * tested against a mock provider. What is asserted here is the part that
 * matters for isolation: WHICH transcript gets loaded.
 *
 * Sending history is the first feature in this product that reads a prior
 * conversation and feeds it to a model, so it is also the first place a
 * cross-user or cross-organization read would leak into somebody's answer.
 * The conversation is resolved and checked against both the caller's user id
 * and the request's organization before a single prior message is read.
 */

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    conversation: null as { id: string; organizationId: string; userId: string } | null,
    storedMessages: [] as { role: string; content: string }[],
    listMessagesCalls: [] as string[],
    addedMessages: [] as { role: string; content: string }[],
    respondCalls: [] as { message: string; history?: { role: string; content: string }[] }[],
    respondThrows: null as Error | null,
    messagesUsedToday: 0,
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
  requireOrgMembership: async (organizationId: string) => ({
    user: { id: state.userId },
    membership: { organizationId, userId: state.userId, role: "owner" },
  }),
}));

vi.mock("@/server/security/rate-limit", () => ({
  enforceRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0, message: "", degraded: false }),
  clientAddress: async () => "127.0.0.1",
  normalizeIdentifier: (v: string) => v,
}));

vi.mock("@/server/db/repositories/organizations", () => ({
  getOrganization: async (_c: unknown, id: string) => ({ id, name: "Org", entityType: "business", country: "US", baseCurrency: "USD" }),
  listMyOrganizations: async () => [],
}));

vi.mock("@/server/db/repositories/subscriptions", () => ({ getSubscription: async () => ({ planId: "free", status: "active" }) }));

vi.mock("@/server/db/repositories/ai-conversations", () => ({
  getConversation: async () => state.conversation,
  createConversation: async (_c: unknown, organizationId: string, userId: string) => {
    state.conversation = { id: "new-conversation", organizationId, userId };
    return state.conversation;
  },
  listMessages: async (_c: unknown, conversationId: string) => {
    state.listMessagesCalls.push(conversationId);
    return state.storedMessages.map((m, i) => ({ id: `m${i}`, conversationId, ...m, createdAt: "" }));
  },
  addMessage: async (_c: unknown, input: { role: string; content: string }) => {
    state.addedMessages.push({ role: input.role, content: input.content });
    return { id: "m", ...input };
  },
  countUserMessagesSince: async () => state.messagesUsedToday,
  createPendingAction: async () => ({ id: "a" }),
  listConversations: async () => [],
  claimActionForExecution: async () => true,
  markActionExecuted: async () => {},
  markActionFailed: async () => {},
  markActionRejected: async () => true,
  getAiAction: async () => null,
  deleteConversation: async () => true,
  renameConversation: async () => true,
}));

vi.mock("@/server/ai/service-factory", () => ({
  createAiService: () => ({
    respond: async (input: { message: string; history?: { role: string; content: string }[] }) => {
      state.respondCalls.push({ message: input.message, history: input.history });
      if (state.respondThrows) throw state.respondThrows;
      return { content: "an answer", executedTools: [], pendingConfirmations: [], failedTools: [] };
    },
  }),
  buildSystemPrompt: () => "system",
  AI_SYSTEM_PROMPT: "system",
}));

vi.mock("@/domain/audit/audit-log", () => ({ recordAuditEvent: async () => {}, AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }) }));

const { sendAiMessage } = await import("@/server/ai/actions");

const ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const OTHER_USER = "44444444-4444-4444-8444-444444444444";
const CONVERSATION = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  state.conversation = { id: CONVERSATION, organizationId: ORG, userId: state.userId };
  state.storedMessages = [
    { role: "user", content: "how much did I spend on software?" },
    { role: "assistant", content: "$400 last month." },
  ];
  state.listMessagesCalls = [];
  state.addedMessages = [];
  state.respondCalls = [];
  state.respondThrows = null;
  state.messagesUsedToday = 0;
});

describe("loading prior turns", () => {
  it("passes the conversation's history to the model", async () => {
    await sendAiMessage({ organizationId: ORG, conversationId: CONVERSATION, message: "and the month before?" });

    expect(state.respondCalls).toHaveLength(1);
    expect(state.respondCalls[0].history).toEqual([
      { role: "user", content: "how much did I spend on software?" },
      { role: "assistant", content: "$400 last month." },
    ]);
  });

  it("loads history from the resolved conversation, not a client-supplied id", async () => {
    await sendAiMessage({ organizationId: ORG, conversationId: CONVERSATION, message: "next" });
    expect(state.listMessagesCalls).toEqual([CONVERSATION]);
  });

  it("reads prior turns BEFORE persisting the current message", async () => {
    // Otherwise the question being asked would arrive as history too, and the
    // model would see it twice.
    await sendAiMessage({ organizationId: ORG, conversationId: CONVERSATION, message: "the new question" });

    const history = state.respondCalls[0].history ?? [];
    expect(JSON.stringify(history)).not.toContain("the new question");
    expect(state.addedMessages[0]).toMatchObject({ role: "user", content: "the new question" });
  });

  it("sends no history for a brand-new conversation", async () => {
    state.conversation = null;
    state.storedMessages = [];
    // `conversationId` is nullable, not optional: a new conversation is
    // signalled by an explicit null, not by omitting the field.
    await sendAiMessage({ organizationId: ORG, conversationId: null, message: "first ever question" });

    expect(state.respondCalls[0].history).toEqual([]);
  });

  it("drops non-user/assistant rows rather than sending them", async () => {
    state.storedMessages = [
      { role: "user", content: "q" },
      { role: "system", content: "internal note" },
      { role: "assistant", content: "a" },
    ];
    await sendAiMessage({ organizationId: ORG, conversationId: CONVERSATION, message: "next" });

    expect(JSON.stringify(state.respondCalls[0].history)).not.toContain("internal note");
  });

  it("forwards the transcript it loaded, leaving the budget to the service", async () => {
    // The budget lives in AIService (via `budgetHistory`) rather than here, so
    // every caller of the service inherits it rather than each having to
    // remember. This asserts the action's half of that contract; the trimming
    // itself is covered in src/domain/ai/conversation-history.test.ts and the
    // wiring in src/domain/ai/tool-isolation.test.ts.
    state.storedMessages = Array.from({ length: 200 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }));
    await sendAiMessage({ organizationId: ORG, conversationId: CONVERSATION, message: "next" });

    expect(state.respondCalls[0].history).toHaveLength(200);
  });
});

describe("isolation", () => {
  it("refuses a conversation belonging to another user, without reading it", async () => {
    state.conversation = { id: CONVERSATION, organizationId: ORG, userId: OTHER_USER };
    const result = await sendAiMessage({ organizationId: ORG, conversationId: CONVERSATION, message: "show me their history" });

    expect(result.error).toBe("Conversation not found.");
    expect(state.listMessagesCalls).toEqual([]);
    expect(state.respondCalls).toEqual([]);
  });

  it("refuses a conversation from another organization, without reading it", async () => {
    state.conversation = { id: CONVERSATION, organizationId: OTHER_ORG, userId: state.userId };
    const result = await sendAiMessage({ organizationId: ORG, conversationId: CONVERSATION, message: "cross-org" });

    expect(result.error).toBe("Conversation not found.");
    expect(state.listMessagesCalls).toEqual([]);
  });

  it("refuses a conversation that does not exist", async () => {
    state.conversation = null;
    const result = await sendAiMessage({ organizationId: ORG, conversationId: CONVERSATION, message: "?" });

    expect(result.error).toBe("Conversation not found.");
    expect(state.listMessagesCalls).toEqual([]);
  });

  it("does not persist a message into a conversation it refused", async () => {
    state.conversation = { id: CONVERSATION, organizationId: ORG, userId: OTHER_USER };
    await sendAiMessage({ organizationId: ORG, conversationId: CONVERSATION, message: "sneaky" });

    expect(state.addedMessages).toEqual([]);
  });
});

describe("cost and failure safety", () => {
  it("does not call the provider once the daily limit is reached", async () => {
    state.messagesUsedToday = 999;
    const result = await sendAiMessage({ organizationId: ORG, conversationId: CONVERSATION, message: "over limit" });

    expect(result.limitReached).toBe(true);
    expect(state.respondCalls).toEqual([]);
  });

  it("calls the provider exactly once per request, with no retry loop of its own", async () => {
    await sendAiMessage({ organizationId: ORG, conversationId: CONVERSATION, message: "q" });
    expect(state.respondCalls).toHaveLength(1);
  });

  it("does not retry after a provider failure", async () => {
    // Retries belong to the SDK, bounded by maxRetries. A retry here would
    // multiply that budget invisibly.
    state.respondThrows = new Error("upstream exploded");
    await sendAiMessage({ organizationId: ORG, conversationId: CONVERSATION, message: "q" });

    expect(state.respondCalls).toHaveLength(1);
  });

  it("shows a safe message, not the provider's, when the call fails", async () => {
    state.respondThrows = new Error("connect ECONNREFUSED 10.0.0.4:5432 password=hunter2");
    const result = await sendAiMessage({ organizationId: ORG, conversationId: CONVERSATION, message: "q" });

    expect(result.error).not.toContain("ECONNREFUSED");
    expect(result.error).not.toContain("hunter2");
    expect(result.error).toBeTruthy();
  });

  it("surfaces a classified provider failure, which is already safe and more useful", async () => {
    const { ProviderError } = await import("@/domain/ai/provider-errors");
    state.respondThrows = new ProviderError("rate_limited", "The assistant is handling a lot of requests right now. Please try again in a moment.");
    const result = await sendAiMessage({ organizationId: ORG, conversationId: CONVERSATION, message: "q" });

    expect(result.error).toContain("try again in a moment");
  });

  it("records the failure in the transcript without leaking internals into it", async () => {
    state.respondThrows = new Error("relation \"public.transactions\" does not exist");
    await sendAiMessage({ organizationId: ORG, conversationId: CONVERSATION, message: "q" });

    const assistantRows = state.addedMessages.filter((m) => m.role === "assistant");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0].content).not.toContain("relation");
  });
});
