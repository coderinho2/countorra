import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Bank-connection Server Actions, called directly — the way an attacker would,
 * with no UI in between.
 *
 * Authorization comes first and is re-derived from the session; the rate limit
 * comes after authorization and before any work; only ids and small enums are
 * accepted from the browser; the organization handed to the service is the
 * authorized one and the actor is the session user, never a form field; and
 * with no provider configured, connecting says so instead of pretending.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const LINKED = "55555555-5555-4555-8555-555555555555";
const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const EXTERNAL = "77777777-7777-4777-8777-777777777777";

const state = vi.hoisted(() => ({
  role: "owner",
  membershipChecks: [] as string[],
  rateLimited: false,
  rateLimitCalls: [] as { group: string; identifiers: Record<string, string> }[],
  serviceCalls: [] as { name: string; input: Record<string, unknown> }[],
  audits: [] as { action: string; metadata?: Record<string, unknown> }[],
  providers: [] as { id: string }[],
  subscription: null as { planId: string; status: string } | null,
  outcomes: {} as Record<string, unknown>,
  order: [] as string[],
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/server/auth/session", () => ({
  requireOrgMembership: async (organizationId: string) => {
    state.order.push("auth");
    state.membershipChecks.push(organizationId);
    return { user: { id: USER }, membership: { role: state.role } };
  },
}));
vi.mock("@/server/security/rate-limit", () => ({
  enforceRateLimit: async (group: string, identifiers: Record<string, string>) => {
    state.order.push("rate-limit");
    state.rateLimitCalls.push({ group, identifiers });
    return state.rateLimited ? { allowed: false, message: "Too many requests. Please wait a moment and try again." } : { allowed: true };
  },
}));
vi.mock("@/lib/observability", () => ({ reportError: () => {}, reportEvent: () => {} }));
vi.mock("@/domain/audit/audit-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/audit/audit-log")>()),
  recordAuditEvent: async (_client: unknown, event: { action: string; metadata?: Record<string, unknown> }) => void state.audits.push(event),
}));
vi.mock("@/server/bank-connections/providers", () => ({ configuredBankProviders: () => state.providers, configuredSecretStore: () => null }));
// The canonical entitlement source, read through the subscription repository —
// no second entitlement model anywhere near bank connections.
vi.mock("@/server/db/repositories/subscriptions", () => ({ getSubscription: async () => state.subscription }));
vi.mock("@/server/bank-connections/runtime", () => ({ productionBankDependencies: () => ({ marker: "production-deps" }) }));

const record = (name: string) => async (_deps: unknown, input: Record<string, unknown>) => {
  state.order.push(name);
  state.serviceCalls.push({ name, input });
  return state.outcomes[name];
};
vi.mock("@/server/bank-connections/service", () => ({
  createBankLinkSession: record("createBankLinkSession"),
  completeBankLink: record("completeBankLink"),
  completeBankReauth: record("completeBankReauth"),
  requestBankSync: record("requestBankSync"),
  disconnectBankConnection: record("disconnectBankConnection"),
  linkExternalAccount: record("linkExternalAccount"),
  resolveBankReview: record("resolveBankReview"),
}));

const actions = await import("@/server/bank-connections/actions");

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

beforeEach(() => {
  Object.assign(state, {
    role: "owner",
    membershipChecks: [],
    rateLimited: false,
    rateLimitCalls: [],
    serviceCalls: [],
    audits: [],
    providers: [],
    subscription: { planId: "premium", status: "active" },
    order: [],
    outcomes: {
      completeBankReauth: { kind: "reconnected", jobId: "job-1" },
      createBankLinkSession: { kind: "not_configured", message: "No bank connection provider is configured for this deployment, so nothing is imported automatically. Accounts and transactions are recorded by hand." },
      requestBankSync: { kind: "not_configured", message: "No bank connection provider is configured for this deployment, so nothing is imported automatically. Accounts and transactions are recorded by hand." },
      disconnectBankConnection: { kind: "disconnected", previousStatus: "ACTIVE", providerRevoked: null },
      linkExternalAccount: { kind: "applied", reconciled: 3 },
      resolveBankReview: { kind: "applied" },
    },
  });
});

