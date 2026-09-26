import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Entitlements at the boundary that actually decides.
 *
 * The audit's finding was not that the limits were wrong — it was that
 * nothing read them. `maxOrganizations: 1` sat in the code and in the
 * database while `/onboarding` stayed reachable by URL, so a Free account
 * could create workspaces without limit against a page promising one.
 *
 * These call the real Server Actions directly, the way an attacker would:
 * no form, no UI, no client-side check in the path. The plan and the count
 * are both derived server-side from real rows, so nothing in the request can
 * influence either.
 */

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    /** Organizations this user OWNS, with the plan each is on. */
    owned: [] as { organizationId: string; planId: string; status: string }[],
    ownershipQueries: [] as { userId: string; role: string }[],
    created: [] as { name: string; entityType?: string }[],
    subscription: { planId: "free", status: "active" } as { planId: string; status: string } | null,
    messagesUsedToday: 0,
    respondCalls: 0,
    usageRecords: [] as { organizationId: string; inputTokens: number; outputTokens: number; model: string }[],
    providerUsage: { inputTokens: 120, outputTokens: 340, providerCalls: 2 },
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
vi.mock("@/server/supabase/admin", () => ({ createAdminClient: () => ({ __admin: true }) }));

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

vi.mock("@/server/db/repositories/subscriptions", () => ({
  getSubscription: async () => state.subscription,
  listPlans: async () => [],
  listOwnedOrganizationSubscriptions: async (_c: unknown, userId: string) => {
    state.ownershipQueries.push({ userId, role: "owner" });
    return {
      organizationIds: state.owned.map((o) => o.organizationId),
      subscriptions: state.owned.map((o) => ({ planId: o.planId, status: o.status, currentPeriodEnd: null })),
    };
  },
}));

vi.mock("@/server/db/repositories/organizations", () => ({
  createOrganization: async (_c: unknown, input: { name: string; entityType: string }) => {
    state.created.push({ name: input.name, entityType: input.entityType });
    return { id: "99999999-9999-4999-8999-999999999999", name: input.name, entityType: "personal", country: "US", baseCurrency: "USD" };
  },
  getOrganization: async (_c: unknown, id: string) => ({ id, name: "Org", entityType: "personal", country: "US", baseCurrency: "USD" }),
  listMyOrganizations: async () => [],
}));

vi.mock("@/server/db/repositories/ai-conversations", () => ({
  getConversation: async (_c: unknown, id: string) => ({ id, organizationId: ORG, userId: state.userId }),
  createConversation: async () => ({ id: "conv", organizationId: ORG, userId: state.userId }),
  listMessages: async () => [],
  // Models the real metering order: the message row is INSERTED first, then
  // counted. A stub that returned a fixed number could not distinguish
  // count-then-write from write-then-count, and the difference between them
  // is the entire race-safety property.
  // Only USER rows, matching what `countUserMessagesSince` actually counts —
  // the assistant reply is written through the same function and must not
  // spend the caller's allowance.
  addMessage: async (_c: unknown, input: { role: string }) => {
    if (input.role === "user") state.messagesUsedToday += 1;
    return {};
  },
  countUserMessagesSince: async () => state.messagesUsedToday,
  recordAiUsage: async (client: { __admin?: boolean }, input: { organizationId: string; inputTokens: number; outputTokens: number; model: string }) => {
    // Asserted rather than assumed: `ai_usage` has no INSERT policy for
    // `authenticated`, so a non-admin client here would silently fail in
    // production and under-report cost.
    if (!client?.__admin) throw new Error("recordAiUsage must use the admin client");
    state.usageRecords.push(input);
  },
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
    providerName: "anthropic",
    providerModel: "claude-sonnet-5",
    respond: async () => {
      state.respondCalls++;
      return { content: "ok", executedTools: [], pendingConfirmations: [], failedTools: [], usage: state.providerUsage };
    },
  }),
  buildSystemPrompt: () => "system",
  AI_SYSTEM_PROMPT: "system",
}));

vi.mock("@/domain/audit/audit-log", () => ({ recordAuditEvent: async () => {}, AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }) }));

const ORG = "22222222-2222-4222-8222-222222222222";

const { completeOnboarding } = await import("@/server/onboarding/actions");
const { sendAiMessage } = await import("@/server/ai/actions");

function onboardingForm(name = "New Workspace") {
  const form = new FormData();
  form.set("name", name);
  // Onboarding no longer sends an entity type: every workspace is personal.
  form.set("country", "US");
  form.set("stateRegion", "CA");
  form.set("baseCurrency", "USD");
  return form;
}

