import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Health, readiness and internal operational reporting
 * (src/server/operations/health.ts, src/app/api/health, src/app/api/operations).
 * Public answers carry a status and nothing else; the breakdown and the
 * operational summary need OPERATIONS_TOKEN. The database side of
 * operations_summary() — service role only, counts only — is in
 * tests/rls/plaid-first-ledger.test.ts.
 */

const TOKEN = "t".repeat(40);

const state = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  envError: null as Error | null,
  rpc: {} as Record<string, () => Promise<{ data: unknown; error: { code?: string } | null }>>,
  rpcCalls: [] as { name: string; args: unknown }[],
  events: [] as unknown[][],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server-env", () => ({
  serverEnv: () => {
    if (state.envError) throw state.envError;
    return state.env;
  },
}));
vi.mock("@/server/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (name: string, args: unknown) => {
      state.rpcCalls.push({ name, args });
      return state.rpc[name]();
    },
  }),
}));
vi.mock("@/server/billing/stripe-config", () => ({ isBillingConfigured: () => true }));
vi.mock("@/server/bank-connections/providers", () => ({ bankProviderConfigured: () => false }));
vi.mock("@/server/email/config", () => ({ emailConfig: () => null }));
vi.mock("@/lib/observability", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/observability")>();
  return {
    ...real,
    reportEvent: (...args: unknown[]) => void state.events.push(args),
    reportError: (...args: unknown[]) => void state.events.push(args),
    measureDependency: async <T,>(dependency: string, operation: string, context: { requestId?: string }, fn: () => Promise<T>) => {
      const started = performance.now();
      try {
        const result = await fn();
        state.events.push(["dependency.call", { ...context, detail: { dependency, operation, outcome: "ok", durationMs: Math.round(performance.now() - started) } }]);
        return result;
      } catch (error) {
        state.events.push(["dependency.failed", { ...context, detail: { dependency, operation, outcome: "failed" } }]);
        throw error;
      }
    },
  };
});

const health = await import("@/server/operations/health");
const { GET: live } = await import("@/app/api/health/route");
const { GET: ready } = await import("@/app/api/health/ready/route");
const { GET: summary } = await import("@/app/api/operations/summary/route");

const req = (path: string, token?: string) => new Request(`http://localhost:3000${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

beforeEach(() => {
  health.__resetReadinessCacheForTests();
  state.env = { OPERATIONS_TOKEN: TOKEN, BANK_SYNC_WORKER_SECRET: "w".repeat(32), CRON_SECRET: "w".repeat(32), SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" };
  state.envError = null;
  state.rpcCalls = [];
  state.events = [];
  state.rpc = {
    operations_schema_version: async () => ({ data: health.EXPECTED_SCHEMA_VERSION, error: null }),
    operations_summary: async () => ({ data: { aiRequests: 3, bankWebhooks: { PROCESSED: 2 } }, error: null }),
  };
});

describe("liveness", () => {
  it("answers ok with no dependency checks and nothing else", async () => {
    const response = live(req("/api/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("readiness", () => {
  it("is 200 and says only 'ready' to the public", async () => {
    const response = await ready(req("/api/health/ready"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });

  it("gives operators the breakdown — booleans and versions, never a secret", async () => {
    const body = await (await ready(req("/api/health/ready", TOKEN))).json();
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.schema).toEqual({ ok: true, expected: "0056", actual: "0056" });
    expect(body.integrations).toEqual({ stripe: true, plaid: false, email: false, bankWorkerCron: true, operationsToken: true });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toContain("service-role-secret");
  });

  it("ignores a wrong token and answers as to the public", async () => {
    expect(await (await ready(req("/api/health/ready", "x".repeat(40)))).json()).toEqual({ status: "ready" });
  });

  it("is 503 when the database is behind this build's migrations", async () => {
    state.rpc.operations_schema_version = async () => ({ data: null, error: { code: "PGRST202" } });
    const response = await ready(req("/api/health/ready", TOKEN));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.schema).toMatchObject({ ok: false, actual: null });
  });

  it("is 503 when the database is unreachable", async () => {
    state.rpc.operations_schema_version = async () => {
      throw new Error("fetch failed");
    };
    const response = await ready(req("/api/health/ready", TOKEN));
    expect(response.status).toBe(503);
    expect((await response.json()).checks.database).toMatchObject({ ok: false, error: "unreachable" });
  });

  it("is 503, without touching the database, when configuration is broken", async () => {
    state.envError = new Error("Plaid is partly configured: PLAID_ENV is missing.");
    const response = await ready(req("/api/health/ready"));
    expect(response.status).toBe(503);
    expect(state.rpcCalls).toEqual([]);
  });

  it("computes at most once per 15 seconds, so the public endpoint cannot load the database", async () => {
    await ready(req("/api/health/ready"));
    await ready(req("/api/health/ready"));
    await ready(req("/api/health/ready"));
    expect(state.rpcCalls.filter((c) => c.name === "operations_schema_version")).toHaveLength(1);
  });

  it("times the database check and records it with the request id", async () => {
    await ready(new Request("http://localhost:3000/api/health/ready", { headers: { "x-request-id": "req-12345678" } }));
    const call = state.events.find((e) => e[0] === "dependency.call") as [string, { requestId?: string; detail: Record<string, unknown> }] | undefined;
    expect(call?.[1].requestId).toBe("req-12345678");
    expect(call?.[1].detail).toMatchObject({ dependency: "database", operation: "operations_schema_version", outcome: "ok" });
    expect(typeof call?.[1].detail.durationMs).toBe("number");
  });
});

describe("the internal operations summary", () => {
  it("does not exist when no operations token is configured", async () => {
    state.env = {};
    expect((await summary(req("/api/operations/summary", TOKEN))).status).toBe(404);
  });

  it("refuses a missing or wrong token, and records the attempt", async () => {
    expect((await summary(req("/api/operations/summary"))).status).toBe(401);
    expect((await summary(req("/api/operations/summary", "x".repeat(40)))).status).toBe(401);
    expect(state.events.some((e) => e[0] === "operations.unauthorized")).toBe(true);
    expect(state.rpcCalls).toEqual([]);
  });

  it("returns the database's counts for the requested window", async () => {
    const response = await summary(req("/api/operations/summary?hours=6", TOKEN));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ windowHours: 6, summary: { aiRequests: 3, bankWebhooks: { PROCESSED: 2 } } });
    const since = new Date((state.rpcCalls[0].args as { p_since: string }).p_since).getTime();
    expect(Math.abs(Date.now() - 6 * 3_600_000 - since)).toBeLessThan(5_000);
  });

  it("clamps an out-of-range window to 24 hours", async () => {
    expect((await (await summary(req("/api/operations/summary?hours=9999", TOKEN))).json()).windowHours).toBe(24);
  });

  it("answers 503, not an error page, when the database fails", async () => {
    state.rpc.operations_summary = async () => ({ data: null, error: { code: "XX000" } });
    expect((await summary(req("/api/operations/summary", TOKEN))).status).toBe(503);
  });
});
