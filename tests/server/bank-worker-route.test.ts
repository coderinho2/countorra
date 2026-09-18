import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetObservabilitySinksForTests, registerObservabilitySink, type ReportedError } from "@/lib/observability";

/**
 * THE WORKER ENDPOINT: /api/bank-connections/worker
 *
 * What a scheduler (Vercel Cron, another host's scheduled function, a queue
 * consumer, a person with curl) can and cannot make this deployment do.
 *
 * On this deployment there is no BANK_SYNC_WORKER_SECRET and no bank provider,
 * so the endpoint behaves as if it did not exist. The tests below configure a
 * secret in this PROCESS only — a test value, never a real credential — to
 * check the authorization boundary itself.
 */

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  return {
    secret: null as string | null,
    cronSecret: null as string | null,
    heartbeatUrl: null as string | null,
    workerThrows: false,
    workerOptions: [] as Record<string, unknown>[],
    providers: [] as { id: string }[],
    dependenciesCreated: 0,
    rateLimited: false,
    rateLimitCalls: 0,
    scheduler: 0,
    worker: 0,
  };
});

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({
    BANK_SYNC_WORKER_SECRET: state.secret ?? undefined,
    CRON_SECRET: state.cronSecret ?? undefined,
    BANK_SYNC_HEARTBEAT_URL: state.heartbeatUrl ?? undefined,
  }),
}));

vi.mock("@/server/security/rate-limit", () => ({
  clientAddress: async () => "203.0.113.7",
  enforceRateLimit: async (group: string) => {
    state.rateLimitCalls += 1;
    expect(group).toBe("bankWorker");
    return state.rateLimited ? { allowed: false, retryAfterSeconds: 42, message: "slow down", degraded: false } : { allowed: true, retryAfterSeconds: 0, message: null, degraded: false };
  },
}));

vi.mock("@/server/bank-connections/providers", () => ({
  configuredBankProviders: () => state.providers,
}));

vi.mock("@/server/bank-connections/runtime", () => ({
  productionBankDependencies: () => {
    state.dependenciesCreated += 1;
    return { providers: state.providers } as never;
  },
}));

vi.mock("@/server/bank-connections/worker", () => ({
  runBankSyncScheduler: async () => {
    state.scheduler += 1;
    return { reclaimedLeases: 1, connectionsConsidered: 2, jobsCreated: 1, alreadyActive: 1, duplicates: 0, skipped: 0, durationMs: 12 };
  },
  runBankSyncWorker: async (_deps: unknown, options: Record<string, unknown> = {}) => {
    state.worker += 1;
    state.workerOptions.push(options);
    if (state.workerThrows) throw new Error("database unreachable");
    return {
      workerId: "worker-abcdefgh",
      providerConfigured: true,
      claimed: 1,
      executed: 1,
      succeeded: 1,
      failed: 0,
      retrying: 0,
      cancelled: 0,
      abandoned: 0,
      continuations: 0,
      stoppedBecause: "queue_empty",
      durationMs: 34,
      jobs: [{ jobId: "job-1", connectionId: "connection-1", organizationId: "organization-1", trigger: "SCHEDULED", attempt: 1, outcome: "succeeded", failureCategory: null, continuationJobId: null, durationMs: 30 }],
    };
  },
}));

const { GET, POST, maxDuration } = await import("@/app/api/bank-connections/worker/route");

const SECRET = "test-worker-secret-0123456789abcdef";

const call = (init: { method?: "GET" | "POST"; headers?: Record<string, string>; query?: string } = {}) => {
  const request = new Request(`http://localhost/api/bank-connections/worker${init.query ?? ""}`, { method: init.method ?? "POST", headers: init.headers });
  return init.method === "GET" ? GET(request) : POST(request);
};

let events: ReportedError[] = [];
const fetchCalls: { url: string; method: string }[] = [];
let fetchBehaviour: "ok" | "fail" | "reject" = "ok";

beforeEach(() => {
  events = [];
  fetchCalls.length = 0;
  fetchBehaviour = "ok";
  registerObservabilitySink({ name: "test", capture: (record) => void events.push(record) });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (url: string, init: { method?: string } = {}) => {
    fetchCalls.push({ url: String(url), method: init.method ?? "GET" });
    if (fetchBehaviour === "reject") throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
    return new Response(null, { status: fetchBehaviour === "ok" ? 200 : 500 });
  });
  state.cronSecret = null;
  state.heartbeatUrl = null;
  state.workerThrows = false;
  state.workerOptions = [];
  state.secret = null;
  state.providers = [];
  state.dependenciesCreated = 0;
  state.rateLimited = false;
  state.rateLimitCalls = 0;
  state.scheduler = 0;
  state.worker = 0;
});

