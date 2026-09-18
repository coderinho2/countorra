import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// `@/lib/env` validates the public schema at module load, so the Supabase
// values have to exist before the import below runs. Deliberately NOT setting
// VERCEL_ENV: importing the module also runs the real assertion, and this
// suite must not be a deployment.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
});

const { assertDeployableAppUrl, isDeployedEnvironment } = await import("@/lib/env");

/**
 * `NEXT_PUBLIC_APP_URL` is the one origin the product publishes about itself.
 *
 * The failure it guards against is not subtle but it IS silent: deployed with
 * the localhost default still in place, every confirmation email, canonical
 * tag and sitemap entry names a host nobody can reach, and nothing complains
 * until a real user clicks a real link.
 *
 * Two properties are pinned here:
 *
 *   1. A deployment cannot boot with a local or non-HTTPS origin.
 *   2. Every consumer derives from the SAME value — no second source, no
 *      hardcoded domain, no independent fallback.
 */

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

const LOCAL_URLS = [
  "http://localhost:3000",
  "http://localhost",
  "https://localhost:3000",
  "http://127.0.0.1:3000",
  "http://0.0.0.0:3000",
  "http://[::1]:3000",
  "http://mymachine.local",
  "http://app.localhost:3000",
];

describe("what counts as a deployment", () => {
  it.each(["production", "preview"])("treats VERCEL_ENV=%s as deployed", (env) => {
    expect(isDeployedEnvironment(env)).toBe(true);
  });

  it("does not treat `vercel dev` as deployed, where localhost is correct", () => {
    expect(isDeployedEnvironment("development")).toBe(false);
  });

  it("does not treat an ordinary local process as deployed", () => {
    // No VERCEL_ENV: `npm run dev`, `npm run build`, and the E2E suite's
    // `next build && next start` against localhost. All legitimate.
    expect(isDeployedEnvironment(undefined)).toBe(false);
    expect(isDeployedEnvironment("")).toBe(false);
  });
});

