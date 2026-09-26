import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE DEVELOPER TEST PLAN — who it works for, and what it changes.
 *
 * The database half (that no browser role can write the table) is proven
 * against real Postgres in tests/rls/developer-plan-override.test.ts. This
 * file is the application half: the allowlist rule, and what the effective
 * plan resolves to for each combination of session, configuration and row.
 *
 * The case that matters most is the one where a row EXISTS and the session is
 * not a developer. A mechanism that trusted the row alone would be a stored
 * privilege escalation: write one once, keep it forever. The allowlist is
 * therefore re-checked on every read, so removing an address revokes every
 * override it ever set, everywhere, with no cleanup.
 */

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  return {
    developerAccounts: undefined as string | undefined,
    envThrows: false,
    subscription: null as { planId: string; status: string } | null,
    override: null as string | null,
    overrideReadFails: false,
  };
});

vi.mock("server-only", () => ({}));

vi.mock("@/lib/server-env", () => ({
  serverEnv: () => {
    if (state.envThrows) throw new Error("half-configured environment");
    return { DEVELOPER_ACCOUNTS: state.developerAccounts };
  },
}));

vi.mock("@/server/db/repositories/subscriptions", () => ({
  getSubscription: async () => state.subscription,
}));

const client = {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => (state.overrideReadFails ? { data: null, error: new Error("relation does not exist") } : { data: state.override ? { plan_id: state.override } : null, error: null }),
      }),
    }),
  }),
} as never;

const { effectivePlan, isDeveloperSession, readPlanOverride } = await import("@/server/billing/developer-override");
const { developerAccounts, isDeveloperAccount, planLabelWithSource, isDeveloperPlanTier } = await import("@/domain/billing/developer-override");

const DEVELOPER = { email: "dev@example.test", email_confirmed_at: "2026-01-01T00:00:00.000Z" };
const ORDINARY = { email: "someone@example.test", email_confirmed_at: "2026-01-01T00:00:00.000Z" };

beforeEach(() => {
  state.developerAccounts = "dev@example.test";
  state.envThrows = false;
  state.subscription = { planId: "free", status: "active" };
  state.override = null;
  state.overrideReadFails = false;
});

describe("parsing the allowlist", () => {
  it("is empty when nothing is configured, which is every deployment by default", () => {
    expect(developerAccounts(undefined)).toEqual([]);
    expect(developerAccounts("")).toEqual([]);
    expect(developerAccounts("   ")).toEqual([]);
  });

  it("tolerates spacing and case, because an operator types a list by hand", () => {
    expect(developerAccounts(" Dev@Example.test , other@example.test ")).toEqual(["dev@example.test", "other@example.test"]);
  });

  it("drops entries that are not email-shaped rather than trusting them", () => {
    // A stray comma must not produce an empty entry that matches an empty
    // email, and a bare word must not become an account.
    expect(developerAccounts("dev@example.test,,notanemail,@example.test,trailing@")).toEqual(["dev@example.test"]);
  });

  it("does not repeat an address listed twice", () => {
    expect(developerAccounts("dev@example.test,DEV@example.test")).toEqual(["dev@example.test"]);
  });
});

describe("who counts as a developer", () => {
  const accounts = ["dev@example.test"];

  it("recognises a listed, confirmed address", () => {
    expect(isDeveloperAccount({ email: "dev@example.test", emailConfirmed: true }, accounts)).toBe(true);
    expect(isDeveloperAccount({ email: " DEV@Example.test ", emailConfirmed: true }, accounts)).toBe(true);
  });

  it("refuses an UNCONFIRMED address, however it is spelled", () => {
    // Anybody can sign up claiming any address. Without this, registering a
    // developer's email and never opening the mailbox would be enough.
    expect(isDeveloperAccount({ email: "dev@example.test", emailConfirmed: false }, accounts)).toBe(false);
  });

  it("refuses an address nobody listed", () => {
    expect(isDeveloperAccount({ email: "someone@example.test", emailConfirmed: true }, accounts)).toBe(false);
  });

  it("refuses everybody when the list is empty", () => {
    expect(isDeveloperAccount({ email: "dev@example.test", emailConfirmed: true }, [])).toBe(false);
  });

  it("refuses a session with no email at all", () => {
    expect(isDeveloperAccount({ email: null, emailConfirmed: true }, accounts)).toBe(false);
    expect(isDeveloperAccount({ email: "", emailConfirmed: true }, accounts)).toBe(false);
  });
});

describe("the developer session, against the configured deployment", () => {
  it("is true for a listed developer", () => {
    expect(isDeveloperSession(DEVELOPER)).toBe(true);
  });

  it("is false for everybody else", () => {
    expect(isDeveloperSession(ORDINARY)).toBe(false);
    expect(isDeveloperSession(null)).toBe(false);
    expect(isDeveloperSession(undefined)).toBe(false);
  });

  it("is false on a deployment that configured nothing", () => {
    state.developerAccounts = undefined;
    expect(isDeveloperSession(DEVELOPER)).toBe(false);
  });

  it("is false when the environment cannot be read, rather than throwing on a page", () => {
    state.envThrows = true;
    expect(isDeveloperSession(DEVELOPER)).toBe(false);
  });
});