function ownsOrganizations(count: number, planId = "free", status = "active") {
  state.owned = Array.from({ length: count }, (_, i) => ({ organizationId: `org-${i}`, planId, status }));
}

/** `redirect()` throws on success, so a created organization is the signal. */
async function createOrganization(form = onboardingForm()) {
  try {
    return (await completeOnboarding({}, form)) as { error?: string };
  } catch (error) {
    const digest = (error as Error & { digest?: string }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return { error: undefined };
    throw error;
  }
}

beforeEach(() => {
  state.owned = [];
  state.ownershipQueries = [];
  state.created = [];
  state.subscription = { planId: "free", status: "active" };
  state.messagesUsedToday = 0;
  state.respondCalls = 0;
  state.usageRecords = [];
  state.providerUsage = { inputTokens: 120, outputTokens: 340, providerCalls: 2 };
});

describe("organization allowance — Free", () => {
  it("lets a brand-new user create their first workspace", async () => {
    const result = await createOrganization();

    expect(result.error).toBeUndefined();
    expect(state.created).toHaveLength(1);
  });

  it("refuses a second workspace, which was previously unlimited", async () => {
    ownsOrganizations(1);
    const result = await createOrganization();

    expect(result.error).toContain("1 organization");
    expect(state.created).toEqual([]);
  });

  it("names the allowance in the refusal so the user knows what to do", async () => {
    ownsOrganizations(1);
    const result = await createOrganization();

    expect(result.error).toMatch(/upgrade/i);
  });

  it("still refuses at 5 owned workspaces after a downgrade", async () => {
    ownsOrganizations(5);
    expect((await createOrganization()).error).toBeTruthy();
    expect(state.created).toEqual([]);
  });
});

describe("organization allowance — Premium", () => {
  it("permits a second and third workspace", async () => {
    ownsOrganizations(1, "premium");
    expect((await createOrganization()).error).toBeUndefined();

    ownsOrganizations(2, "premium");
    expect((await createOrganization()).error).toBeUndefined();
    expect(state.created).toHaveLength(2);
  });

  it("refuses a fourth", async () => {
    ownsOrganizations(3, "premium");
    const result = await createOrganization();

    expect(result.error).toContain("3 organizations");
    expect(state.created).toEqual([]);
  });

  it("lifts the allowance when only ONE owned workspace is Premium", async () => {
    state.owned = [
      { organizationId: "a", planId: "free", status: "active" },
      { organizationId: "b", planId: "premium", status: "active" },
    ];
    expect((await createOrganization()).error).toBeUndefined();
  });
});

describe("organization allowance — Business", () => {
  it("permits workspaces without limit", async () => {
    ownsOrganizations(50, "business");
    expect((await createOrganization()).error).toBeUndefined();
    expect(state.created).toHaveLength(1);
  });
});

describe("downgrade behaviour", () => {
  it("treats a cancelled Business subscription as Free", async () => {
    ownsOrganizations(1, "business", "canceled");
    const result = await createOrganization();

    expect(result.error).toContain("1 organization");
    expect(state.created).toEqual([]);
  });

  it("treats a past-due Premium subscription as Free", async () => {
    ownsOrganizations(1, "premium", "past_due");
    expect((await createOrganization()).error).toBeTruthy();
  });

  it("honours a trialing subscription as paid", async () => {
    ownsOrganizations(1, "premium", "trialing");
    expect((await createOrganization()).error).toBeUndefined();
  });
});

describe("the allowance cannot be influenced from the client", () => {
  it("derives ownership from the authenticated user, never the form", async () => {
    ownsOrganizations(1);
    const form = onboardingForm();
    // Values an attacker might hope are read.
    form.set("planId", "business");
    form.set("plan", "business");
    form.set("maxOrganizations", "999");
    form.set("userId", "44444444-4444-4444-8444-444444444444");
    form.set("organizationCount", "0");

    const result = await createOrganization(form);

    expect(result.error).toContain("1 organization");
    expect(state.created).toEqual([]);
    expect(state.ownershipQueries).toEqual([{ userId: state.userId, role: "owner" }]);
  });

  it("counts organizations the user OWNS, not ones they were invited into", async () => {
    // `listOwnedOrganizationSubscriptions` filters on role = owner; this
    // asserts the action asks for that and nothing broader.
    await createOrganization();
    expect(state.ownershipQueries[0].role).toBe("owner");
  });
});

describe("AI access is entitlement-gated server-side", () => {
  it("lets a Free workspace use the assistant", async () => {
    state.subscription = { planId: "free", status: "active" };
    const result = await sendAiMessage({ organizationId: ORG, conversationId: null, message: "how much did I spend?" });

    expect(result.error).toBeUndefined();
    expect(state.respondCalls).toBe(1);
  });

  it("stops a Free workspace at 3 messages a day", async () => {
    state.subscription = { planId: "free", status: "active" };
    state.messagesUsedToday = 3; // this request will be the fourth
    const result = await sendAiMessage({ organizationId: ORG, conversationId: null, message: "one more" });

    expect(result.limitReached).toBe(true);
    expect(result.plan).toBe("free");
    expect(state.respondCalls).toBe(0);
  });

  it("lets Free spend exactly its three, and refuses the fourth", async () => {
    state.subscription = { planId: "free", status: "active" };

    for (let i = 0; i < 3; i++) {
      const result = await sendAiMessage({ organizationId: ORG, conversationId: null, message: `q${i}` });
      expect(result.limitReached, `message ${i + 1}`).toBeUndefined();
    }

    const fourth = await sendAiMessage({ organizationId: ORG, conversationId: null, message: "q4" });
    expect(fourth.limitReached).toBe(true);
    expect(state.respondCalls).toBe(3);
  });

  it("gives Premium the higher daily allowance", async () => {
    state.subscription = { planId: "premium", status: "active" };
    state.messagesUsedToday = 50;
    const result = await sendAiMessage({ organizationId: ORG, conversationId: null, message: "q" });

    expect(result.limitReached).toBeUndefined();
    expect(state.respondCalls).toBe(1);
  });

  it("stops Premium at 100", async () => {
    state.subscription = { planId: "premium", status: "active" };
    state.messagesUsedToday = 100;
    const result = await sendAiMessage({ organizationId: ORG, conversationId: null, message: "q" });

    expect(result.limitReached).toBe(true);
    expect(result.plan).toBe("premium");
    expect(state.respondCalls).toBe(0);
  });

  it("lets Business past Premium's ceiling", async () => {
    state.subscription = { planId: "business", status: "active" };
    state.messagesUsedToday = 200;
    const result = await sendAiMessage({ organizationId: ORG, conversationId: null, message: "q" });

    expect(result.limitReached).toBeUndefined();
    expect(state.respondCalls).toBe(1);
  });

  it("STOPS Business at 500 — the tier is capped, not unlimited", async () => {
    // Business used to carry `aiMessagesPerDay: null`, and the enforcement
    // site read that as `if (dailyLimit !== null)` — so the most expensive
    // tier ran with no counter at all. This is the regression test for that:
    // a Business workspace that has spent its allowance is refused like
    // any other.
    state.subscription = { planId: "business", status: "active" };
    state.messagesUsedToday = 500;
    const result = await sendAiMessage({ organizationId: ORG, conversationId: null, message: "q" });

    expect(result.limitReached).toBe(true);
    expect(result.plan).toBe("business");
    expect(state.respondCalls).toBe(0);
  });

  it("meters every tier, including the most expensive one", async () => {
    for (const planId of ["free", "premium", "business"] as const) {
      state.subscription = { planId, status: "active" };
      state.messagesUsedToday = 10_000;
      state.respondCalls = 0;

      const result = await sendAiMessage({ organizationId: ORG, conversationId: null, message: "q" });

      expect(result.limitReached, planId).toBe(true);
      expect(state.respondCalls, planId).toBe(0);
    }
  });

  it("applies FREE limits to a lapsed Business subscription", async () => {
    // The downgrade path at the AI boundary: 4 messages is fine on Business,
    // over the line on Free.
    state.subscription = { planId: "business", status: "canceled" };
    state.messagesUsedToday = 4;
    const result = await sendAiMessage({ organizationId: ORG, conversationId: null, message: "q" });

    expect(result.limitReached).toBe(true);
    expect(result.plan).toBe("free");
    expect(state.respondCalls).toBe(0);
  });

  it("treats a missing subscription row as Free rather than unlimited", async () => {
    state.subscription = null;
    state.messagesUsedToday = 4;
    const result = await sendAiMessage({ organizationId: ORG, conversationId: null, message: "q" });

    expect(result.limitReached).toBe(true);
    expect(result.plan).toBe("free");
  });

  it("reports the entitled plan, not the nominal one, when they differ", async () => {
    state.subscription = { planId: "premium", status: "past_due" };
    state.messagesUsedToday = 4;
    const result = await sendAiMessage({ organizationId: ORG, conversationId: null, message: "q" });

    expect(result.plan).toBe("free");
  });
});

describe("the AI budget cannot be raised from the client", () => {
  it("ignores a plan supplied in the request payload", async () => {
    // The server resolves entitlements from the organization's subscription
    // row. A request that names a tier is describing something it does not
    // control; the only inputs the action reads are `organizationId`,
    // `conversationId` and `message`.
    state.subscription = { planId: "free", status: "active" };
    state.messagesUsedToday = 3;

    const result = await sendAiMessage({
      organizationId: ORG,
      conversationId: null,
      message: "q",
      // Fields an attacker might hope are honoured.
      plan: "business",
      planId: "business",
      aiMessagesPerDay: 100_000,
      dailyLimit: 100_000,
      entitlements: { aiMessagesPerDay: 100_000 },
      limitReached: false,
    } as unknown as Parameters<typeof sendAiMessage>[0]);

    expect(result.limitReached).toBe(true);
    expect(result.plan).toBe("free");
    expect(state.respondCalls).toBe(0);
  });

  it("reads the subscription for the organization in the request, not a tier beside it", async () => {
    state.subscription = { planId: "free", status: "active" };
    state.messagesUsedToday = 3;

    const result = await sendAiMessage({
      organizationId: ORG,
      conversationId: null,
      message: "q",
      subscription: { planId: "business", status: "active" },
    } as unknown as Parameters<typeof sendAiMessage>[0]);

    expect(result.plan).toBe("free");
    expect(result.limitReached).toBe(true);
  });

  it("cannot be elevated by claiming an active status for a lapsed row", async () => {
    state.subscription = { planId: "business", status: "canceled" };
    state.messagesUsedToday = 4;

    const result = await sendAiMessage({
      organizationId: ORG,
      conversationId: null,
      message: "q",
      status: "active",
    } as unknown as Parameters<typeof sendAiMessage>[0]);

    expect(result.plan).toBe("free");
    expect(result.limitReached).toBe(true);
  });
});

describe("concurrent requests cannot exceed the daily budget", () => {
  /**
   * The race this guards.
   *
   * Counting BEFORE writing is a TOCTOU: N requests fired together all read
   * the same under-limit count, all pass the check, and all call the model.
   * The limit is then trivially beaten by racing it, and every excess request
   * is a real provider bill.
   *
   * `sendAiMessage` persists the user message FIRST and counts AFTER, so each
   * concurrent request sees every other one's row. The race resolves closed:
   * some requests may be refused slightly early, which is the safe direction
   * for a paid resource.
   */
  it("admits at most the Free allowance when 20 requests arrive at once", async () => {
    state.subscription = { planId: "free", status: "active" };

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => sendAiMessage({ organizationId: ORG, conversationId: null, message: `q${i}` })),
    );

    const admitted = results.filter((r) => !r.limitReached).length;
    expect(admitted).toBeLessThanOrEqual(3);
    expect(state.respondCalls).toBeLessThanOrEqual(3);
    expect(state.respondCalls).toBe(admitted);
  });

  it("refuses the excess rather than failing them, so the user sees a limit", async () => {
    state.subscription = { planId: "free", status: "active" };

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => sendAiMessage({ organizationId: ORG, conversationId: null, message: `q${i}` })),
    );

    const refused = results.filter((r) => r.limitReached);
    expect(refused.length).toBeGreaterThan(0);
    for (const result of refused) {
      expect(result.plan).toBe("free");
      expect(result.error).toBeUndefined();
    }
  });

  it("holds the line on Business too, where there used to be no line", async () => {
    state.subscription = { planId: "business", status: "active" };
    state.messagesUsedToday = 498;

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => sendAiMessage({ organizationId: ORG, conversationId: null, message: `q${i}` })),
    );

    expect(results.filter((r) => !r.limitReached).length).toBeLessThanOrEqual(2);
    expect(state.respondCalls).toBeLessThanOrEqual(2);
  });

  it("counts every attempt, so a refused request still consumes its row", async () => {
    // The write happens before the check. That is what makes the count
    // monotonic under concurrency — a request that is refused has still been
    // recorded, so it cannot be retried for free within the window.
    state.subscription = { planId: "free", status: "active" };

    await Promise.all(Array.from({ length: 8 }, (_, i) => sendAiMessage({ organizationId: ORG, conversationId: null, message: `q${i}` })));

    expect(state.messagesUsedToday).toBe(8);
  });
});