describe("a deployment refuses a local origin", () => {
  it.each(LOCAL_URLS)("rejects %s in production", (url) => {
    expect(() => assertDeployableAppUrl(url, "production")).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it.each(LOCAL_URLS)("rejects %s in preview too", (url) => {
    // A preview deployment mailing localhost links is broken the same way,
    // just to fewer people.
    expect(() => assertDeployableAppUrl(url, "preview")).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it("says what to do, including the part people miss", () => {
    // NEXT_PUBLIC_* is inlined at build time, so setting the variable without
    // redeploying changes nothing. An error that omits that sends someone to
    // flip a setting and watch it not work.
    const message = (() => {
      try {
        assertDeployableAppUrl("http://localhost:3000", "production");
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(message).toMatch(/REDEPLOY/);
    expect(message).toMatch(/Supabase/);
    expect(message).toMatch(/URL Configuration/i);
  });

  it("rejects a deployed origin that is not HTTPS", () => {
    // Session cookies and password-reset links in clear, against an app that
    // sends HSTS.
    expect(() => assertDeployableAppUrl("http://app.example.com", "production")).toThrow(/HTTPS/i);
  });

  it("accepts a real HTTPS origin — the check is not simply always-on", () => {
    // A test that only proved things throw would pass against a broken
    // assertion that rejects everything.
    expect(() => assertDeployableAppUrl("https://app.example.com", "production")).not.toThrow();
    expect(() => assertDeployableAppUrl("https://accountant.example.co.uk", "preview")).not.toThrow();
  });
});

describe("local work is unaffected", () => {
  it.each(LOCAL_URLS)("allows %s outside a deployment", (url) => {
    expect(() => assertDeployableAppUrl(url, undefined)).not.toThrow();
  });

  it("allows localhost under `vercel dev`", () => {
    expect(() => assertDeployableAppUrl("http://localhost:3000", "development")).not.toThrow();
  });

  it("keeps a local production build working, which is how E2E runs", () => {
    // `next build && next start` sets NODE_ENV=production and serves
    // localhost on purpose. Keying the check on NODE_ENV would fail it, and
    // the pressure would then be to weaken the check.
    const env = read("src/lib/env.ts");
    expect(env).not.toMatch(/NODE_ENV\s*===\s*["']production["']/);
    expect(env).toContain("VERCEL_ENV");
  });
});

describe("the assertion runs where it can still be cheap", () => {
  const env = read("src/lib/env.ts");

  it("is invoked at module load, not lazily behind a function", () => {
    // Static routes import this module, so `next build` prerendering triggers
    // it — the build fails rather than the first request.
    expect(env).toMatch(/^assertDeployableAppUrl\(publicEnv\.NEXT_PUBLIC_APP_URL\);$/m);
  });

  it("is reachable from the build, because a prerendered route imports it", () => {
    for (const file of ["src/app/layout.tsx", "src/app/robots.ts", "src/app/sitemap.ts"]) {
      expect(read(file), file).toContain("@/lib/env");
    }
  });
});

describe("one canonical source, no second opinion", () => {
  it("resolves every published URL from publicEnv", () => {
    const consumers = {
      "src/app/layout.tsx": /metadataBase:\s*new URL\(publicEnv\.NEXT_PUBLIC_APP_URL\)/,
      "src/app/robots.ts": /publicEnv\.NEXT_PUBLIC_APP_URL/,
      "src/app/sitemap.ts": /publicEnv\.NEXT_PUBLIC_APP_URL/,
      "src/server/auth/actions.ts": /publicEnv\.NEXT_PUBLIC_APP_URL/,
    };

    for (const [file, pattern] of Object.entries(consumers)) {
      expect(read(file), file).toMatch(pattern);
    }
  });

  it("reads process.env.NEXT_PUBLIC_APP_URL in exactly one place", () => {
    // A second reader would be a second fallback, and would bypass the
    // assertion entirely.
    const sources = ["src/app/layout.tsx", "src/app/robots.ts", "src/app/sitemap.ts", "src/server/auth/actions.ts", "src/proxy.ts"];
    for (const file of sources) {
      expect(read(file), file).not.toMatch(/process\.env\.NEXT_PUBLIC_APP_URL/);
    }
    expect(read("src/lib/env.ts")).toMatch(/process\.env\.NEXT_PUBLIC_APP_URL/);
  });

  it("hardcodes no domain anywhere in the application", () => {
    // The value is supplied by the environment precisely because the real
    // domain is not known yet. A guessed one would be worse than none.
    for (const file of ["src/app/layout.tsx", "src/app/robots.ts", "src/app/sitemap.ts", "src/server/auth/actions.ts", "src/lib/env.ts"]) {
      const source = read(file);
      const absolute = source.match(/["'`]https?:\/\/[^"'`$]+["'`]/g) ?? [];
      // Only the documented localhost development default may appear.
      for (const literal of absolute) {
        expect(literal, `${file}: ${literal}`).toMatch(/localhost:3000/);
      }
    }
  });

  it("builds auth redirects by interpolation, never from a request value", () => {
    const actions = read("src/server/auth/actions.ts");
    const redirects = actions.match(/(?:emailRedirectTo|redirectTo):\s*`[^`]+`/g) ?? [];

    expect(redirects.length).toBeGreaterThanOrEqual(2);
    for (const redirect of redirects) {
      expect(redirect, redirect).toContain("publicEnv.NEXT_PUBLIC_APP_URL");
    }
  });

  it("lets the auth callback resolve against the REQUEST origin, deliberately", () => {
    // The one place that does not use NEXT_PUBLIC_APP_URL, and should not.
    // The user is already on the deployment that served the link, so a
    // same-origin relative redirect keeps them there — using the canonical
    // URL instead would bounce a preview-deployment user to production
    // mid-authentication. It is safe because the target is always a path
    // that `safeRedirectPath` has reduced to a single leading slash.
    const callback = read("src/app/auth/callback/route.ts");
    const decision = read("src/lib/auth-callback.ts");
    expect(decision).toContain("safeRedirectPath");
    // Resolved against the request's own origin...
    expect(callback).toMatch(/new URL\(callbackDestination\(outcome, searchParams\.get\("redirectTo"\), flowHint\(searchParams\.get\("flow"\)\)\), origin\)/);
    // ...and every fixed destination is a same-origin path, never a URL —
    // including the recovery ones chosen by a ternary.
    const destinations = decision.slice(decision.indexOf("export function callbackDestination"));
    const fixed = destinations.match(/"\/[^"]*"/g) ?? [];
    expect(fixed.length).toBeGreaterThanOrEqual(5);
    for (const literal of fixed) {
      expect(literal, literal).toMatch(/^"\/(?!\/)/);
    }
    expect(destinations).not.toMatch(/"(?:https?:)?\/\/|`/);
    expect(callback).not.toContain("NEXT_PUBLIC_APP_URL");
    expect(decision).not.toContain("NEXT_PUBLIC_APP_URL");
  });
});

describe(".env.example tells a deployer what production needs", () => {
  const example = read(".env.example");

  it("states that production must supply a real https origin", () => {
    expect(example).toMatch(/PRODUCTION AND PREVIEW/);
    expect(example).toMatch(/https:\/\//);
  });

  it("warns that the value is inlined at build time", () => {
    // The single most common way this is got wrong.
    expect(example).toMatch(/build time/i);
    expect(example).toMatch(/REDEPLOY/i);
  });

  it("points at the Supabase allowlist, which is a separate step", () => {
    expect(example).toMatch(/URL Configuration/i);
  });

  it("still ships localhost as the documented development value", () => {
    expect(example).toMatch(/^NEXT_PUBLIC_APP_URL=http:\/\/localhost:3000$/m);
  });

  it("guesses no production domain", () => {
    const line = example.split(/\r?\n/).find((l) => l.startsWith("NEXT_PUBLIC_APP_URL="));
    expect(line).toBe("NEXT_PUBLIC_APP_URL=http://localhost:3000");
  });
});
