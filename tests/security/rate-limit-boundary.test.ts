import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Rate limiting, exercised through the SAME boundary an attacker uses.
 *
 * These call the Server Actions directly — no UI, no form, no client
 * component — because that is the bypass that matters: an attacker does not
 * fill in the login form, they POST to the action. Everything below is
 * therefore a direct invocation, and the limiter has to hold anyway.
 *
 * The Postgres round trip is replaced with an in-test counter so bursts are
 * fast and deterministic, but *only* that: key derivation, the salted hash,
 * rule grouping, the per-rule failure modes and the ordering relative to
 * authentication, authorization, the plan entitlement and the provider call
 * are all the real implementation. `tests/rls/rate-limiting.test.ts` covers
 * the store itself against real Postgres.
 */

// `vi.hoisted` runs before the module graph is evaluated, which matters here:
// src/lib/env.ts validates the public environment at import time, so these
// must exist before anything imports it. None are real credentials.
const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    headers: new Headers(),
    authCalls: { signIn: 0, signUp: 0, reset: 0 },
    signInFails: true,
    providerCalls: { respond: 0 },
    persistence: { messagesAdded: 0 },
    membershipRole: "owner",
    authenticatedUserId: "user-1",
    authorizationRejects: false,
    planId: "free",
    messagesUsedToday: 0,
  };
});

// ── request context ──────────────────────────────────────────────────────
vi.mock("next/headers", () => ({
  headers: async () => state.headers,
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    const e = new Error(`NEXT_REDIRECT:${to}`);
    (e as Error & { digest?: string }).digest = `NEXT_REDIRECT;${to}`;
    throw e;
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// ── Supabase ─────────────────────────────────────────────────────────────
vi.mock("@/server/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      signInWithPassword: async () => {
        state.authCalls.signIn++;
        return state.signInFails ? { error: { message: "Invalid login credentials" } } : { error: null };
      },
      signUp: async () => {
        state.authCalls.signUp++;
        return { error: null };
      },
      resetPasswordForEmail: async () => {
        state.authCalls.reset++;
        return { error: null };
      },
    },
  }),
}));

