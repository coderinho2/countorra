import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCredentialKeyset } from "@/server/bank-connections/credential-crypto";
import { BANK_LINK_STATE_COOKIE, sealBankLinkState } from "@/server/bank-connections/link-state";

/**
 * THE ONE FIXED BANK OAUTH RETURN PATH, END TO END THROUGH THE REAL ACTIONS.
 *
 * Real sealing (AES-256-GCM under an HKDF-derived key from a real keyset);
 * mocked only at the edges: who is signed in, which workspaces they belong to,
 * the cookie jar, and the provider-facing service layer (which records what it
 * was asked to do). No network, no Plaid.
 *
 * What these prove:
 *   - many organizations share ONE return path and each resumes into its own;
 *   - the organization comes from the server's seal, never from the request —
 *     an injected organizationId or connectionId is not even read;
 *   - a seal belongs to the user who started it, and is refused for anyone else;
 *   - membership and permission are re-checked at return time;
 *   - forged, tampered, foreign-keyed and expired seals open as nothing;
 *   - a seal is single-use;
 *   - no token reaches the cookie in readable form, the result, or the logs.
 */

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_1 = "11111111-1111-4111-8111-111111111111";
const USER_2 = "22222222-2222-4222-8222-222222222222";
const CONNECTION_A = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const LINK_TOKEN_A = "link-sandbox-aaaa1111-2222-3333-4444-555566667777";
const LINK_TOKEN_B = "link-sandbox-bbbb1111-2222-3333-4444-555566667777";
const PUBLIC_TOKEN = "public-sandbox-9999aaaa-bbbb-cccc-dddd-eeeeffff0000";

const KEYSET = parseCredentialKeyset(`test-1:${Buffer.alloc(32, 5).toString("base64")}`);
const OTHER_KEYSET = parseCredentialKeyset(`test-1:${Buffer.alloc(32, 6).toString("base64")}`);

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`NEXT_REDIRECT ${to}`);
  }
}

const state = vi.hoisted(() => ({
  currentUser: "" as string,
  memberships: {} as Record<string, Record<string, string>>, // user → org → role
  membershipChecks: [] as string[],
  jar: new Map<string, { value: string; options: Record<string, unknown> }>(),
  keyset: null as unknown,
  nextLinkToken: "",
  rateLimited: false,
  serviceCalls: [] as { name: string; input: Record<string, unknown> }[],
  logged: [] as string[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.jar.has(name) && state.jar.get(name)!.value !== "" ? { name, value: state.jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      if (options?.maxAge === 0) state.jar.delete(name);
      else state.jar.set(name, { value, options });
    },
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/server/auth/session", () => ({
  requireUser: async () => {
    if (!state.currentUser) throw new Redirect("/login");
    return { id: state.currentUser };
  },
  requireOrgMembership: async (organizationId: string) => {
    state.membershipChecks.push(organizationId);
    if (!state.currentUser) throw new Redirect("/login");
    const role = state.memberships[state.currentUser]?.[organizationId];
    if (!role) throw new Redirect("/app");
    return { user: { id: state.currentUser }, membership: { role } };
  },
}));
vi.mock("@/server/security/rate-limit", () => ({
  enforceRateLimit: async () => (state.rateLimited ? { allowed: false, message: "Too many requests. Please wait a moment and try again." } : { allowed: true }),
}));
vi.mock("@/lib/observability", () => ({
  reportError: (...args: unknown[]) => void state.logged.push(JSON.stringify(args)),
  reportEvent: (...args: unknown[]) => void state.logged.push(JSON.stringify(args)),
}));
vi.mock("@/domain/audit/audit-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/audit/audit-log")>()),
  recordAuditEvent: async (_client: unknown, event: unknown) => void state.logged.push(JSON.stringify(event)),
}));
vi.mock("@/server/bank-connections/providers", () => ({
  configuredBankProviders: () => [{ id: "plaid" }],
  configuredSecretStore: () => null,
  bankLinkStateKeyset: () => state.keyset,
}));
vi.mock("@/server/db/repositories/subscriptions", () => ({ getSubscription: async () => ({ planId: "premium", status: "active" }) }));
vi.mock("@/server/bank-connections/runtime", () => ({ productionBankDependencies: () => ({}) }));
vi.mock("@/server/bank-connections/service", () => ({
  createBankLinkSession: async (_deps: unknown, input: Record<string, unknown>) => {
    state.serviceCalls.push({ name: "createBankLinkSession", input });
    return { kind: "created", linkToken: state.nextLinkToken, mode: input.connectionId ? "reauthenticate" : "connect" };
  },
  completeBankLink: async (_deps: unknown, input: Record<string, unknown>) => {
    state.serviceCalls.push({ name: "completeBankLink", input });
    return { kind: "connected", connectionId: "new-connection", jobId: "job-1" };
  },
  completeBankReauth: async (_deps: unknown, input: Record<string, unknown>) => {
    state.serviceCalls.push({ name: "completeBankReauth", input });
    return { kind: "reconnected", jobId: "job-2" };
  },
  requestBankSync: async () => ({}),
  disconnectBankConnection: async () => ({}),
  linkExternalAccount: async () => ({}),
  resolveBankReview: async () => ({}),
}));

