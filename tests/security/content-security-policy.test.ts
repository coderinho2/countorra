import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STATIC_ASSET_CONTENT_SECURITY_POLICY,
  buildContentSecurityPolicy,
  generateNonce,
} from "@/lib/security/content-security-policy";

/**
 * The Content-Security-Policy, pinned against the three ZAP findings it
 * resolves (2026-09-20): "CSP: Wildcard Directive", "CSP: script-src
 * unsafe-inline" and "CSP: style-src unsafe-inline".
 *
 * The browser-level proof — every public page loads, hydrates and runs its
 * Server Actions under this policy with zero violation reports — is in the
 * E2E suite and was run against a production build. These tests stop the
 * policy from being loosened quietly afterwards.
 */

const NONCE = "dGVzdC1ub25jZS0xMjM0NQ==";
const SUPABASE = "https://ibqqydxfrdaydksmydsb.supabase.co";

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0])
      .map(([name, ...sources]) => [name!, sources]),
  );
}

const production = directives(buildContentSecurityPolicy({ nonce: NONCE, supabaseUrl: SUPABASE, development: false }));

describe("no wildcard sources", () => {
  it("falls back to this origin, not to anything", () => {
    // The old policy had no default-src, so every undeclared fetch directive
    // allowed every host.
    expect(production.get("default-src")).toEqual(["'self'"]);
  });

  it("declares every fetch directive ZAP checks", () => {
    for (const name of ["script-src", "style-src", "img-src", "font-src", "connect-src", "frame-src", "media-src", "object-src"]) {
      expect(production.has(name), name).toBe(true);
    }
  });

  it("contains no wildcard, bare-scheme or http: source in any directive", () => {
    for (const [name, sources] of production) {
      for (const source of sources) {
        expect(source, `${name} ${source}`).not.toMatch(/\*/);
        expect(source, `${name} ${source}`).not.toMatch(/^(https?|wss?):$/);
        expect(source, `${name} ${source}`).not.toMatch(/^http:\/\//);
      }
    }
  });

  it("allows connections only to this origin and the project's own Supabase host", () => {
    expect(production.get("connect-src")).toEqual(["'self'", SUPABASE]);
  });

  it("adds exactly one Plaid API host, for the configured environment, and only when configured", () => {
    const sandbox = directives(buildContentSecurityPolicy({ nonce: NONCE, supabaseUrl: SUPABASE, plaidEnv: "sandbox", development: false }));
    const live = directives(buildContentSecurityPolicy({ nonce: NONCE, supabaseUrl: SUPABASE, plaidEnv: "production", development: false }));
    expect(sandbox.get("connect-src")).toEqual(["'self'", SUPABASE, "https://sandbox.plaid.com"]);
    expect(live.get("connect-src")).toEqual(["'self'", SUPABASE, "https://production.plaid.com"]);
  });

  it("frames nothing but Plaid Link, and can be framed by nothing", () => {
    expect(production.get("frame-src")).toEqual(["https://cdn.plaid.com"]);
    expect(production.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("loads images and fonts from this origin only", () => {
    expect(production.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(production.get("font-src")).toEqual(["'self'"]);
    expect(production.get("media-src")).toEqual(["'none'"]);
    expect(production.get("object-src")).toEqual(["'none'"]);
  });

  it("uses the Supabase origin even if the configured URL carries a path", () => {
    const policy = directives(buildContentSecurityPolicy({ nonce: NONCE, supabaseUrl: `${SUPABASE}/rest/v1`, development: false }));
    expect(policy.get("connect-src")).toContain(SUPABASE);
  });
});

describe("script-src: nonce, not unsafe-inline", () => {
  it("admits scripts by this response's nonce, and what they load", () => {
    const scripts = production.get("script-src")!;
    expect(scripts).toContain(`'nonce-${NONCE}'`);
    expect(scripts).toContain("'strict-dynamic'");
  });

  it("never allows inline script or eval in production", () => {
    const scripts = production.get("script-src")!;
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(scripts).not.toContain("'unsafe-hashes'");
  });

  it("relaxes eval and the HMR websocket for `next dev` only", () => {
    const dev = directives(buildContentSecurityPolicy({ nonce: NONCE, supabaseUrl: SUPABASE, development: true }));
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    expect(dev.get("script-src")).not.toContain("'unsafe-inline'");
    expect(dev.get("connect-src")).toContain("ws:");
    expect(production.get("connect-src")).not.toContain("ws:");
  });
});

describe("style-src: nonce, with one narrowly scoped exception", () => {
  it("admits <style> elements by nonce only", () => {
    expect(production.get("style-src")).toEqual(["'self'", `'nonce-${NONCE}'`]);
  });

  it("allows inline style ATTRIBUTES and nothing broader", () => {
    // React server-renders `style={…}` as an attribute; see the policy's own
    // comment for why this is the minimal exception.
    const unsafe = [...production].filter(([, sources]) => sources.includes("'unsafe-inline'")).map(([name]) => name);
    expect(unsafe).toEqual(["style-src-attr"]);
  });
});

describe("the rest of the policy", () => {
  it("keeps the protections the old policy already had", () => {
    expect(production.get("base-uri")).toEqual(["'self'"]);
    expect(production.get("form-action")).toEqual(["'self'"]);
    expect(production.has("upgrade-insecure-requests")).toBe(true);
  });

  it("does not upgrade requests on plain-HTTP localhost", () => {
    const dev = directives(buildContentSecurityPolicy({ nonce: NONCE, supabaseUrl: SUPABASE, development: true }));
    expect(dev.has("upgrade-insecure-requests")).toBe(false);
  });

  it("permits nothing at all on static files", () => {
    expect(STATIC_ASSET_CONTENT_SECURITY_POLICY).toMatch(/^default-src 'none'/);
    expect(STATIC_ASSET_CONTENT_SECURITY_POLICY).not.toMatch(/unsafe|\*/);
  });
});

describe("the nonce", () => {
  it("is 128 bits of randomness, base64-encoded", () => {
    const nonce = generateNonce();
    expect(atob(nonce)).toHaveLength(16);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("is never repeated", () => {
    const nonces = new Set(Array.from({ length: 2000 }, generateNonce));
    expect(nonces.size).toBe(2000);
  });
});

// ── What makes the nonce work in the app ────────────────────────────────────

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

describe("every page can actually receive the nonce", () => {
  it("renders the whole tree per request, so no page ships prerendered un-nonced scripts", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toMatch(/await connection\(\)/);
  });

  it("does not also set a static page CSP in next.config.ts, which would block every nonce-bearing script", () => {
    const config = read("next.config.ts");
    const pageRule = config.slice(config.indexOf('source: "/:path*"'), config.indexOf('source: "/_next/static'));
    expect(pageRule).not.toContain("Content-Security-Policy");
    expect(config).not.toContain("CONTENT_SECURITY_POLICY =");
  });

  it("hands the nonce to Next.js on the forwarded request and sends the policy on the response", () => {
    const proxy = read("src/proxy.ts");
    expect(proxy).toMatch(/request\.headers\.set\("content-security-policy", contentSecurityPolicy\)/);
    expect(proxy).toMatch(/response\.headers\.set\("Content-Security-Policy", policy\)/);
  });
});

describe("runtime <style> elements carry the nonce", () => {
  const documentBefore = globalThis.document;
  afterEach(() => {
    (globalThis as { document?: unknown }).document = documentBefore;
    vi.resetModules();
  });

  it("gives react-style-singleton (Radix Dialog / DropdownMenu scroll lock) the page nonce", async () => {
    // A minimal document: enough for the real csp-nonce module to find a
    // nonce-bearing script, and for the real react-style-singleton to build
    // and insert its <style> tag.
    const inserted: { attributes: Record<string, string> }[] = [];
    (globalThis as { document?: unknown }).document = {
      querySelector: (selector: string) => (selector === "script[nonce]" ? { nonce: NONCE } : null),
      createElement: () => {
        const tag = { attributes: {} as Record<string, string>, setAttribute: (k: string, v: string) => (tag.attributes[k] = v), appendChild: () => {} };
        return tag;
      },
      createTextNode: (text: string) => ({ text }),
      head: { appendChild: (tag: (typeof inserted)[number]) => inserted.push(tag) },
      getElementsByTagName: () => [],
    };

    await import("@/components/security/csp-nonce");
    const { stylesheetSingleton } = await import("react-style-singleton");
    stylesheetSingleton().add("body{overflow:hidden}");

    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.attributes.nonce).toBe(NONCE);
  });

  it("passes the nonce to Radix Select's viewport <style>", () => {
    const select = read("src/components/ui/select.tsx");
    expect(select).toMatch(/const nonce = useCspNonce\(\)/);
    expect(select).toMatch(/<SelectPrimitive\.Viewport nonce=\{nonce\}>/);
  });

  it("is loaded on every page, by the root layout", () => {
    expect(read("src/app/layout.tsx")).toMatch(/<CspNonce \/>/);
  });
});

describe("no eval in the browser", () => {
  /** Every module under src/validation that a "use client" file imports. */
  function validationModulesUsedByClientComponents(): string[] {
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry) && !/\.test\./.test(entry)) {
          const source = readFileSync(full, "utf8");
          if (!/^["']use client["']/.test(source.trimStart())) continue;
          for (const match of source.matchAll(/from "@\/validation\/([^"]+)"/g)) found.add(`src/validation/${match[1]}.ts`);
        }
      }
    };
    walk(path.join(ROOT, "src"));
    return [...found];
  }

  it("finds the modules it is checking", () => {
    expect(validationModulesUsedByClientComponents()).toContain("src/validation/schemas/auth.ts");
  });

  it("switches Zod's `new Function` JIT off before any browser-side schema is built", () => {
    // Zod probes for eval as a schema is constructed; the CSP refuses it and
    // every such page logged a violation. The switch has to evaluate first.
    for (const schemaModule of validationModulesUsedByClientComponents()) {
      const firstImport = read(schemaModule).match(/^import\s+(?:[^;]*?from\s+)?"([^"]+)";/m)?.[1];
      expect(firstImport, schemaModule).toBe("@/validation/zod-browser");
    }
    expect(read("src/validation/zod-browser.ts")).toMatch(/if \(typeof window !== "undefined"\) z\.config\(\{ jitless: true \}\)/);
  });
});
