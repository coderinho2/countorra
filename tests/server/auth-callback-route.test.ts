import { createHash } from "node:crypto";
import { AuthApiError, AuthPKCECodeVerifierMissingError, isAuthPKCECodeVerifierMissingError } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /auth/callback, end to end through the real route handler.
 *
 * Two layers are pinned:
 *
 *   THE ROUTE — which page each kind of visit lands on, and that a link
 *   Supabase already refused is never exchanged.
 *
 *   THE MECHANISM — the real @supabase/ssr server client: without a PKCE
 *   verifier cookie the exchange fails with AuthPKCECodeVerifierMissingError
 *   before any network request; and a reset requested in a browser leaves a
 *   verifier there that the exchange sends, reports as recovery, and cannot
 *   use twice. If a library upgrade changes any of that, these tests say so
 *   before users do.
 */

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return { exchangeResult: { error: null as unknown, redirectType: null as string | null }, exchangeCalls: [] as string[] };
});

vi.mock("@/server/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async (code: string) => {
        state.exchangeCalls.push(code);
        return { data: { redirectType: state.exchangeResult.redirectType }, error: state.exchangeResult.error };
      },
    },
  }),
}));

const { GET } = await import("@/app/auth/callback/route");

async function visit(query: string) {
  const response = await GET(new Request(`http://localhost:3000/auth/callback${query}`));
  const location = response.headers.get("location") ?? "";
  return { status: response.status, location, url: new URL(location) };
}

beforeEach(() => {
  state.exchangeResult = { error: null, redirectType: null };
  state.exchangeCalls = [];
});

describe("the callback route", () => {
  it("signs in and redirects to the app when the exchange succeeds", async () => {
    const { status, url } = await visit("?code=valid-code");
    expect(status).toBe(307);
    expect(url.pathname).toBe("/app");
    expect(state.exchangeCalls).toEqual(["valid-code"]);
  });

  it("sends a confirmation opened in another browser to sign in — not to 'link expired'", async () => {
    state.exchangeResult = { error: new AuthPKCECodeVerifierMissingError(), redirectType: null };
    const { url } = await visit("?code=valid-code");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("emailConfirmed")).toBe("1");
    expect(url.searchParams.get("linkExpired")).toBeNull();
  });

  it("keeps 'link expired' for an exchange that genuinely fails", async () => {
    state.exchangeResult = { error: new AuthApiError("invalid flow state", 404, "flow_state_not_found"), redirectType: null };
    const { url } = await visit("?code=spent-code");
    expect(url.searchParams.get("linkExpired")).toBe("1");
  });

  it("does not exchange a link Supabase already refused", async () => {
    // The live second click: Supabase appends these instead of a code.
    const { url } = await visit("?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
    expect(url.searchParams.get("linkExpired")).toBe("1");
    expect(state.exchangeCalls).toEqual([]);
  });

  it("does not exchange when a provider error arrives alongside a code", async () => {
    await visit("?code=valid-code&error_code=otp_expired");
    expect(state.exchangeCalls).toEqual([]);
  });

  it("treats a visit with no code as an invalid link", async () => {
    const { url } = await visit("");
    expect(url.searchParams.get("linkExpired")).toBe("1");
    expect(state.exchangeCalls).toEqual([]);
  });

  it("never redirects off this origin", async () => {
    for (const payload of ["//evil.com", "@evil.com/", "https://evil.com"]) {
      const { url } = await visit(`?code=valid-code&redirectTo=${encodeURIComponent(payload)}`);
      expect(url.origin, payload).toBe("http://localhost:3000");
    }
  });

  it("honours a safe same-origin redirect", async () => {
    const { url } = await visit(`?code=valid-code&redirectTo=${encodeURIComponent("/app/abc/tax-preparation")}`);
    expect(url.pathname).toBe("/app/abc/tax-preparation");
  });
});

