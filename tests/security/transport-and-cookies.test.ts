import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cookies, HSTS and cross-origin configuration — the remaining ZAP findings of
 * 2026-09-20: "Cookie No HttpOnly Flag", "Cookie Without Secure Flag",
 * "Strict-Transport-Security Header Not Set" and "Cross-Domain
 * Misconfiguration".
 *
 * The cookie attributes were also verified against a production build in a
 * real browser: the forgot-password flow ZAP used now sets its code-verifier
 * cookies `HttpOnly; SameSite=lax` over plain-HTTP localhost, `Secure;
 * HttpOnly; SameSite=lax` under the Vercel deployment signal, and
 * `document.cookie` is empty to page script in both.
 */

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return { cookieOptions: [] as unknown[] };
});

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, options: { cookieOptions?: unknown }) => {
    state.cookieOptions.push(options.cookieOptions);
    return { auth: { getUser: async () => ({ data: { user: null } }) } };
  },
}));
vi.mock("@/lib/observability", () => ({ reportEvent: () => {} }));

const { sessionCookieOptions } = await import("@/lib/security/session-cookies");
const { proxy } = await import("@/proxy");

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

beforeEach(() => {
  state.cookieOptions = [];
});

describe("Supabase auth cookies", () => {
  it("are HttpOnly: no page script can read a session token or code verifier", () => {
    for (const appUrl of ["https://countorra.com", "http://localhost:3000"]) {
      expect(sessionCookieOptions({ appUrl, onVercel: false }).httpOnly).toBe(true);
    }
  });

  it("are Secure on every HTTPS deployment", () => {
    expect(sessionCookieOptions({ appUrl: "https://countorra.com", onVercel: false }).secure).toBe(true);
    // Vercel is HTTPS-only, whatever the app URL says.
    expect(sessionCookieOptions({ appUrl: "http://localhost:3000", onVercel: true }).secure).toBe(true);
  });

  it("are not Secure on plain-HTTP localhost, where Safari would silently drop them", () => {
    expect(sessionCookieOptions({ appUrl: "http://localhost:3000", onVercel: false }).secure).toBe(false);
  });

  it("stay SameSite=Lax and site-wide", () => {
    expect(sessionCookieOptions({ appUrl: "https://countorra.com", onVercel: true })).toEqual({
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure: true,
    });
  });

  it("are written with these attributes by the proxy", async () => {
    await proxy(new NextRequest("http://localhost:3000/login"));
    expect(state.cookieOptions).toEqual([{ path: "/", sameSite: "lax", httpOnly: true, secure: false }]);
  });

  it("are written with the same attributes by the server client — the only other writer", () => {
    // Two writers with different attributes would each overwrite the other's
    // cookie on every refresh.
    const server = read("src/server/supabase/server.ts");
    const proxySource = read("src/proxy.ts");
    const call = 'cookieOptions: sessionCookieOptions({ appUrl: publicEnv.NEXT_PUBLIC_APP_URL, onVercel: process.env.VERCEL === "1" })';
    expect(server).toContain(call);
    expect(proxySource).toContain(call);
  });

  it("are never set anywhere else in the application", () => {
    // If a third writer appears, it has to adopt these attributes too.
    const writers = ["src/proxy.ts", "src/server/supabase/server.ts"];
    // --untracked: a brand-new file is exactly where a new writer would appear.
    const hits = execSync('git grep --untracked -lE "(cookies|cookieStore)\\.set\\(" -- src ":!*.test.ts"', { cwd: ROOT, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(hits).toEqual(writers.sort());
  });
});

// ── next.config.ts headers ───────────────────────────────────────────────

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

async function configuredHeaders(env: Record<string, string | undefined>): Promise<HeaderRule[]> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
  try {
    vi.resetModules();
    const { default: config } = await import("../../next.config");
    return (await config.headers!()) as HeaderRule[];
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const header = (rules: HeaderRule[], source: string, key: string) =>
  rules.find((rule) => rule.source === source)?.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

afterEach(() => vi.resetModules());

describe("HSTS", () => {
  it("is sent in production", async () => {
    const rules = await configuredHeaders({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://countorra.com" });
    expect(header(rules, "/:path*", "Strict-Transport-Security")).toBe("max-age=63072000");
  });

  it("does not commit subdomains or request preloading until they are verified", async () => {
    const rules = await configuredHeaders({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://countorra.com" });
    const value = header(rules, "/:path*", "Strict-Transport-Security")!;
    expect(value).not.toMatch(/includeSubDomains/i);
    expect(value).not.toMatch(/preload/i);
    // At least a year — the floor browsers and the preload list both expect.
    expect(Number(value.match(/max-age=(\d+)/)![1])).toBeGreaterThanOrEqual(31536000);
  });

  it("is not sent by preview deployments or a local server", async () => {
    for (const VERCEL_ENV of ["preview", "development", undefined]) {
      const rules = await configuredHeaders({ VERCEL_ENV });
      expect(header(rules, "/:path*", "Strict-Transport-Security"), String(VERCEL_ENV)).toBeUndefined();
    }
  });

  it("applies to every response, static files included", async () => {
    const rules = await configuredHeaders({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://countorra.com" });
    expect(rules[0]!.source).toBe("/:path*");
  });
});

describe("cross-origin configuration", () => {
  it("never grants every origin, on any path", async () => {
    const rules = await configuredHeaders({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://countorra.com" });
    for (const rule of rules) {
      for (const h of rule.headers) {
        if (h.key.toLowerCase().startsWith("access-control-allow-origin")) expect(h.value, rule.source).not.toBe("*");
      }
    }
  });

  it("names only the app's own origin on static files, overriding the CDN's wildcard", async () => {
    const rules = await configuredHeaders({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://countorra.com" });
    for (const source of ["/_next/static/:path*", "/_next/image", "/:file(.*\\.(?:svg|png|jpg|jpeg|webp|ico))"]) {
      expect(header(rules, source, "Access-Control-Allow-Origin"), source).toBe("https://countorra.com");
    }
  });

  it("grants no credentialed cross-origin access anywhere", async () => {
    const rules = await configuredHeaders({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://countorra.com" });
    expect(JSON.stringify(rules)).not.toMatch(/Access-Control-Allow-Credentials/i);
  });

  it("does not add CORS headers to pages, Server Actions, API routes or the auth callback", async () => {
    // Same-origin pages need no grant; cross-origin readers get none.
    const rules = await configuredHeaders({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://countorra.com" });
    expect(header(rules, "/:path*", "Access-Control-Allow-Origin")).toBeUndefined();
    for (const file of ["src/proxy.ts", "src/app/auth/callback/route.ts", "src/app/unsubscribe/route.ts", "src/app/api/stripe/webhook/route.ts"]) {
      expect(read(file), file).not.toMatch(/Access-Control-Allow/i);
    }
    const response = await proxy(new NextRequest("http://localhost:3000/login", { headers: { origin: "https://evil.example" } }));
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("restricts the static-file matcher to real file extensions", async () => {
    // A lone "\." in a JS string is ".", which would match "/foosvg".
    const rules = await configuredHeaders({});
    const source = rules.find((rule) => rule.source.startsWith("/:file("))!.source;
    expect(source).toContain("\\.");
  });
});

describe("the response CSP travels with every proxied response", () => {
  it("including the redirect of a signed-out visitor", async () => {
    const response = await proxy(new NextRequest("http://localhost:3000/app/x/dashboard"));
    expect(response.status).toBe(307);
    expect(response.headers.get("content-security-policy")).toMatch(/script-src 'self' 'nonce-/);
  });

  it("with a fresh nonce each time", async () => {
    const nonceOf = async () =>
      (await proxy(new NextRequest("http://localhost:3000/"))).headers.get("content-security-policy")!.match(/'nonce-([^']+)'/)![1];
    expect(await nonceOf()).not.toBe(await nonceOf());
  });
});