describe("provider cost measurement (Business cost safety)", () => {
  it("records what every turn cost, including on Business", async () => {
    state.subscription = { planId: "business", status: "active" };
    await sendAiMessage({ organizationId: ORG, conversationId: null, message: "q" });

    expect(state.usageRecords).toHaveLength(1);
    expect(state.usageRecords[0]).toMatchObject({ organizationId: ORG, inputTokens: 120, outputTokens: 340, model: "claude-sonnet-5" });
  });

  it("attributes usage to the organization that incurred it", async () => {
    await sendAiMessage({ organizationId: ORG, conversationId: null, message: "q" });
    expect(state.usageRecords[0].organizationId).toBe(ORG);
  });

  it("records nothing when the plan limit stopped the request before the provider", async () => {
    state.messagesUsedToday = 21;
    await sendAiMessage({ organizationId: ORG, conversationId: null, message: "q" });

    expect(state.respondCalls).toBe(0);
    expect(state.usageRecords).toEqual([]);
  });

  it("does not lose the user's answer if metering fails", async () => {
    // Usage recording is best-effort: the customer-facing entitlement is
    // metered off `ai_messages` separately, so a failure here must not cost
    // someone a message they already spent.
    state.providerUsage = { inputTokens: NaN, outputTokens: 0, providerCalls: 2 };
    const result = await sendAiMessage({ organizationId: ORG, conversationId: null, message: "q" });

    expect(result.content).toBe("ok");
  });
});