describe("without a worker secret", () => {
  it("answers 404 for every caller, and touches nothing", async () => {
    for (const method of ["POST", "GET"] as const) {
      const response = await call({ method, headers: { authorization: `Bearer ${SECRET}` } });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_configured" });
    }
    expect(state.dependenciesCreated).toBe(0);
    expect(state.scheduler + state.worker).toBe(0);
    // Not even a rate-limit counter: an endpoint that does not exist should
    // not be distinguishable from one that is merely idle.
    expect(state.rateLimitCalls).toBe(0);
  });
});

describe("with a worker secret", () => {
  beforeEach(() => {
    state.secret = SECRET;
    state.providers = [{ id: "fixture" }];
  });

  it("refuses a caller with no secret, the wrong secret, or a near miss", async () => {
    const attempts: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { authorization: `Bearer ${SECRET}x` }, { authorization: `Bearer ${SECRET.slice(0, -1)}` }, { "x-bank-worker-secret": "nope" }, { authorization: SECRET }];
    for (const headers of attempts) {
      const response = await call({ headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(state.dependenciesCreated).toBe(0);
    expect(state.scheduler + state.worker).toBe(0);
  });

  it("bounds guessing before it compares anything", async () => {
    state.rateLimited = true;
    const response = await call({ headers: { authorization: "Bearer wrong" } });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(state.dependenciesCreated).toBe(0);
  });

  it("schedules and works for an authorized caller, by either header", async () => {
    const accepted: Record<string, string>[] = [{ authorization: `Bearer ${SECRET}` }, { "x-bank-worker-secret": SECRET }];
    for (const headers of accepted) {
      const response = await call({ headers });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, providerConfigured: true, mode: "both" });
      expect(body.scheduled).toEqual({ reclaimedLeases: 1, considered: 2, created: 1, alreadyActive: 1, duplicates: 0, skipped: 0, durationMs: 12 });
      expect(body.worked).toEqual({ executed: 1, succeeded: 1, failed: 0, retrying: 0, cancelled: 0, abandoned: 0, continuations: 0, stoppedBecause: "queue_empty", durationMs: 34 });
    }
    expect(state.scheduler).toBe(2);
    expect(state.worker).toBe(2);
  });

  it("answers a cron's GET the same way it answers a POST", async () => {
    const response = await call({ method: "GET", headers: { authorization: `Bearer ${SECRET}` } });
    expect(response.status).toBe(200);
    expect(state.scheduler).toBe(1);
    expect(state.worker).toBe(1);
  });

  it("does only what the mode asks for", async () => {
    await call({ headers: { authorization: `Bearer ${SECRET}` }, query: "?mode=schedule" });
    expect([state.scheduler, state.worker]).toEqual([1, 0]);

    await call({ headers: { authorization: `Bearer ${SECRET}` }, query: "?mode=work" });
    expect([state.scheduler, state.worker]).toEqual([1, 1]);

    // Anything else is the default, rather than an error a cron cannot fix.
    await call({ headers: { authorization: `Bearer ${SECRET}` }, query: "?mode=nonsense" });
    expect([state.scheduler, state.worker]).toEqual([2, 2]);
  });

  it("says plainly when the deployment has no bank provider, and does nothing", async () => {
    state.providers = [];
    const response = await call({ headers: { authorization: `Bearer ${SECRET}` } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, providerConfigured: false, scheduled: null, worked: null });
    expect(state.dependenciesCreated).toBe(0);
    expect(state.scheduler + state.worker).toBe(0);
  });

  it("returns counters only — no organization, connection, institution or secret", async () => {
    const response = await call({ headers: { authorization: `Bearer ${SECRET}` } });
    const text = await response.text();

    expect(text).not.toContain(SECRET);
    for (const forbidden of ["organization", "connection", "workerId", "worker-abcdefgh", "job-1", "institution", "token"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

afterEach(() => {
  __resetObservabilitySinksForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HEARTBEAT = "https://heartbeat.example.test/ping/0c5a9e2c-secret-path";
const named = (name: string) => events.filter((event) => event.errorName === name);

describe("Vercel Cron", () => {
  beforeEach(() => {
    state.secret = SECRET;
    state.providers = [{ id: "fixture" }];
  });

  it("is authorized by the same secret as everyone else, and recorded as the cron", async () => {
    state.cronSecret = SECRET;
    const response = await call({ method: "GET", headers: { authorization: `Bearer ${SECRET}`, "user-agent": "vercel-cron/1.0" } });

    expect(response.status).toBe(200);
    expect(named("bank.worker_invocation")[0].detail).toMatchObject({ invoker: "vercel-cron", mode: "both", executed: 1 });
  });

  it("gets no exemption: the vercel-cron user agent without the secret is refused", async () => {
    const response = await call({ method: "GET", headers: { "user-agent": "vercel-cron/1.0" } });
    expect(response.status).toBe(401);
    expect(state.scheduler + state.worker).toBe(0);
  });

  it("is rate limited like any caller", async () => {
    state.rateLimited = true;
    const response = await call({ method: "GET", headers: { authorization: `Bearer ${SECRET}`, "user-agent": "vercel-cron/1.0" } });
    expect(response.status).toBe(429);
    expect(state.scheduler + state.worker).toBe(0);
  });

  it("reports a CRON_SECRET that differs from the worker secret — the silent-stop misconfiguration", async () => {
    state.cronSecret = "a-different-cron-secret-0123456789abcdef";
    const response = await call({ method: "GET", headers: { authorization: `Bearer ${state.cronSecret}`, "user-agent": "vercel-cron/1.0" } });

    expect(response.status).toBe(401);
    const mismatch = named("bank.worker_cron_secret_mismatch");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].severity).toBe("error");
    // Neither value is ever in the record.
    expect(JSON.stringify(events)).not.toContain(state.cronSecret);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("never raises that alarm for a stranger's wrong guess", async () => {
    state.cronSecret = "a-different-cron-secret-0123456789abcdef";
    await call({ headers: { authorization: "Bearer a-random-guess" } });
    expect(named("bank.worker_unauthorized")).toHaveLength(1);
    expect(named("bank.worker_cron_secret_mismatch")).toHaveLength(0);
  });
});

describe("the time budget", () => {
  beforeEach(() => {
    state.secret = SECRET;
    state.providers = [{ id: "fixture" }];
  });

  it("declares a 60-second function limit", () => {
    expect(maxDuration).toBe(60);
  });

  it("hands the worker a budget that ends 30 seconds after the request began", async () => {
    const before = Date.now();
    await call({ headers: { authorization: `Bearer ${SECRET}` } });
    const after = Date.now();

    const [options] = state.workerOptions;
    expect(Number(options.maxDurationMs)).toBeGreaterThan(0);
    expect(Number(options.maxDurationMs)).toBeLessThanOrEqual(30_000);
    expect(Number(options.pageDeadline)).toBeGreaterThanOrEqual(before + 30_000);
    expect(Number(options.pageDeadline)).toBeLessThanOrEqual(after + 30_000);
  });
});

describe("the heartbeat", () => {
  beforeEach(() => {
    state.secret = SECRET;
    state.providers = [{ id: "fixture" }];
    state.heartbeatUrl = HEARTBEAT;
  });

  it("pings after a successful invocation, with no body", async () => {
    const response = await call({ headers: { authorization: `Bearer ${SECRET}` } });
    expect(response.status).toBe(200);
    expect(fetchCalls).toEqual([{ url: HEARTBEAT, method: "GET" }]);
  });

  it("pings when there is no provider too — the cron itself is alive", async () => {
    state.providers = [];
    await call({ headers: { authorization: `Bearer ${SECRET}` } });
    expect(fetchCalls).toHaveLength(1);
  });

  it("never pings for a refused, rate-limited or failed invocation", async () => {
    await call({ headers: { authorization: "Bearer wrong" } });
    state.rateLimited = true;
    await call({ headers: { authorization: `Bearer ${SECRET}` } });
    state.rateLimited = false;
    state.workerThrows = true;
    const failed = await call({ headers: { authorization: `Bearer ${SECRET}` } });

    expect(failed.status).toBe(503);
    expect(fetchCalls).toEqual([]);
  });

  it("never pings when the endpoint is not configured", async () => {
    state.secret = null;
    await call({ headers: { authorization: `Bearer ${SECRET}` } });
    expect(fetchCalls).toEqual([]);
  });

  it("cannot change the response when the monitor is down, and never logs its URL", async () => {
    for (const behaviour of ["fail", "reject"] as const) {
      fetchBehaviour = behaviour;
      const response = await call({ headers: { authorization: `Bearer ${SECRET}` } });
      expect(response.status).toBe(200);
    }
    expect(named("bank.worker_heartbeat_failed")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("heartbeat.example.test");
    expect(JSON.stringify(events)).not.toContain("secret-path");
  });
});