describe("connecting a bank with no provider configured", () => {
  it("says so, returns no link token and records nothing", async () => {
    const result = await actions.startBankLinkAction({}, form({ organizationId: ORG }));
    expect(result.error).toMatch(/No bank connection provider is configured/);
    expect(result.linkToken).toBeUndefined();
    expect(result.success).toBeUndefined();
    expect(state.audits).toEqual([]);
  });

  it("never reaches the link-completion service", async () => {
    const result = await actions.completeBankLinkAction({}, form({ organizationId: ORG, publicToken: "public-sandbox-123" }));
    expect(result.error).toMatch(/No bank connection provider is configured/);
    expect(state.serviceCalls.map((call) => call.name)).not.toContain("completeBankLink");
  });

  it("says so however good the plan is — a purchase cannot conjure a provider", async () => {
    state.subscription = { planId: "business", status: "active" };
    expect((await actions.startBankLinkAction({}, form({ organizationId: ORG }))).error).toMatch(/No bank connection provider is configured/);
    expect((await actions.completeBankReauthAction({}, form({ organizationId: ORG, connectionId: CONNECTION }))).error).toMatch(/No bank connection provider is configured/);
    expect(state.serviceCalls).toEqual([]);
  });

  it("refuses members who may not connect a bank", async () => {
    for (const role of ["accountant", "manager", "employee", "viewer"]) {
      state.role = role;
      state.serviceCalls = [];
      expect((await actions.startBankLinkAction({}, form({ organizationId: ORG }))).error).toMatch(/owner or admin/);
      expect(state.serviceCalls).toEqual([]);
    }
  });
});

describe("authorization, by role", () => {
  const cases: [string, (role: string) => Promise<{ error?: string }>, string[]][] = [
    ["refresh", () => actions.requestBankSyncAction({}, form({ organizationId: ORG, connectionId: CONNECTION })), ["owner", "admin", "accountant", "manager", "employee"]],
    ["disconnect", () => actions.disconnectBankConnectionAction({}, form({ organizationId: ORG, connectionId: CONNECTION, confirm: "disconnect" })), ["owner", "admin"]],
    ["link", () => actions.linkExternalAccountAction({}, form({ organizationId: ORG, linkedAccountId: LINKED, target: ACCOUNT })), ["owner", "admin"]],
    ["resolve", () => actions.resolveBankReviewAction({}, form({ organizationId: ORG, externalId: EXTERNAL, resolution: "KEEP_BOOKS" })), ["owner", "admin", "accountant", "manager", "employee"]],
  ];

  for (const [name, run, allowed] of cases) {
    it(`${name}: allowed for ${allowed.join(", ")} and refused for everyone else, before any work`, async () => {
      for (const role of ["owner", "admin", "accountant", "manager", "employee", "viewer"]) {
        state.role = role;
        state.serviceCalls = [];
        state.rateLimitCalls = [];
        const result = await run(role);
        if (allowed.includes(role)) {
          expect(state.serviceCalls, `${name} as ${role}`).toHaveLength(1);
        } else {
          expect(result.error, `${name} as ${role}`).toMatch(/permission|owner or admin/);
          expect(state.serviceCalls).toEqual([]);
          expect(state.rateLimitCalls).toEqual([]);
        }
      }
    });
  }
});

describe("rate limiting", () => {
  it("runs after authorization and before the service, keyed on the session user and the connection", async () => {
    await actions.requestBankSyncAction({}, form({ organizationId: ORG, connectionId: CONNECTION }));
    expect(state.order).toEqual(["auth", "rate-limit", "requestBankSync"]);
    expect(state.rateLimitCalls[0]).toEqual({ group: "bankSync", identifiers: { bankSyncPerUser: USER, bankSyncPerConnection: `${ORG}:${CONNECTION}` } });
  });

  it("stops every bank action when exhausted", async () => {
    state.rateLimited = true;
    const results = await Promise.all([
      actions.startBankLinkAction({}, form({ organizationId: ORG })),
      actions.requestBankSyncAction({}, form({ organizationId: ORG, connectionId: CONNECTION })),
      actions.disconnectBankConnectionAction({}, form({ organizationId: ORG, connectionId: CONNECTION, confirm: "disconnect" })),
      actions.linkExternalAccountAction({}, form({ organizationId: ORG, linkedAccountId: LINKED, target: ACCOUNT })),
      actions.resolveBankReviewAction({}, form({ organizationId: ORG, externalId: EXTERNAL, resolution: "KEEP_BOOKS" })),
    ]);
    for (const result of results) expect(result.error).toMatch(/Too many requests/);
    expect(state.serviceCalls).toEqual([]);
    expect(state.rateLimitCalls.map((call) => call.group).sort()).toEqual(["bankAccountLink", "bankDisconnect", "bankLinkSession", "bankSync", "recordMutation"]);
  });
});