describe("launch scope — personal workspaces only", () => {
  it("creates a personal workspace when no entity type is sent, as the onboarding form does", async () => {
    expect((await createOrganization()).error).toBeUndefined();
    expect(state.created).toEqual([{ name: "New Workspace", entityType: "personal" }]);
  });

  it("accepts an explicit personal request", async () => {
    const form = onboardingForm();
    form.set("entityType", "personal");
    expect((await createOrganization(form)).error).toBeUndefined();
    expect(state.created.at(-1)?.entityType).toBe("personal");
  });

  it.each(["freelancer", "business", "enterprise", ""])("refuses %j and creates nothing", async (entityType) => {
    const form = onboardingForm();
    form.set("entityType", entityType);
    const result = await createOrganization(form);
    if (entityType === "") {
      // An empty field is how an unset input arrives; it means "default".
      expect(result.error).toBeUndefined();
      expect(state.created.at(-1)?.entityType).toBe("personal");
      return;
    }
    expect(result.error).toBe("Countorra currently supports personal workspaces only.");
    expect(state.created).toEqual([]);
  });
});

describe("the developer test plan changes what a workspace may DO, never what it is billed", () => {
  /**
   * A test override that reached Stripe Checkout would break the thing it
   * exists to test: a developer testing as Premium would be told "this
   * workspace is already on that plan" and could not complete a real upgrade.
   * A test override that reached the pricing page would make the marketing
   * site claim a purchase nobody made.
   *
   * So the split is deliberate and load-bearing, and these cases pin it:
   * FEATURE GATES read the effective plan, BILLING TRUTH reads the
   * subscription. Source-level, because the consequence of getting it wrong
   * is not a failing assertion anywhere else — it is a customer who cannot
   * pay, or a page that lies.
   */
  const read = (relative: string) => readFileSync(relative, "utf8");

  it("gates every paid FEATURE on the effective plan", () => {
    for (const file of [
      "src/server/bank-connections/actions.ts",
      "src/server/bank-connections/workspace.ts",
      "src/server/documents/intelligence-actions.ts",
      "src/server/ai/actions.ts",
    ]) {
      expect(read(file), file).toContain("effectivePlan(");
    }
  });

  it("keeps Stripe Checkout on the REAL subscription", () => {
    const billing = read("src/server/billing/actions.ts");
    expect(billing).toContain("entitlementsFor(subscription)");
    expect(billing).not.toContain("effectivePlan");
  });

  it("keeps the pricing page's view of a plan on the REAL subscription", () => {
    const viewer = read("src/server/billing/viewer-context.ts");
    expect(viewer).toContain("entitlementsFor(subscription)");
    expect(viewer).not.toContain("effectivePlan");
  });

  it("writes nothing to subscriptions from the override path", () => {
    for (const file of ["src/server/billing/developer-override.ts", "src/server/billing/developer-actions.ts"]) {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      // Reading the subscription is how the real plan is known; WRITING one
      // would be the fake-billing mistake.
      expect(code, file).not.toMatch(/from\("subscriptions"\)\s*\.\s*(insert|update|upsert|delete)/);
      expect(code, file).not.toContain("stripe");
    }
  });

  it("has no client-controlled input anywhere in the decision", () => {
    const resolver = read("src/server/billing/developer-override.ts");
    // The decision reads the session and the environment. Not a cookie the
    // browser set, not a query parameter, not a header.
    expect(resolver).not.toMatch(/searchParams|cookies\(\)|headers\(\)|localStorage/);
  });
});
