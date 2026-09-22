import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cross-site request forgery, refused at the proxy (ZAP "Absence of Anti-CSRF
 * Tokens", 2026-09-20). See src/lib/security/request-origin.ts for the
 * reasoning.
 *
 * Two layers of test: the decision itself, as a pure function, across every
 * header combination a browser or a server can send; and the real `proxy()`
 * with only Supabase replaced, to prove the decision is enforced before the
 * session is touched and that nothing legitimate is caught by it.
 */

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    getUserCalls: 0,
    user: null as { id: string } | null,
    cookieOptions: undefined as unknown,
    events: [] as unknown[],
  };
});

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, options: { cookieOptions?: unknown }) => {
    state.cookieOptions = options.cookieOptions;
    return {
      auth: {
        getUser: async () => {
          state.getUserCalls++;
          return { data: { user: state.user } };
        },
      },
    };
  },
}));

vi.mock("@/lib/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability")>()),
  reportEvent: (...args: unknown[]) => void state.events.push(args),
}));

const { checkRequestOrigin, isCrossSiteEndpoint } = await import("@/lib/security/request-origin");
const { proxy } = await import("@/proxy");

const SELF = "https://countorra.com";
const allowedOrigins = [SELF];
const decide = (overrides: Partial<Parameters<typeof checkRequestOrigin>[0]>) =>
  checkRequestOrigin({ method: "POST", pathname: "/login", secFetchSite: null, origin: null, allowedOrigins, ...overrides });

describe("the decision", () => {
  it("never interferes with safe methods, whatever their origin", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(decide({ method, secFetchSite: "cross-site", origin: "https://evil.example" }).allowed, method).toBe(true);
    }
  });

  it("refuses every unsafe method sent cross-site", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(decide({ method, secFetchSite: "cross-site" }), method).toEqual({ allowed: false, reason: "cross-site-fetch" });
    }
  });

  it("accepts a same-origin request from this site's own pages", () => {
    expect(decide({ secFetchSite: "same-origin", origin: SELF }).allowed).toBe(true);
  });

  it("refuses same-site: a sibling subdomain is a different application", () => {
    expect(decide({ secFetchSite: "same-site", origin: "https://status.countorra.com" }).allowed).toBe(false);
  });

  it("refuses `none` for a state change — it describes a typed URL or bookmark, which cannot POST", () => {
    expect(decide({ secFetchSite: "none" }).allowed).toBe(false);
  });

  it("trusts Fetch Metadata over Origin: a matching Origin cannot rescue a cross-site fetch", () => {
    expect(decide({ secFetchSite: "cross-site", origin: SELF }).allowed).toBe(false);
  });

  it("falls back to Origin for browsers that predate Fetch Metadata", () => {
    expect(decide({ origin: SELF }).allowed).toBe(true);
    expect(decide({ origin: "https://evil.example" })).toEqual({ allowed: false, reason: "foreign-origin" });
    // Lookalikes are not prefixes of the real thing.
    expect(decide({ origin: "https://countorra.com.evil.example" }).allowed).toBe(false);
    expect(decide({ origin: "http://countorra.com" }).allowed).toBe(false);
  });

  it("refuses the opaque origin `null` (sandboxed frames, data: URLs, privacy redirects)", () => {
    expect(decide({ origin: "null" }).allowed).toBe(false);
  });

  it("lets through a caller with no browser headers at all: it carries no victim's cookies", () => {
    expect(decide({}).allowed).toBe(true);
  });

  it("exempts only endpoints that authenticate their caller and never read the session", () => {
    expect(isCrossSiteEndpoint("/api/stripe/webhook")).toBe(true);
    expect(isCrossSiteEndpoint("/api/bank-connections/webhooks/plaid")).toBe(true);
    expect(isCrossSiteEndpoint("/unsubscribe")).toBe(true);
    // Everything else, including neighbours of the exempt paths, is checked.
    for (const path of ["/api/stripe/webhook/extra", "/api/stripe", "/api/bank-connections/worker", "/app/x/settings", "/login", "/unsubscribe-all", "/auth/callback"]) {
      expect(isCrossSiteEndpoint(path), path).toBe(false);
    }
    expect(decide({ pathname: "/api/stripe/webhook", secFetchSite: "cross-site" }).allowed).toBe(true);
  });
});

// ── The real proxy ────────────────────────────────────────────────────────

function request(pathname: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(new URL(pathname, "http://localhost:3000"), { method: init.method ?? "GET", headers: init.headers });
}

beforeEach(() => {
  state.getUserCalls = 0;
  state.user = null;
  state.cookieOptions = undefined;
  state.events = [];
});

describe("the proxy enforces it", () => {
  it.each([
    ["sign-in (a login CSRF)", "/login"],
    ["account changes", "/app/11111111-1111-4111-8111-111111111111/settings"],
    ["financial mutations", "/app/11111111-1111-4111-8111-111111111111/transactions"],
    ["the bank sync worker", "/api/bank-connections/worker"],
  ])("refuses a cross-site POST to %s with 403, before the session is touched", async (_label, path) => {
    const response = await proxy(request(path, { method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }));
    expect(response.status).toBe(403);
    expect(state.getUserCalls).toBe(0);
    // Recorded for monitoring, without the origin or any identifier.
    expect(JSON.stringify(state.events)).toContain("security.cross_site_request_refused");
    expect(JSON.stringify(state.events)).not.toContain("evil.example");
  });

  it("passes a same-origin Server Action through to Next.js", async () => {
    const response = await proxy(
      request("/login", { method: "POST", headers: { origin: "http://localhost:3000", "sec-fetch-site": "same-origin", "next-action": "abc" } }),
    );
    expect(response.status).toBe(200);
    expect(state.getUserCalls).toBe(1);
  });

  it("accepts the configured app origin even when the request arrived on another host name", async () => {
    // Behind a proxy or a Vercel alias the request's own origin can differ
    // from NEXT_PUBLIC_APP_URL; both are this deployment.
    const req = new NextRequest(new URL("/login", "http://127.0.0.1:3000"), { method: "POST", headers: { origin: "http://localhost:3000" } });
    expect((await proxy(req)).status).toBe(200);
  });

  it("leaves cross-site GET navigations alone — following a link into the app must keep working", async () => {
    const response = await proxy(request("/login", { headers: { "sec-fetch-site": "cross-site" } }));
    expect(response.status).toBe(200);
  });

  it("still redirects a signed-out visitor away from /app", async () => {
    const response = await proxy(request("/app/x/dashboard"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login?redirectTo=%2Fapp%2Fx%2Fdashboard");
  });
});
