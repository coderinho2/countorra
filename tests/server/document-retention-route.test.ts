import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE RETENTION ENDPOINT: /api/documents/retention
 *
 * What a scheduler — Vercel Cron, another host, or a person with curl — can
 * and cannot make this deployment do. On this deployment there is no
 * CRON_SECRET, so the endpoint behaves as if it did not exist; the cases below
 * configure one in this PROCESS only, a test value and never a real
 * credential, to check the authorization boundary itself.
 */

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  return {
    cronSecret: null as string | null,
    envThrows: false,
    rateLimited: false,
    rateLimitCalls: 0,
    rateLimitGroup: null as string | null,
    sweeps: 0,
    sweepThrows: false,
    adminClients: 0,
    events: [] as { name: string; detail: Record<string, unknown> }[],
  };
});

vi.mock("@/lib/server-env", () => ({
  serverEnv: () => {
    if (state.envThrows) throw new Error("half-configured environment");
    return { CRON_SECRET: state.cronSecret ?? undefined };
  },
}));

vi.mock("@/server/security/rate-limit", () => ({
  clientAddress: async () => "203.0.113.7",
  enforceRateLimit: async (group: string) => {
    state.rateLimitCalls += 1;
    state.rateLimitGroup = group;
    return state.rateLimited ? { allowed: false, retryAfterSeconds: 42, message: "slow down", degraded: false } : { allowed: true, retryAfterSeconds: 0, message: null, degraded: false };
  },
}));

vi.mock("@/server/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminClients += 1;
    return {};
  },
}));

vi.mock("@/server/documents/retention", () => ({
  sweepExpiredIdentityOriginals: async () => {
    state.sweeps += 1;
    if (state.sweepThrows) throw new Error("storage unavailable");
    return { considered: 3, filesRemoved: 2, rowsMarked: 3, failed: 0, remaining: false };
  },
}));

vi.mock("@/lib/observability", () => ({
  reportEvent: (name: string, context: { detail?: Record<string, unknown> }) => state.events.push({ name, detail: context.detail ?? {} }),
  reportError: () => {},
}));

const route = await import("@/app/api/documents/retention/route");

const SECRET = "test-cron-secret-not-a-real-one-0123456789";

const call = (headers: Record<string, string> = {}, method: "GET" | "POST" = "GET") =>
  method === "GET" ? route.GET(new Request("https://example.test/api/documents/retention", { headers })) : route.POST(new Request("https://example.test/api/documents/retention", { method: "POST", headers }));

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

beforeEach(() => {
  state.cronSecret = null;
  state.envThrows = false;
  state.rateLimited = false;
  state.rateLimitCalls = 0;
  state.sweeps = 0;
  state.sweepThrows = false;
  state.adminClients = 0;
  state.events = [];
});

describe("a deployment with no cron secret", () => {
  it("answers 404, so a caller cannot tell the route exists", async () => {
    const response = await call(bearer(SECRET));
    expect(response.status).toBe(404);
    expect(state.sweeps).toBe(0);
  });

  it("answers 404 when the environment cannot be read at all, rather than opening up", async () => {
    state.envThrows = true;
    expect((await call(bearer(SECRET))).status).toBe(404);
    expect(state.sweeps).toBe(0);
  });
});

describe("authorization", () => {
  beforeEach(() => {
    state.cronSecret = SECRET;
  });

  it("refuses a caller with no credential", async () => {
    expect((await call()).status).toBe(401);
    expect(state.sweeps).toBe(0);
  });

  it("refuses a wrong secret", async () => {
    expect((await call(bearer("wrong-secret-entirely"))).status).toBe(401);
    expect(state.sweeps).toBe(0);
  });

  it("refuses a secret that is merely a prefix of the real one", async () => {
    expect((await call(bearer(SECRET.slice(0, 10)))).status).toBe(401);
  });

  it("accepts the deployment secret as a bearer token, which is what cron sends", async () => {
    const response = await call(bearer(SECRET));
    expect(response.status).toBe(200);
    expect(state.sweeps).toBe(1);
  });

  it("accepts POST on the same terms", async () => {
    expect((await call(bearer(SECRET), "POST")).status).toBe(200);
  });

  it("bounds guessing BEFORE it compares, so attempts are not free", async () => {
    state.rateLimited = true;
    const response = await call(bearer("anything"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    // The limiter ran; the comparison never did.
    expect(state.rateLimitCalls).toBe(1);
    expect(state.sweeps).toBe(0);
  });

  it("uses its own limiter bucket rather than the bank worker's", async () => {
    await call(bearer(SECRET));
    expect(state.rateLimitGroup).toBe("documentRetention");
  });

  it("records a refusal as a security event", async () => {
    await call(bearer("wrong"));
    expect(state.events.map((entry) => entry.name)).toContain("documents.retention_unauthorized");
  });
});

describe("what it does once authorized", () => {
  beforeEach(() => {
    state.cronSecret = SECRET;
  });

  it("sweeps with an admin client, because it acts for every organization", async () => {
    await call(bearer(SECRET));
    expect(state.adminClients).toBe(1);
  });

  it("answers with counters and nothing else", async () => {
    const body = (await (await call(bearer(SECRET))).json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, considered: 3, filesRemoved: 2, rowsMarked: 3, failed: 0, remaining: false });
  });

  it("names no organization, document or path in what it reports", async () => {
    await call(bearer(SECRET));
    const event = state.events.find((entry) => entry.name === "documents.retention_invocation");
    expect(event).toBeDefined();
    expect(Object.keys(event!.detail).sort()).toEqual(["considered", "durationMs", "failed", "filesRemoved", "invoker", "remaining", "rowsMarked"]);
  });

  it("answers 503 when the sweep fails, without leaking why", async () => {
    state.sweepThrows = true;
    const response = await call(bearer(SECRET));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "sweep_failed" });
  });
});