describe("what the browser may send", () => {
  it("rejects malformed ids before authenticating", async () => {
    for (const run of [
      () => actions.requestBankSyncAction({}, form({ organizationId: "not-a-uuid", connectionId: CONNECTION })),
      () => actions.disconnectBankConnectionAction({}, form({ organizationId: ORG, connectionId: "'; drop table x;--", confirm: "disconnect" })),
      () => actions.linkExternalAccountAction({}, form({ organizationId: ORG, linkedAccountId: LINKED, target: "everything" })),
      () => actions.resolveBankReviewAction({}, form({ organizationId: ORG, externalId: EXTERNAL, resolution: "MATCH_TO" })),
      () => actions.resolveBankReviewAction({}, form({ organizationId: ORG, externalId: EXTERNAL, resolution: "CONFIRM_ALL" })),
      () => actions.completeBankLinkAction({}, form({ organizationId: ORG, publicToken: "" })),
      () => actions.completeBankLinkAction({}, form({ organizationId: ORG, publicToken: "x".repeat(3000) })),
      () => actions.startBankLinkAction({}, form({ organizationId: ORG, connectionId: "not-a-uuid" })),
    ]) {
      expect((await run()).error).toBeTruthy();
    }
    expect(state.membershipChecks).toEqual([]);
    expect(state.serviceCalls).toEqual([]);
  });

  it("requires an explicit confirmation to disconnect", async () => {
    expect((await actions.disconnectBankConnectionAction({}, form({ organizationId: ORG, connectionId: CONNECTION }))).error).toMatch(/Confirm/);
    expect((await actions.disconnectBankConnectionAction({}, form({ organizationId: ORG, connectionId: CONNECTION, confirm: "yes" }))).error).toMatch(/Confirm/);
    expect(state.serviceCalls).toEqual([]);
  });

  it("uses the authorized organization and the session user, whatever else the form says", async () => {
    await actions.disconnectBankConnectionAction({}, form({ organizationId: ORG, connectionId: CONNECTION, confirm: "disconnect", actorId: "99999999-9999-4999-8999-999999999999", status: "DISCONNECTED" }));
    expect(state.membershipChecks).toEqual([ORG]);
    expect(state.serviceCalls[0]).toEqual({ name: "disconnectBankConnection", input: { organizationId: ORG, connectionId: CONNECTION, actorId: USER } });
  });

  it("links to an account, or ignores the bank account — nothing in between", async () => {
    await actions.linkExternalAccountAction({}, form({ organizationId: ORG, linkedAccountId: LINKED, target: ACCOUNT }));
    await actions.linkExternalAccountAction({}, form({ organizationId: ORG, linkedAccountId: LINKED, target: "ignore" }));
    expect(state.serviceCalls.map((call) => call.input)).toEqual([
      { organizationId: ORG, linkedAccountId: LINKED, accountId: ACCOUNT, importMode: "IMPORT", actorId: USER },
      { organizationId: ORG, linkedAccountId: LINKED, accountId: null, importMode: "IGNORE", actorId: USER },
    ]);
  });
});