const actions = await import("@/server/bank-connections/actions");

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

/** Signs `user` in and starts a Link session in `organizationId`, the only
 *  place an organization is ever named. */
async function startLink(user: string, organizationId: string, linkToken: string, connectionId?: string) {
  state.currentUser = user;
  state.nextLinkToken = linkToken;
  const started = await actions.startBankLinkAction({}, form({ organizationId, ...(connectionId ? { connectionId } : {}) }));
  expect(started.linkToken).toBe(linkToken);
  return started;
}

/** The fixed return page: resume, then complete — with nothing but a public token. */
async function returnFromBank(extraFields: Record<string, string> = {}) {
  const resumed = await actions.resumeBankOauthAction();
  const completed = resumed.linkToken ? await actions.completeBankOauthAction({}, form({ publicToken: PUBLIC_TOKEN, ...extraFields })) : null;
  return { resumed, completed };
}

const linkCalls = () => state.serviceCalls.filter((call) => call.name === "completeBankLink");
const sealedCookie = () => state.jar.get(BANK_LINK_STATE_COOKIE);

beforeEach(() => {
  state.currentUser = "";
  state.memberships = { [USER_1]: { [ORG_A]: "owner", [ORG_B]: "admin" }, [USER_2]: { [ORG_B]: "owner" } };
  state.membershipChecks = [];
  state.jar = new Map();
  state.keyset = KEYSET;
  state.nextLinkToken = "";
  state.rateLimited = false;
  state.serviceCalls = [];
  state.logged = [];
});

describe("one fixed return path for every organization", () => {
  it("returns each organization's customer to their own organization", async () => {
    await startLink(USER_1, ORG_A, LINK_TOKEN_A);
    const first = await returnFromBank();
    expect(first.resumed).toMatchObject({ success: true, linkToken: LINK_TOKEN_A, organizationId: ORG_A, mode: "connect" });
    expect(first.completed).toMatchObject({ success: true, organizationId: ORG_A });

    await startLink(USER_2, ORG_B, LINK_TOKEN_B);
    const second = await returnFromBank();
    expect(second.resumed).toMatchObject({ linkToken: LINK_TOKEN_B, organizationId: ORG_B });
    expect(second.completed).toMatchObject({ success: true, organizationId: ORG_B });

    expect(linkCalls().map((call) => [call.input.organizationId, call.input.userId])).toEqual([
      [ORG_A, USER_1],
      [ORG_B, USER_2],
    ]);
  });

  it("follows the same person between two of their own organizations", async () => {
    await startLink(USER_1, ORG_A, LINK_TOKEN_A);
    await returnFromBank();
    await startLink(USER_1, ORG_B, LINK_TOKEN_B);
    await returnFromBank();

    expect(linkCalls().map((call) => call.input.organizationId)).toEqual([ORG_A, ORG_B]);
  });

  it("resumes a repair into the sealed connection, and completes it without a public token", async () => {
    await startLink(USER_1, ORG_A, LINK_TOKEN_A, CONNECTION_A);
    const resumed = await actions.resumeBankOauthAction();
    expect(resumed).toMatchObject({ mode: "reauthenticate", organizationId: ORG_A });

    const completed = await actions.completeBankOauthAction({}, form({}));
    expect(completed).toMatchObject({ success: true, organizationId: ORG_A });
    expect(state.serviceCalls.find((call) => call.name === "completeBankReauth")?.input).toMatchObject({ organizationId: ORG_A, connectionId: CONNECTION_A, userId: USER_1 });
    expect(linkCalls()).toEqual([]);
  });
});