describe("the effective plan", () => {
  it("is the subscription when no override exists", async () => {
    state.subscription = { planId: "premium", status: "active" };
    const plan = await effectivePlan(client, "org-1", DEVELOPER);
    expect(plan.entitlements.tier).toBe("premium");
    expect(plan.source).toBe("subscription");
  });

  it("gives a developer the plan they asked for", async () => {
    state.override = "business";
    const plan = await effectivePlan(client, "org-1", DEVELOPER);
    expect(plan.entitlements.tier).toBe("business");
    expect(plan.source).toBe("developer_override");
    // And still reports what is really billed, so nothing can confuse them.
    expect(plan.billedTier).toBe("free");
  });

  it("IGNORES an existing row for a session that is not a developer", async () => {
    // The stored-escalation case. A row that outlived the allowlist grants
    // nothing.
    state.override = "business";
    const plan = await effectivePlan(client, "org-1", ORDINARY);
    expect(plan.entitlements.tier).toBe("free");
    expect(plan.source).toBe("subscription");
  });

  it("IGNORES an existing row once the address is removed from the list", async () => {
    state.override = "business";
    state.developerAccounts = "someone-else@example.test";
    expect((await effectivePlan(client, "org-1", DEVELOPER)).entitlements.tier).toBe("free");
  });

  it("IGNORES an existing row when no request has a session at all", async () => {
    // A worker, a webhook or a cron run. Those act on the real subscription.
    state.override = "business";
    expect((await effectivePlan(client, "org-1", null)).entitlements.tier).toBe("free");
  });

  it("can force Free onto a PAID workspace, which is how restrictions get tested", async () => {
    state.subscription = { planId: "business", status: "active" };
    state.override = "free";
    const plan = await effectivePlan(client, "org-1", DEVELOPER);
    expect(plan.entitlements.tier).toBe("free");
    expect(plan.entitlements.bankConnections).toBe(false);
    // Billing untouched — this is a test view, not a cancellation.
    expect(plan.billedTier).toBe("business");
  });

  it("grants exactly what the purchasable plan grants, never more", async () => {
    state.override = "premium";
    const developer = (await effectivePlan(client, "org-1", DEVELOPER)).entitlements;

    state.override = null;
    state.subscription = { planId: "premium", status: "active" };
    const purchased = (await effectivePlan(client, "org-1", ORDINARY)).entitlements;

    // The same object from the same table: an override cannot invent an
    // entitlement no plan sells.
    expect(developer).toEqual(purchased);
  });

  it("falls back to the subscription when the override cannot be read at all", async () => {
    state.overrideReadFails = true;
    state.subscription = { planId: "premium", status: "active" };
    const plan = await effectivePlan(client, "org-1", DEVELOPER);
    expect(plan.entitlements.tier).toBe("premium");
    expect(plan.source).toBe("subscription");
  });

  it("still applies the subscription STATUS rule underneath", async () => {
    // A cancelled Premium is Free, and an override that is off does not
    // rescue it.
    state.subscription = { planId: "premium", status: "canceled" };
    const plan = await effectivePlan(client, "org-1", DEVELOPER);
    expect(plan.entitlements.tier).toBe("free");
    expect(plan.billedTier).toBe("free");
  });
});

describe("each tier's entitlements, through the override", () => {
  const forPlan = async (tier: string) => {
    state.override = tier;
    return (await effectivePlan(client, "org-1", DEVELOPER)).entitlements;
  };

  it("FREE blocks bank connections, document processing and advanced tax tools", async () => {
    const free = await forPlan("free");
    expect(free.bankConnections).toBe(false);
    expect(free.documentProcessing).toBe(false);
    expect(free.advancedTaxTools).toBe(false);
  });

  it("PREMIUM allows bank connections and document processing", async () => {
    const premium = await forPlan("premium");
    expect(premium.bankConnections).toBe(true);
    expect(premium.documentProcessing).toBe(true);
    expect(premium.advancedTaxTools).toBe(true);
    expect(premium.prioritySupport).toBe(false);
  });

  it("BUSINESS inherits Premium's features and adds its own", async () => {
    const business = await forPlan("business");
    expect(business.bankConnections).toBe(true);
    expect(business.documentProcessing).toBe(true);
    expect(business.advancedTaxTools).toBe(true);
    expect(business.prioritySupport).toBe(true);
    expect(business.aiMessagesPerDay).toBeGreaterThan((await forPlan("premium")).aiMessagesPerDay);
  });

  it("switching back to FREE returns every restriction", async () => {
    expect((await forPlan("business")).bankConnections).toBe(true);
    expect((await forPlan("free")).bankConnections).toBe(false);
  });
});

describe("what the person is told", () => {
  it("never shows a test plan as though it were a purchase", () => {
    expect(planLabelWithSource("Premium", "developer_override")).toBe("Premium — Test override");
    expect(planLabelWithSource("Premium", "subscription")).toBe("Premium");
  });
});

describe("the tier a request may name", () => {
  it("accepts only the three real tiers", () => {
    for (const tier of ["free", "premium", "business"]) expect(isDeveloperPlanTier(tier), tier).toBe(true);
    for (const tier of ["enterprise", "admin", "", "FREE", "premium "]) expect(isDeveloperPlanTier(tier), tier).toBe(false);
  });
});

describe("reading the row", () => {
  it("returns null rather than throwing when the table cannot be read", async () => {
    state.overrideReadFails = true;
    expect(await readPlanOverride(client, "org-1")).toBeNull();
  });
});
