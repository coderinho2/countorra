import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ACTION THAT SETS A TEST PLAN — what it refuses, and in what order.
 *
 * Two independent conditions have to hold, and this file exists to prove that
 * failing EITHER writes nothing: a developer of the deployment who does not
 * own the workspace, and an owner who is not a developer, are both refused.
 *
 * Order matters as much as the outcome. Ownership is established first, so a
 * stranger probing a workspace that is not theirs is turned away before the
 * action reveals — by the shape of its answer — that a developer mechanism
 * exists at all.
 */

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  return {
    role: "owner" as string,
    /** Roles requireOrgMembership was restricted to, per call. */
    rolesRequired: [] as (string[] | undefined)[],
    isDeveloper: true,
    rateLimited: false,
    order: [] as string[],
    writes: [] as { organizationId: string; planId: string | null; actorId: string }[],
    writeThrows: false,
    audits: [] as { action: string; metadata: Record<string, unknown> }[],
    revalidated: [] as string[],
    events: [] as { name: string; detail: Record<string, unknown> }[],
    adminClients: 0,
  };
});

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

vi.mock("server-only", () => ({}));

vi.mock("@/server/auth/session", () => ({
  requireOrgMembership: async (_organizationId: string, allowedRoles?: string[]) => {
    state.order.push("auth");
    state.rolesRequired.push(allowedRoles);
    // The real helper REDIRECTS for a role mismatch. Modelled as a throw,
    // which is what a redirect is inside a Server Action.
    if (allowedRoles && !allowedRoles.includes(state.role)) throw new Error("NEXT_REDIRECT");
    return { user: { id: USER, email: "dev@example.test", email_confirmed_at: "2026-01-01T00:00:00.000Z" }, membership: { role: state.role } };
  },
}));

vi.mock("@/server/billing/developer-override", () => ({
  isDeveloperSession: () => {
    state.order.push("developer-check");
    return state.isDeveloper;
  },
  writePlanOverride: async (_admin: unknown, input: { organizationId: string; planId: string | null; actorId: string }) => {
    state.order.push("write");
    if (state.writeThrows) throw new Error("database unavailable");
    state.writes.push(input);
  },
}));

vi.mock("@/server/security/rate-limit", () => ({
  enforceRateLimit: async () => {
    state.order.push("rate-limit");
    return state.rateLimited ? { allowed: false, retryAfterSeconds: 30, message: "slow down", degraded: false } : { allowed: true, retryAfterSeconds: 0, message: null, degraded: false };
  },
}));

vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/server/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminClients += 1;
    return {};
  },
}));

vi.mock("@/domain/audit/audit-log", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    recordAuditEvent: async (_client: unknown, entry: { action: string; metadata?: Record<string, unknown> }) => {
      state.audits.push({ action: entry.action, metadata: entry.metadata ?? {} });
    },
  };
});

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => state.revalidated.push(path) }));

vi.mock("@/lib/observability", () => ({
  reportEvent: (name: string, context: { detail?: Record<string, unknown> }) => state.events.push({ name, detail: context.detail ?? {} }),
  reportError: () => {},
}));

const { setDeveloperPlanAction } = await import("@/server/billing/developer-actions");

const submit = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return setDeveloperPlanAction({}, data);
};

beforeEach(() => {
  state.role = "owner";
  state.rolesRequired = [];
  state.isDeveloper = true;
  state.rateLimited = false;
  state.order = [];
  state.writes = [];
  state.writeThrows = false;
  state.audits = [];
  state.revalidated = [];
  state.events = [];
  state.adminClients = 0;
});

describe("an unauthorized user cannot activate the override", () => {
  it("refuses a signed-in owner who is NOT a developer, and writes nothing", async () => {
    state.isDeveloper = false;
    const result = await submit({ organizationId: ORG, plan: "business" });

    expect(result.error).toBe("That isn't available.");
    expect(state.writes).toEqual([]);
    expect(state.adminClients).toBe(0);
  });

  it("refuses a developer who is not an OWNER of the workspace", async () => {
    // A developer of the deployment still cannot change somebody else's
    // workspace, or one where they are only an admin or a member.
    for (const role of ["admin", "member", "viewer"]) {
      state.role = role;
      state.writes = [];
      await expect(submit({ organizationId: ORG, plan: "business" })).rejects.toThrow(/NEXT_REDIRECT/);
      expect(state.writes, role).toEqual([]);
    }
  });

  it("asks for ownership specifically, not merely membership", async () => {
    await submit({ organizationId: ORG, plan: "premium" });
    expect(state.rolesRequired).toEqual([["owner"]]);
  });

  it("establishes ownership BEFORE it reveals that a developer mechanism exists", async () => {
    state.isDeveloper = false;
    await submit({ organizationId: ORG, plan: "premium" });
    expect(state.order.indexOf("auth")).toBeLessThan(state.order.indexOf("developer-check"));
  });

  it("records a refusal as a security event", async () => {
    state.isDeveloper = false;
    await submit({ organizationId: ORG, plan: "premium" });
    expect(state.events.map((event) => event.name)).toContain("billing.developer_override_refused");
  });
});