describe("when Plaid is configured", () => {
  beforeEach(() => {
    state.providers = [{ id: "plaid" }];
    state.outcomes.createBankLinkSession = { kind: "created", linkToken: "link-sandbox-abc", expiresAt: "2026-09-16T13:00:00Z", mode: "connect" };
  });

  it("gives the browser a Link token and nothing else", async () => {
    const result = await actions.startBankLinkAction({}, form({ organizationId: ORG }));
    expect(result).toEqual({ success: true, linkToken: "link-sandbox-abc", mode: "connect" });
    expect(state.serviceCalls[0]).toEqual({ name: "createBankLinkSession", input: { organizationId: ORG, userId: USER, connectionId: undefined } });
    expect(state.audits[0]).toMatchObject({ action: "bank_connection.link_started", metadata: { mode: "connect" } });
  });

  it("refuses a workspace whose plan does not include bank connections, before calling Plaid", async () => {
    for (const subscription of [null, { planId: "free", status: "active" }, { planId: "premium", status: "canceled" }, { planId: "business", status: "past_due" }]) {
      state.subscription = subscription;
      state.serviceCalls = [];
      const result = await actions.startBankLinkAction({}, form({ organizationId: ORG }));
      expect(result.error, JSON.stringify(subscription)).toMatch(/part of Premium and Business/);
      expect(state.serviceCalls).toEqual([]);
    }
  });

  it("entitles an active paid plan", async () => {
    for (const planId of ["premium", "business"]) {
      for (const status of ["active", "trialing"]) {
        state.subscription = { planId, status };
        state.serviceCalls = [];
        expect((await actions.startBankLinkAction({}, form({ organizationId: ORG }))).success, `${planId}/${status}`).toBe(true);
        expect(state.serviceCalls).toHaveLength(1);
      }
    }
  });

  it("resolves the provider itself when completing a link — the browser does not name it", async () => {
    state.outcomes.completeBankLink = { kind: "connected", connectionId: CONNECTION, jobId: "job-1" };
    const result = await actions.completeBankLinkAction({}, form({ organizationId: ORG, publicToken: "public-sandbox-123", providerId: "not-plaid" }));
    expect(result.success).toBe(true);
    expect(state.serviceCalls[0]).toEqual({ name: "completeBankLink", input: { organizationId: ORG, userId: USER, providerId: "plaid", publicToken: "public-sandbox-123" } });
    expect(state.audits[0]).toMatchObject({ action: "bank_connection.connected", metadata: { provider: "plaid" } });
  });

  it("opens a repair session for an existing connection, and records the repair only when Plaid confirms it", async () => {
    state.outcomes.createBankLinkSession = { kind: "created", linkToken: "link-sandbox-update", expiresAt: "2026-09-16T13:00:00Z", mode: "reauthenticate" };
    const started = await actions.startBankLinkAction({}, form({ organizationId: ORG, connectionId: CONNECTION }));
    expect(started).toMatchObject({ success: true, mode: "reauthenticate" });
    expect(state.serviceCalls[0].input).toMatchObject({ connectionId: CONNECTION });

    state.serviceCalls = [];
    state.audits = [];
    const finished = await actions.completeBankReauthAction({}, form({ organizationId: ORG, connectionId: CONNECTION }));
    expect(finished).toMatchObject({ success: true, message: expect.stringContaining("Reconnected") });
    expect(state.serviceCalls[0]).toEqual({ name: "completeBankReauth", input: { organizationId: ORG, connectionId: CONNECTION, userId: USER } });
    expect(state.audits[0]).toMatchObject({ action: "bank_connection.reauthenticated" });
  });

  it("does not claim a repair the provider still reports as broken", async () => {
    for (const [outcome, pattern] of [
      [{ kind: "still_requires_reauth" }, /still needs you to sign in/],
      [{ kind: "revoked" }, /withdrawn at the bank/],
      [{ kind: "provider_error" }, /still reports a problem/],
      [{ kind: "credential_unavailable" }, /can't be read/],
    ] as [Record<string, unknown>, RegExp][]) {
      state.outcomes.completeBankReauth = outcome;
      state.audits = [];
      const result = await actions.completeBankReauthAction({}, form({ organizationId: ORG, connectionId: CONNECTION }));
      expect(result.success, JSON.stringify(outcome)).toBeUndefined();
      expect(result.error).toMatch(pattern);
      expect(state.audits).toEqual([]);
    }
  });

  it("lets only an owner or admin repair a connection", async () => {
    for (const role of ["accountant", "manager", "employee", "viewer"]) {
      state.role = role;
      state.serviceCalls = [];
      expect((await actions.completeBankReauthAction({}, form({ organizationId: ORG, connectionId: CONNECTION }))).error).toMatch(/owner or admin/);
      expect(state.serviceCalls).toEqual([]);
    }
  });
});

describe("results people see", () => {
  it("passes the not-configured message through for a refresh", async () => {
    const result = await actions.requestBankSyncAction({}, form({ organizationId: ORG, connectionId: CONNECTION }));
    expect(result.error).toMatch(/No bank connection provider is configured/);
  });

  it("explains a currency refusal without converting anything", async () => {
    state.outcomes.linkExternalAccount = { kind: "refused", reason: "CURRENCY_MISMATCH" };
    expect((await actions.linkExternalAccountAction({}, form({ organizationId: ORG, linkedAccountId: LINKED, target: ACCOUNT }))).error).toMatch(/never converts currencies/);
  });

  it("does not claim a disconnect that did not happen", async () => {
    state.outcomes.disconnectBankConnection = { kind: "credential_destroy_failed" };
    const result = await actions.disconnectBankConnectionAction({}, form({ organizationId: ORG, connectionId: CONNECTION, confirm: "disconnect" }));
    expect(result.success).toBeUndefined();
    expect(result.error).toMatch(/left as it was/);
    expect(state.audits).toEqual([]);
  });

  it("audits a real disconnect with statuses only", async () => {
    await actions.disconnectBankConnectionAction({}, form({ organizationId: ORG, connectionId: CONNECTION, confirm: "disconnect" }));
    expect(state.audits).toEqual([{ organizationId: ORG, action: "bank_connection.disconnected", resourceType: "bank_connection", resourceId: CONNECTION, metadata: { previousStatus: "ACTIVE", providerRevoked: null } }]);
  });
});
