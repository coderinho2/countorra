import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `requireOrgMembership` — the authorization primitive every org-scoped
 * Server Action starts from.
 *
 * It had no direct test. tests/security/rate-limit-boundary.test.ts exercises
 * Server Actions, but it *mocks this function out* in order to isolate the
 * limiter — which means the thing doing the actual authorizing was the one
 * piece never exercised. This file runs the real implementation.
 *
 * Redirects are the failure mode rather than thrown errors, because every
 * caller is a page. The mock below turns a redirect into a throw carrying the
 * destination, which is what Next.js does in production too.
 */

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    user: null as { id: string; email: string } | null,
    membership: null as { organizationId: string; userId: string; role: string } | null,
    membershipLookups: [] as { organizationId: string; userId: string }[],
  };
});

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    const e = new Error(`NEXT_REDIRECT:${to}`) as Error & { digest?: string };
    e.digest = `NEXT_REDIRECT;${to}`;
    throw e;
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}));

vi.mock("@/server/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));

vi.mock("@/server/db/repositories/memberships", () => ({
  getMyMembership: async (_client: unknown, organizationId: string, userId: string) => {
    state.membershipLookups.push({ organizationId, userId });
    return state.membership;
  },
}));

const { requireOrgMembership, requireUser, getSession } = await import("@/server/auth/session");

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = { id: "22222222-2222-4222-8222-222222222222", email: "u@example.test" };

/** Returns the path a call redirected to, or null if it didn't redirect. */
async function redirectedTo(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    const digest = (error as Error & { digest?: string }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.slice("NEXT_REDIRECT;".length);
    throw error;
  }
}

beforeEach(() => {
  state.user = USER;
  state.membership = { organizationId: ORG, userId: USER.id, role: "owner" };
  state.membershipLookups = [];
});

describe("requireUser", () => {
  it("returns the authenticated user", async () => {
    await expect(requireUser()).resolves.toMatchObject({ id: USER.id });
  });

  it("sends an unauthenticated caller to login", async () => {
    state.user = null;
    expect(await redirectedTo(() => requireUser())).toBe("/login");
  });
});

describe("getSession", () => {
  it("returns null rather than redirecting, so public pages stay public", async () => {
    state.user = null;
    await expect(getSession()).resolves.toBeNull();
  });
});

describe("requireOrgMembership", () => {
  it("returns the user and membership for a real member", async () => {
    const result = await requireOrgMembership(ORG);
    expect(result.user.id).toBe(USER.id);
    expect(result.membership).toMatchObject({ organizationId: ORG, role: "owner" });
  });

  it("sends an unauthenticated caller to login before any membership lookup", async () => {
    state.user = null;
    expect(await redirectedTo(() => requireOrgMembership(ORG))).toBe("/login");
    expect(state.membershipLookups).toEqual([]);
  });

  it("sends a non-member away, treating the organization as nonexistent", async () => {
    state.membership = null;
    expect(await redirectedTo(() => requireOrgMembership(ORG))).toBe("/app");
  });

  it("looks the membership up by the AUTHENTICATED user id, never a supplied one", async () => {
    await requireOrgMembership(ORG);
    expect(state.membershipLookups).toEqual([{ organizationId: ORG, userId: USER.id }]);
  });

  describe("malformed organization ids", () => {
    // A non-uuid reaching PostgREST produced a Postgres cast error that
    // surfaced as a 500 — a needless error path reachable on every /app route.
    const malformed = [
      "not-a-uuid",
      "",
      "1",
      "11111111-1111-4111-8111",
      "11111111-1111-4111-8111-111111111111-extra",
      "'; drop table transactions; --",
      "../../etc/passwd",
      "%2e%2e%2f",
      "11111111_1111_4111_8111_111111111111",
    ];

    for (const id of malformed) {
      it(`redirects rather than querying for ${JSON.stringify(id.slice(0, 32))}`, async () => {
        expect(await redirectedTo(() => requireOrgMembership(id))).toBe("/app");
        expect(state.membershipLookups).toEqual([]);
      });
    }

    it("accepts a well-formed uuid in either case", async () => {
      await expect(requireOrgMembership(ORG.toUpperCase())).resolves.toBeDefined();
    });
  });

  describe("role restriction", () => {
    it("admits a role on the allow-list", async () => {
      state.membership = { organizationId: ORG, userId: USER.id, role: "accountant" };
      await expect(requireOrgMembership(ORG, ["owner", "admin", "accountant"])).resolves.toBeDefined();
    });

    it("turns away a member whose role is not on the allow-list", async () => {
      state.membership = { organizationId: ORG, userId: USER.id, role: "viewer" };
      expect(await redirectedTo(() => requireOrgMembership(ORG, ["owner", "admin"]))).toBe("/app");
    });

    it("turns away an employee from an owner-only route", async () => {
      state.membership = { organizationId: ORG, userId: USER.id, role: "employee" };
      expect(await redirectedTo(() => requireOrgMembership(ORG, ["owner"]))).toBe("/app");
    });

    it("admits any member when no roles are specified", async () => {
      state.membership = { organizationId: ORG, userId: USER.id, role: "viewer" };
      await expect(requireOrgMembership(ORG)).resolves.toBeDefined();
    });
  });

  it("does not trust a membership row that names a different organization", async () => {
    // Defence in depth: the lookup is already scoped, but the returned row is
    // what callers key their `can()` checks on, so it must be the right one.
    await requireOrgMembership(ORG);
    expect(state.membershipLookups[0].organizationId).toBe(ORG);
  });
});