vi.mock("@/server/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: new Error("unused") }) }) }));

// ── AI dependencies ──────────────────────────────────────────────────────
vi.mock("@/server/ai/service-factory", () => ({
  createAiService: () => ({
    respond: async () => {
      state.providerCalls.respond++;
      return { content: "ok", executedTools: [], pendingConfirmations: [] };
    },
  }),
  buildSystemPrompt: () => "system",
  AI_SYSTEM_PROMPT: "system",
}));

vi.mock("@/server/auth/session", () => ({
  requireUser: async () => ({ id: state.authenticatedUserId, email: "u@example.com" }),
  requireOrgMembership: async (organizationId: string) => {
    // Authorization runs first and can refuse. When it does, nothing
    // downstream should have executed — including the limiter.
    if (state.authorizationRejects) {
      const e = new Error("NEXT_REDIRECT:/login") as Error & { digest?: string };
      e.digest = "NEXT_REDIRECT;/login";
      throw e;
    }
    return {
      user: { id: state.authenticatedUserId, email: "u@example.com" },
      membership: { organizationId, userId: state.authenticatedUserId, role: state.membershipRole },
    };
  },
  getSession: async () => ({ id: state.authenticatedUserId }),
}));

vi.mock("@/server/db/repositories/subscriptions", () => ({
  getSubscription: async () => ({ planId: state.planId, status: "active", currentPeriodEnd: null }),
  listPlans: async () => [],
}));

vi.mock("@/server/db/repositories/transactions", () => ({
  listTransactions: async () => ({ transactions: [], total: 0, page: 1, pageSize: 8 }),
}));
vi.mock("@/server/db/repositories/invoices", () => ({ listInvoices: async () => ({ invoices: [], total: 0 }) }));
vi.mock("@/server/db/repositories/customers", () => ({ listCustomers: async () => [] }));
vi.mock("@/server/db/repositories/documents", () => ({ listDocuments: async () => [] }));

vi.mock("@/server/db/repositories/organizations", () => ({
  getOrganization: async (_c: unknown, id: string) => ({ id, name: "Org", entityType: "personal", country: "US", baseCurrency: "USD" }),
  listMyOrganizations: async () => [],
}));

vi.mock("@/server/db/repositories/ai-conversations", () => ({
  createConversation: async () => ({ id: "conv-new", organizationId: "org-a", userId: state.authenticatedUserId, title: null }),
  getConversation: async (_c: unknown, id: string) => ({ id, organizationId: "org-a", userId: state.authenticatedUserId, title: null }),
  addMessage: async (_c: unknown, input: { role: string }) => {
    if (input.role === "user") state.persistence.messagesAdded++;
    return { id: "m", conversationId: "c", role: input.role, content: "", createdAt: "" };
  },
  countUserMessagesSince: async () => state.messagesUsedToday,
  createPendingAction: async () => ({ id: "act", organizationId: "org-a" }),
  listConversations: async () => [],
  listMessages: async () => [],
  claimActionForExecution: async () => true,
  markActionExecuted: async () => {},
  markActionFailed: async () => {},
  markActionRejected: async () => true,
  getAiAction: async () => null,
  deleteConversation: async () => true,
  renameConversation: async () => true,
}));

vi.mock("@/domain/audit/audit-log", () => ({
  recordAuditEvent: async () => {},
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

// ── the in-test counter standing in for Postgres ─────────────────────────
import { __setRateLimitStoreForTests } from "@/server/security/rate-limit";
import { RATE_LIMITS, type RateLimitName } from "@/domain/security/rate-limit-policy";
import { signIn, signUp, requestPasswordReset } from "@/server/auth/actions";
import { sendAiMessage } from "@/server/ai/actions";
import { globalSearch } from "@/server/search/actions";

const counters = new Map<string, number>();
let storeAvailable = true;
/** Keys the store actually saw — proves what the limiter keyed on. */
const observedKeys: { rule: RateLimitName; keyHash: string }[] = [];

function installCountingStore() {
  __setRateLimitStoreForTests(async (rule, keyHash) => {
    if (!storeAvailable) return null;
    observedKeys.push({ rule, keyHash });
    const id = `${rule}:${keyHash}`;
    const next = (counters.get(id) ?? 0) + 1;
    counters.set(id, next);
    const spec = RATE_LIMITS[rule];
    return { allowed: next <= spec.limit, retryAfterSeconds: next <= spec.limit ? 0 : spec.windowSeconds };
  });
}

function setAddress(ip: string) {
  state.headers = new Headers({ "x-forwarded-for": ip });
}

async function expectRedirect(fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toThrow(/NEXT_REDIRECT/);
}

beforeEach(() => {
  counters.clear();
  observedKeys.length = 0;
  storeAvailable = true;
  state.authorizationRejects = false;
  state.signInFails = true;
  state.planId = "free";
  state.messagesUsedToday = 0;
  state.membershipRole = "owner";
  state.authenticatedUserId = "user-1";
  state.authCalls.signIn = 0;
  state.authCalls.signUp = 0;
  state.authCalls.reset = 0;
  state.providerCalls.respond = 0;
  state.persistence.messagesAdded = 0;
  setAddress("203.0.113.10");
  installCountingStore();
});

afterEach(() => {
  __setRateLimitStoreForTests(null);
});

function loginForm(email: string, password = "hunter2hunter2"): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  return fd;
}

// ══ AUTHENTICATION ═══════════════════════════════════════════════════════
describe("login", () => {
  it("blocks a burst against one account", async () => {
    const attempts = [];
    for (let i = 0; i < 7; i++) attempts.push(await signIn({}, loginForm("victim@example.com")));

    const blocked = attempts.filter((r) => /too many requests/i.test(r.error ?? ""));
    expect(blocked.length).toBeGreaterThan(0);
    // The per-identifier rule is 5/15min — the 6th attempt onward is refused.
    expect(attempts.slice(0, 5).every((r) => r.error === "Incorrect email or password.")).toBe(true);
  });

  it("stops calling Supabase Auth at all once the limit is hit", async () => {
    for (let i = 0; i < 10; i++) await signIn({}, loginForm("victim@example.com"));
    // 5 reached the credential check; the rest were refused before it. The
    // limiter is upstream of the expensive/attackable operation, not a
    // cosmetic wrapper around its result.
    expect(state.authCalls.signIn).toBe(5);
  });

  it("cannot be bypassed by rotating the source address", async () => {
    // Credential stuffing from a botnet: every request from a new address.
    const results = [];
    for (let i = 0; i < 8; i++) {
      setAddress(`198.51.100.${i}`);
      results.push(await signIn({}, loginForm("victim@example.com")));
    }
    expect(results.filter((r) => /too many requests/i.test(r.error ?? "")).length).toBeGreaterThan(0);
    expect(state.authCalls.signIn).toBe(5);
  });

  it("cannot be bypassed by rotating the account being attacked", async () => {
    // Password spraying: one host, one password, many accounts.
    const results = [];
    for (let i = 0; i < 14; i++) results.push(await signIn({}, loginForm(`target${i}@example.com`)));

    // The per-IP rule (10/5min) catches this even though every identifier
    // bucket is fresh.
    expect(results.filter((r) => /too many requests/i.test(r.error ?? "")).length).toBeGreaterThan(0);
    expect(state.authCalls.signIn).toBe(10);
  });

  it("treats an unknown address exactly like a real one — no existence oracle", async () => {
    const real: string[] = [];
    const fake: string[] = [];
    for (let i = 0; i < 7; i++) real.push((await signIn({}, loginForm("real@example.com"))).error ?? "");
    setAddress("203.0.113.11");
    state.signInFails = true;
    for (let i = 0; i < 7; i++) fake.push((await signIn({}, loginForm("nobody@example.com"))).error ?? "");

    // Identical sequence of responses, identical throttle point. Nothing in
    // the timing-independent output distinguishes a registered address.
    expect(fake).toEqual(real);
  });

  it("normalizes case and surrounding whitespace so one account is one bucket", async () => {
    const variants = ["victim@example.com", "VICTIM@example.com", "Victim@Example.com", "victim@EXAMPLE.com", "ViCtIm@example.com"];
    for (const v of variants) await signIn({}, loginForm(v));
    // Five attempts consumed the identifier budget despite five spellings.
    const sixth = await signIn({}, loginForm("victim@example.com"));
    expect(sixth.error).toMatch(/too many requests/i);
  });

  it("never puts a raw address in the store key", async () => {
    await signIn({}, loginForm("victim@example.com"));
    expect(observedKeys.length).toBeGreaterThan(0);
    for (const { keyHash } of observedKeys) {
      expect(keyHash).not.toContain("victim@example.com");
      expect(keyHash).not.toContain("203.0.113.10");
      expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("signup", () => {
  it("blocks automated account creation from one address", async () => {
    // A successful signup redirects, which throws — so outcomes are counted
    // rather than returned.
    let refused = 0;
    let accepted = 0;
    for (let i = 0; i < 8; i++) {
      const fd = new FormData();
      fd.set("email", `new${i}@example.com`);
      fd.set("password", "hunter2hunter2");
      fd.set("fullName", "New User");
      try {
        const r = await signUp({}, fd);
        if (/too many requests/i.test(r.error ?? "")) refused++;
      } catch (e) {
        if (/NEXT_REDIRECT/.test(String(e))) accepted++;
        else throw e;
      }
    }
    // 5/hour per address, and every identifier is different — so this is the
    // per-IP rule doing the work, which is exactly the account-farming case.
    expect(accepted).toBe(5);
    expect(refused).toBe(3);
    expect(state.authCalls.signUp).toBe(5);
  });
});

describe("password reset", () => {
  it("blocks flooding one address with reset mail", async () => {
    const results = [];
    for (let i = 0; i < 6; i++) {
      const fd = new FormData();
      fd.set("email", "victim@example.com");
      results.push(await requestPasswordReset({}, fd));
    }
    expect(state.authCalls.reset).toBe(3);
    expect(results.filter((r) => /too many requests/i.test(r.error ?? "")).length).toBe(3);
  });

  it("still returns the uniform success shape while under the limit", async () => {
    const fd = new FormData();
    fd.set("email", "whoever@example.com");
    const r = await requestPasswordReset({}, fd);
    expect(r).toEqual({ success: true });
  });
});

// ══ AI ═══════════════════════════════════════════════════════════════════
describe("AI message", () => {
  const message = { organizationId: "00000000-0000-4000-8000-0000000000aa", conversationId: null, message: "how much did I spend?" };

  it("blocks a burst before the provider is ever called", async () => {
    const results = [];
    for (let i = 0; i < 9; i++) results.push(await sendAiMessage(message));

    // 5/min per user.
    expect(state.providerCalls.respond).toBe(5);
    expect(results.filter((r) => /too many requests/i.test(r.error ?? "")).length).toBe(4);
  });

  it("does not even persist the user's message once limited", async () => {
    for (let i = 0; i < 9; i++) await sendAiMessage(message);
    // Persisting first would let a burst flood ai_messages and inflate the
    // organization's own daily usage counter.
    expect(state.persistence.messagesAdded).toBe(5);
  });

  it("cannot be bypassed by changing the organization id", async () => {
    for (let i = 0; i < 5; i++) await sendAiMessage(message);
    const other = await sendAiMessage({ ...message, organizationId: "00000000-0000-4000-8000-0000000000bb" });
    // The per-user rule is keyed on the authenticated session, not on
    // anything in the payload.
    expect(other.error).toMatch(/too many requests/i);
    expect(state.providerCalls.respond).toBe(5);
  });

  it("cannot be bypassed by changing the conversation id", async () => {
    for (let i = 0; i < 5; i++) await sendAiMessage({ ...message, conversationId: `00000000-0000-4000-8000-00000000000${i}` });
    const next = await sendAiMessage({ ...message, conversationId: "00000000-0000-4000-8000-0000000000ff" });
    expect(next.error).toMatch(/too many requests/i);
  });

  it("cannot be bypassed by changing request headers", async () => {
    for (let i = 0; i < 5; i++) {
      setAddress(`198.51.100.${i}`);
      await sendAiMessage(message);
    }
    setAddress("198.51.100.200");
    state.headers.set("x-real-ip", "10.0.0.1");
    state.headers.set("user-agent", "something-else");
    const next = await sendAiMessage(message);
    expect(next.error).toMatch(/too many requests/i);
    expect(state.providerCalls.respond).toBe(5);
  });

  it("cannot be bypassed by a different tab or session for the same account", async () => {
    // Separate invocations with independent header sets — the only thing
    // they share is the authenticated user, which is the point.
    for (let i = 0; i < 5; i++) {
      state.headers = new Headers({ "x-forwarded-for": "203.0.113.10", cookie: `session=tab-${i}` });
      await sendAiMessage(message);
    }
    state.headers = new Headers({ "x-forwarded-for": "203.0.113.10", cookie: "session=tab-99" });
    expect((await sendAiMessage(message)).error).toMatch(/too many requests/i);
  });

  it("counts a concurrent burst atomically — no request slips through on a stale read", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => sendAiMessage(message)));
    expect(results.filter((r) => !r.error).length).toBe(5);
    expect(state.providerCalls.respond).toBe(5);
  });

  it("bounds a whole organization, not just one account", async () => {
    // Six accounts, each well under the per-user limit, all in one org.
    let allowed = 0;
    for (let u = 0; u < 12; u++) {
      state.authenticatedUserId = `user-${u}`;
      for (let i = 0; i < 3; i++) {
        const r = await sendAiMessage(message);
        if (!r.error) allowed++;
      }
    }
    // The per-org rule (30/min) caps the tenant regardless of how the
    // traffic is split across accounts.
    expect(allowed).toBe(30);
  });

  it("leaves the plan entitlement in force as a separate control", async () => {
    // 21, not 20: metering counts AFTER persisting the current message (the
    // fix for the usage-limit race), so the count includes this request.
    state.messagesUsedToday = 21;
    const r = await sendAiMessage(message);
    expect(r.limitReached).toBe(true);
    expect(r.plan).toBe("free");
    expect(state.providerCalls.respond).toBe(0);
  });

  it("still honours the premium entitlement independently of rate limiting", async () => {
    state.planId = "premium";
    state.messagesUsedToday = 301;
    const r = await sendAiMessage(message);
    expect(r.limitReached).toBe(true);
    expect(r.plan).toBe("premium");

    state.messagesUsedToday = 10;
    const ok = await sendAiMessage(message);
    expect(ok.limitReached).toBeUndefined();
    expect(ok.error).toBeUndefined();
  });

  it("does not leak which limit fired, or any identifier, in the error", async () => {
    for (let i = 0; i < 6; i++) await sendAiMessage(message);
    const blocked = await sendAiMessage(message);
    expect(blocked.error).toMatch(/^Too many requests\./);
    expect(blocked.error).not.toMatch(/user-1|00000000-0000-4000|ai:message|203\.0\.113/);
  });
});

// ══ FAILURE MODES ════════════════════════════════════════════════════════
describe("when the rate-limit store is unavailable", () => {
  it("authentication fails closed", async () => {
    storeAvailable = false;
    const r = await signIn({}, loginForm("victim@example.com"));
    expect(r.error).toMatch(/temporarily unavailable/i);
    // Critically: the credential check never ran, so an attacker cannot take
    // the limiter down and then brute force freely.
    expect(state.authCalls.signIn).toBe(0);
  });

  it("AI fails closed, so a store outage is not a free pass to the provider", async () => {
    storeAvailable = false;
    const r = await sendAiMessage({ organizationId: "00000000-0000-4000-8000-0000000000aa", conversationId: null, message: "hi" });
    expect(r.error).toMatch(/temporarily unavailable/i);
    expect(state.providerCalls.respond).toBe(0);
  });

  it("signup and password reset fail closed too", async () => {
    storeAvailable = false;
    const fd = new FormData();
    fd.set("email", "new@example.com");
    fd.set("password", "hunter2hunter2");
    fd.set("fullName", "New");
    expect((await signUp({}, fd)).error).toMatch(/temporarily unavailable/i);
    expect(state.authCalls.signUp).toBe(0);

    const rd = new FormData();
    rd.set("email", "new@example.com");
    expect((await requestPasswordReset({}, rd)).error).toMatch(/temporarily unavailable/i);
    expect(state.authCalls.reset).toBe(0);
  });

  it("never silently bypasses a protected operation", async () => {
    // Every fail-closed category refuses rather than proceeding unbounded.
    storeAvailable = false;
    const outcomes = await Promise.all([
      signIn({}, loginForm("a@example.com")),
      sendAiMessage({ organizationId: "00000000-0000-4000-8000-0000000000aa", conversationId: null, message: "hi" }),
    ]);
    expect(outcomes.every((o) => Boolean(o.error))).toBe(true);
  });
});

// ══ AUTHORIZATION IS INDEPENDENT ═════════════════════════════════════════
describe("rate limiting does not replace authorization", () => {
  it("a search still runs its own authorization, and the limiter is downstream of it", async () => {
    const results = [];
    for (let i = 0; i < 65; i++) results.push(await globalSearch("00000000-0000-4000-8000-0000000000aa", "coffee"));
    // 60/min per user; the surplus returns empty rather than erroring.
    expect(results.length).toBe(65);
    expect(results.every((r) => Array.isArray(r.transactions))).toBe(true);
  });

  it("keeps the limiter strictly after authorization, so an unauthorized caller is refused first", async () => {
    state.authorizationRejects = true;
    await expectRedirect(() => sendAiMessage({ organizationId: "00000000-0000-4000-8000-0000000000aa", conversationId: null, message: "hi" }));
    // No budget was consumed. An attacker therefore cannot burn a victim
    // organization's AI allowance without being a member of it first.
    expect(observedKeys).toHaveLength(0);
  });
});