describe("an authorized developer", () => {
  it("can activate Premium", async () => {
    const result = await submit({ organizationId: ORG, plan: "premium" });
    expect(result.success).toBe(true);
    expect(state.writes).toEqual([{ organizationId: ORG, planId: "premium", actorId: USER }]);
  });

  it("can activate Business", async () => {
    const result = await submit({ organizationId: ORG, plan: "business" });
    expect(result.success).toBe(true);
    expect(state.writes[0].planId).toBe("business");
  });

  it("can force Free, to check the restrictions come back", async () => {
    expect((await submit({ organizationId: ORG, plan: "free" })).success).toBe(true);
    expect(state.writes[0].planId).toBe("free");
  });

  it("can turn it off entirely", async () => {
    const result = await submit({ organizationId: ORG, plan: "off" });
    expect(result.success).toBe(true);
    expect(state.writes[0].planId).toBeNull();
    expect(result.message).toMatch(/back on its real plan/i);
  });

  it("writes through the SERVICE ROLE, because no browser role may touch that table", async () => {
    await submit({ organizationId: ORG, plan: "premium" });
    expect(state.adminClients).toBe(1);
  });
});

describe("what a request may name", () => {
  it("refuses a tier that is not a plan", async () => {
    for (const plan of ["enterprise", "admin", "PREMIUM"]) {
      state.writes = [];
      expect((await submit({ organizationId: ORG, plan })).error, plan).toBe("That isn't a plan.");
      expect(state.writes, plan).toEqual([]);
    }
  });

  it("refuses a malformed organization id before anything else", async () => {
    const result = await submit({ organizationId: "not-a-uuid", plan: "premium" });
    expect(result.error).toBe("That request isn't valid.");
    expect(state.order).toEqual([]);
  });

  it("is rate limited, like every other privileged mutation", async () => {
    state.rateLimited = true;
    const result = await submit({ organizationId: ORG, plan: "premium" });
    expect(result.error).toBe("slow down");
    expect(state.writes).toEqual([]);
  });
});

describe("what it does and does not touch", () => {
  it("creates and modifies NO Stripe object and no subscription row", async () => {
    await submit({ organizationId: ORG, plan: "business" });

    // The only write is the override itself.
    expect(state.writes).toHaveLength(1);
    // And the action's own CODE reaches no billing machinery at all — the
    // separation is structural rather than a promise in a comment. Comments
    // are stripped before the search precisely so that the promise in the
    // header cannot be what satisfies it.
    const { readFileSync } = await import("node:fs");
    const code = readFileSync("src/server/billing/developer-actions.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .toLowerCase();
    for (const term of ["stripe", "subscriptions", "checkout", "invoice", "customer"]) {
      expect(code, term).not.toContain(term);
    }
  });

  it("records the tier in the audit trail, and nothing about the person", async () => {
    await submit({ organizationId: ORG, plan: "business" });
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0].action).toBe("billing.developer_plan_override_changed");
    expect(state.audits[0].metadata).toEqual({ plan: "business" });
    // No email, no allowlist, no billing detail.
    expect(JSON.stringify(state.audits[0])).not.toContain("@");
  });

  it("revalidates every surface whose content depends on the plan", async () => {
    await submit({ organizationId: ORG, plan: "premium" });
    for (const path of ["settings", "bank-connections", "documents", "dashboard", "assistant"]) {
      expect(state.revalidated, path).toContain(`/app/${ORG}/${path}`);
    }
  });

  it("reports a write failure without claiming anything changed", async () => {
    state.writeThrows = true;
    const result = await submit({ organizationId: ORG, plan: "premium" });
    expect(result.error).toMatch(/nothing was changed/i);
    expect(result.success).toBeUndefined();
    expect(state.audits).toEqual([]);
  });
});