describe("password recovery through the callback route", () => {
  it("exchanges a recovery code once and lands on the reset page", async () => {
    state.exchangeResult = { error: null, redirectType: "recovery" };
    const { status, location, url } = await visit("?code=recovery-code&flow=recovery");

    expect(status).toBe(307);
    expect(url.pathname).toBe("/reset-password");
    expect(state.exchangeCalls).toEqual(["recovery-code"]);
    // The code is not forwarded, and nothing token-like is put in the URL.
    expect(location).not.toContain("recovery-code");
    expect(url.search).toBe("");
  });

  it("goes to the reset page even when the link carries a redirectTo", async () => {
    state.exchangeResult = { error: null, redirectType: "recovery" };
    for (const target of ["/app/abc/settings", "//evil.com", "https://evil.com"]) {
      const { url } = await visit(`?code=recovery-code&flow=recovery&redirectTo=${encodeURIComponent(target)}`);
      expect(url.href, target).toBe("http://localhost:3000/reset-password");
    }
  });

  it("does not treat a sign-up link as recovery because the URL says so", async () => {
    // A crafted `flow=recovery` on an ordinary confirmation grants nothing.
    const { url } = await visit("?code=signup-code&flow=recovery");
    expect(url.pathname).toBe("/app");
  });

  it("recognises recovery from the exchange even without the hint", async () => {
    state.exchangeResult = { error: null, redirectType: "recovery" };
    const { url } = await visit("?code=recovery-code");
    expect(url.pathname).toBe("/reset-password");
  });

  it("sends an expired or already-used reset link to request a new one, without exchanging", async () => {
    const { url } = await visit("?flow=recovery&error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
    expect(url.pathname).toBe("/forgot-password");
    expect(url.searchParams.get("linkExpired")).toBe("1");
    expect(state.exchangeCalls).toEqual([]);
  });

  it("sends a reset link with an invalid code to request a new one", async () => {
    state.exchangeResult = { error: new AuthApiError("invalid flow state", 404, "flow_state_not_found"), redirectType: null };
    const { url } = await visit("?code=not-a-real-code&flow=recovery");
    expect(url.pathname).toBe("/forgot-password");
    expect(url.searchParams.get("linkExpired")).toBe("1");
  });

  it("explains a reset link opened in a different browser", async () => {
    state.exchangeResult = { error: new AuthPKCECodeVerifierMissingError(), redirectType: null };
    const { url } = await visit("?code=recovery-code&flow=recovery");
    expect(url.pathname).toBe("/forgot-password");
    expect(url.searchParams.get("openedElsewhere")).toBe("1");
  });

  it("handles malformed callbacks safely", async () => {
    for (const query of ["?flow=recovery", "?code=&flow=recovery", "?flow=garbage&code=", "?code=%00%0d%0a&flow=recovery&error=x"]) {
      const { status, url } = await visit(query);
      expect(status, query).toBe(307);
      expect(url.origin, query).toBe("http://localhost:3000");
      expect(["/login", "/forgot-password"], query).toContain(url.pathname);
    }
    expect(state.exchangeCalls).toEqual([]);
  });
});

// ── the real @supabase/ssr client ──────────────────────────────────────────

type Cookie = { name: string; value: string };

/** A browser's cookie jar, as the SSR client sees it through getAll/setAll. */
function cookieJar() {
  const jar = new Map<string, string>();
  return {
    jar,
    cookies: {
      getAll: (): Cookie[] => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies: { name: string; value: string; options?: { maxAge?: number } }[]) => {
        for (const { name, value, options } of cookies) {
          if (!value || options?.maxAge === 0) jar.delete(name);
          else jar.set(name, value);
        }
      },
    },
  };
}

const base64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

function fakeSession(amrMethod: string) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: "user-1", role: "authenticated", aud: "authenticated", exp: now + 3600, iat: now, session_id: "s-1", amr: [{ method: amrMethod, timestamp: now }] };
  return {
    access_token: `${base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64url(JSON.stringify(payload))}.${base64url("signature")}`,
    refresh_token: "refresh-1",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    user: { id: "user-1", aud: "authenticated", role: "authenticated", email: "someone@example.test", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  };
}

function authServer() {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    requests.push({ path: `${url.pathname}${url.search}`, body });
    const json = url.pathname.endsWith("/token") ? fakeSession("recovery") : {};
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { requests, fetch };
}

describe("the mechanism behind the live failure", () => {
  it("fails with the PKCE verifier error, before any network request, when the verifier cookie is absent", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("no network request should be made without a verifier");
    });

    // A browser that did not submit the sign-up form: it carries no
    // sb-*-code-verifier cookie at all.
    const client = createServerClient("https://example.supabase.co", "test-anon-key", {
      cookies: { getAll: () => [], setAll: () => {} },
      global: { fetch: fetchSpy as unknown as typeof fetch },
    });

    const { error } = await client.auth.exchangeCodeForSession("code-from-a-real-confirmation-link");

    expect(error).toBeInstanceOf(AuthPKCECodeVerifierMissingError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the recovery mechanism in the same browser", () => {
  it("stores a verifier when the reset is requested, sends it on exchange, reports recovery, and cannot be reused", async () => {
    const browser = cookieJar();
    const server = authServer();
    const client = () =>
      createServerClient("https://example.supabase.co", "test-anon-key", {
        cookies: browser.cookies,
        global: { fetch: server.fetch as unknown as typeof fetch },
      });

    // 1. The reset request, from this browser.
    await client().auth.resetPasswordForEmail("someone@example.test", { redirectTo: "http://localhost:3000/auth/callback?flow=recovery" });
    const recover = server.requests.find((r) => r.path.startsWith("/auth/v1/recover"));
    expect(recover?.body.code_challenge_method).toBe("s256");
    expect([...browser.jar.keys()].some((name) => name.includes("code-verifier"))).toBe(true);

    // 2. The emailed link comes back to the callback in the SAME browser.
    const first = await client().auth.exchangeCodeForSession("recovery-code");
    expect(first.error).toBeNull();
    // Returned at runtime, undeclared in auth-js's types — the route relies on it.
    expect((first.data as { redirectType?: string | null }).redirectType).toBe("recovery");

    const tokenRequests = server.requests.filter((r) => r.path.startsWith("/auth/v1/token"));
    expect(tokenRequests).toHaveLength(1);
    // The verifier sent is the one whose challenge went out with the request.
    const verifier = String(tokenRequests[0].body.code_verifier);
    expect(base64url(createHash("sha256").update(verifier).digest())).toBe(recover?.body.code_challenge);
    expect(verifier).not.toContain("/recovery");

    // 3. The same code again, in the same browser: the verifier is gone.
    const second = await client().auth.exchangeCodeForSession("recovery-code");
    expect(isAuthPKCECodeVerifierMissingError(second.error)).toBe(true);
    expect(server.requests.filter((r) => r.path.startsWith("/auth/v1/token"))).toHaveLength(1);
  });
});
