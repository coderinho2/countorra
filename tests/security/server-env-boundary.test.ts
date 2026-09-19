import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The public/server environment boundary, at the source level (Task 18).
 *
 * src/lib/env.ts is imported by browser code; src/lib/server-env.ts holds the
 * secrets and must never be. Until Task 18 they were one module, and the
 * server schema — the NAMES of every server secret — shipped to the browser
 * with the public Supabase URL.
 *
 * This file is the fast, always-on half. The built output itself is scanned
 * by tests/e2e/browser-bundle-env.spec.ts, which runs against the production
 * build the E2E suite makes.
 */

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

/** Every variable the server schema declares — read from the schema, so a
 *  new secret is covered the moment it is added. */
export function serverEnvNames(): string[] {
  const source = read("src/lib/server-env.ts");
  const schema = source.slice(source.indexOf("const serverSchema = z.object({"), source.indexOf("});", source.indexOf("const serverSchema")));
  return [...schema.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir)).flatMap((entry) => {
    const relative = path.join(dir, entry);
    if (statSync(path.join(ROOT, relative)).isDirectory()) return sourceFiles(relative);
    return /\.(ts|tsx)$/.test(entry) ? [relative] : [];
  });
}

describe("the server environment module", () => {
  it("is server-only, so a browser import fails the build", () => {
    expect(read("src/lib/server-env.ts")).toMatch(/^import "server-only";/);
  });

  it("declares the secrets this boundary exists for", () => {
    const names = serverEnvNames();
    for (const secret of ["SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "PLAID_SECRET", "BANK_CREDENTIAL_ENCRYPTION_KEY", "BANK_SYNC_WORKER_SECRET", "CRON_SECRET"]) {
      expect(names).toContain(secret);
    }
  });
});

describe("the public environment module", () => {
  const publicSource = read("src/lib/env.ts");

  it("names no server variable at all, not even in a comment", () => {
    for (const name of [...serverEnvNames(), "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) {
      expect(publicSource, name).not.toContain(name);
    }
  });

  it("reads only NEXT_PUBLIC_ values and the deployment signal from process.env", () => {
    const reads = [...publicSource.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(reads.length).toBeGreaterThan(0);
    for (const name of reads) expect(name === "VERCEL_ENV" || name.startsWith("NEXT_PUBLIC_"), name).toBe(true);
  });

  it("does not re-export or import the server module", () => {
    expect(publicSource).not.toMatch(/from\s+["'][^"']*server-env["']/);
    expect(publicSource).not.toMatch(/import\s*\(\s*["'][^"']*server-env["']/);
    expect(publicSource).not.toMatch(/^\s*import\s+["'][^"']*server-env["']/m);
  });
});

describe("browser code imports only the public module", () => {
  it("no Client Component imports the server environment", () => {
    const offenders = sourceFiles("src").filter((file) => {
      const text = read(file);
      return /^["']use client["'];?/m.test(text) && /@\/lib\/server-env|\.\/server-env/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it("the browser Supabase client uses the public module only", () => {
    const client = read("src/server/supabase/client.ts");
    expect(client).toContain('from "@/lib/env"');
    expect(client).not.toContain("server-env");
  });
});