describe("the organization is the server's, never the request's", () => {
  it("ignores an organizationId injected into the completion", async () => {
    await startLink(USER_1, ORG_A, LINK_TOKEN_A);
    state.membershipChecks = [];

    const { completed } = await returnFromBank({ organizationId: ORG_B, connectionId: CONNECTION_A, mode: "reauthenticate" });

    expect(completed).toMatchObject({ success: true, organizationId: ORG_A });
    expect(linkCalls()[0].input.organizationId).toBe(ORG_A);
    // ORG_B was never even checked, let alone used.
    expect(state.membershipChecks).not.toContain(ORG_B);
    expect(state.serviceCalls.some((call) => call.name === "completeBankReauth")).toBe(false);
  });

  it("names no organization in the return path itself", async () => {
    const { BANK_OAUTH_RETURN_PATH } = await import("@/domain/bank-connections/oauth");
    expect(BANK_OAUTH_RETURN_PATH).toBe("/app/bank-connections/oauth");
    expect(BANK_OAUTH_RETURN_PATH).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|orgId|\[/);
  });
});

describe("a seal belongs to the person who started it", () => {
  it("is refused for anyone else signed in on the same browser — even a member of that organization", async () => {
    await startLink(USER_1, ORG_B, LINK_TOKEN_B);
    state.currentUser = USER_2; // also an owner of ORG_B

    const { resumed, completed } = await returnFromBank();

    expect(resumed.error).toMatch(/no bank sign-in to finish/);
    expect(resumed.linkToken).toBeUndefined();
    expect(completed).toBeNull();
    expect(linkCalls()).toEqual([]);
    // And it cannot be tried again by anyone.
    expect(sealedCookie()).toBeUndefined();
  });

  it("refuses a completion attempted directly by another user, without resuming first", async () => {
    await startLink(USER_1, ORG_A, LINK_TOKEN_A);
    state.currentUser = USER_2;

    const completed = await actions.completeBankOauthAction({}, form({ publicToken: PUBLIC_TOKEN, organizationId: ORG_A }));

    expect(completed.error).toMatch(/no bank sign-in to finish/);
    expect(linkCalls()).toEqual([]);
  });

  it("re-checks membership at return: someone removed from the workspace meanwhile is turned away", async () => {
    await startLink(USER_1, ORG_A, LINK_TOKEN_A);
    delete state.memberships[USER_1][ORG_A];

    await expect(actions.resumeBankOauthAction()).rejects.toBeInstanceOf(Redirect);
    await expect(actions.completeBankOauthAction({}, form({ publicToken: PUBLIC_TOKEN }))).rejects.toBeInstanceOf(Redirect);
    expect(linkCalls()).toEqual([]);
  });

  it("re-checks permission at return: a demoted member cannot finish connecting a bank", async () => {
    await startLink(USER_1, ORG_A, LINK_TOKEN_A);
    state.memberships[USER_1][ORG_A] = "viewer";

    const resumed = await actions.resumeBankOauthAction();

    expect(resumed.error).toMatch(/owner or admin/);
    expect(resumed.linkToken).toBeUndefined();
    expect(sealedCookie()).toBeUndefined();
  });

  it("requires a signed-in session at all", async () => {
    await startLink(USER_1, ORG_A, LINK_TOKEN_A);
    state.currentUser = "";
    await expect(actions.resumeBankOauthAction()).rejects.toBeInstanceOf(Redirect);
  });
});

describe("a seal cannot be forged, altered, reused or kept", () => {
  it("opens as nothing when altered by a single character", async () => {
    await startLink(USER_1, ORG_A, LINK_TOKEN_A);
    const cookie = sealedCookie()!;
    const tampered = cookie.value.slice(0, -2) + (cookie.value.endsWith("A") ? "BB" : "AA");
    state.jar.set(BANK_LINK_STATE_COOKIE, { ...cookie, value: tampered });

    expect((await actions.resumeBankOauthAction()).error).toMatch(/no bank sign-in to finish/);
  });

  it("cannot be minted by someone without the server's key — not even for their own organization", async () => {
    state.currentUser = USER_1;
    const forged = sealBankLinkState({ userId: USER_1, organizationId: ORG_A, connectionId: null, mode: "connect", linkToken: LINK_TOKEN_A }, OTHER_KEYSET, new Date());
    state.jar.set(BANK_LINK_STATE_COOKIE, { value: forged, options: {} });

    expect((await actions.resumeBankOauthAction()).error).toMatch(/no bank sign-in to finish/);
    expect((await actions.completeBankOauthAction({}, form({ publicToken: PUBLIC_TOKEN }))).error).toMatch(/no bank sign-in to finish/);
    expect(linkCalls()).toEqual([]);
  });

  it("expires", async () => {
    state.currentUser = USER_1;
    const old = sealBankLinkState({ userId: USER_1, organizationId: ORG_A, connectionId: null, mode: "connect", linkToken: LINK_TOKEN_A }, KEYSET, new Date(Date.now() - 31 * 60_000));
    state.jar.set(BANK_LINK_STATE_COOKIE, { value: old, options: {} });

    expect((await actions.resumeBankOauthAction()).error).toMatch(/no bank sign-in to finish/);
  });

  it("is used once: a second completion finds nothing", async () => {
    await startLink(USER_1, ORG_A, LINK_TOKEN_A);
    await returnFromBank();
    expect(sealedCookie()).toBeUndefined();

    const again = await actions.completeBankOauthAction({}, form({ publicToken: PUBLIC_TOKEN }));
    expect(again.error).toMatch(/no bank sign-in to finish/);
    expect(linkCalls()).toHaveLength(1);
  });

  it("survives a rate-limit refusal, so the customer can simply try again", async () => {
    await startLink(USER_1, ORG_A, LINK_TOKEN_A);
    state.rateLimited = true;
    expect((await actions.completeBankOauthAction({}, form({ publicToken: PUBLIC_TOKEN }))).error).toMatch(/Too many requests/);
    expect(sealedCookie()).toBeDefined();

    state.rateLimited = false;
    expect((await actions.completeBankOauthAction({}, form({ publicToken: PUBLIC_TOKEN }))).success).toBe(true);
  });

  it("is cleared when the bank link finishes in the page instead", async () => {
    await startLink(USER_1, ORG_A, LINK_TOKEN_A);
    const result = await actions.completeBankLinkAction({}, form({ organizationId: ORG_A, publicToken: PUBLIC_TOKEN }));
    expect(result.success).toBe(true);
    expect(sealedCookie()).toBeUndefined();
  });

  it("still lets a link start, and simply cannot be resumed, when no key exists", async () => {
    state.keyset = null;
    await startLink(USER_1, ORG_A, LINK_TOKEN_A);
    expect(sealedCookie()).toBeUndefined();
    expect((await actions.resumeBankOauthAction()).error).toMatch(/no bank sign-in to finish/);
  });
});

describe("nothing secret leaves where it should not", () => {
  it("sets an HttpOnly, SameSite=Strict, /app-scoped, short-lived cookie that hides its contents", async () => {
    await startLink(USER_1, ORG_A, LINK_TOKEN_A);
    const cookie = sealedCookie()!;

    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "strict", path: "/app", maxAge: 30 * 60 });
    // Encrypted, not merely encoded: neither the token nor who or where is readable.
    for (const secret of [LINK_TOKEN_A, ORG_A, USER_1, "link-sandbox"]) {
      expect(cookie.value).not.toContain(secret);
      expect(Buffer.from(cookie.value.split(".").pop()!, "base64url").toString("utf8")).not.toContain(secret);
    }
  });

  it("never echoes the public token, and never logs any token", async () => {
    await startLink(USER_1, ORG_A, LINK_TOKEN_A);
    const { resumed, completed } = await returnFromBank();

    expect(JSON.stringify(completed)).not.toContain(PUBLIC_TOKEN);
    expect(JSON.stringify(resumed)).not.toContain(PUBLIC_TOKEN);
    const everythingLogged = state.logged.join("\n");
    for (const secret of [PUBLIC_TOKEN, LINK_TOKEN_A]) expect(everythingLogged).not.toContain(secret);
  });
});
