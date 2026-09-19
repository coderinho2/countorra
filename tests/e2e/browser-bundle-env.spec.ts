import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * What a browser actually receives must contain no server secret — neither
 * its VALUE nor, since Task 18, its NAME.
 *
 * Runs against the production build the E2E web server makes
 * (`npm run build && npm run start`), so it checks shipped output rather than
 * source. Two surfaces:
 *
 *   1. every file under .next/static (client JS chunks and CSS), and
 *   2. the HTML (including the inlined RSC payload) of public pages.
 *
 * Values come from this process's environment and .env.local. They are
 * compared, never printed: a failure names the VARIABLE, not what it holds.
 */

const ROOT = path.resolve(__dirname, "../..");

function serverEnvNames(): string[] {
  const source = readFileSync(path.join(ROOT, "src/lib/server-env.ts"), "utf8");
  const start = source.indexOf("const serverSchema = z.object({");
  const schema = source.slice(start, source.indexOf("});", start));
  return [...schema.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
}

/** Server-only names: the server schema, plus Stripe's (read in
 *  src/server/billing/stripe-config.ts, also server-only). */
const SERVER_ONLY_NAMES = [...new Set([...serverEnvNames(), "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "BANK_CREDENTIAL_ENCRYPTION_KEYS"])];

function localEnv(): Record<string, string> {
  const file = path.join(ROOT, ".env.local");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Secret values worth searching for: long enough that a match is not chance. */
function secretValues(): { name: string; value: string }[] {
  const env = { ...localEnv(), ...process.env } as Record<string, string | undefined>;
  return SERVER_ONLY_NAMES.flatMap((name) => {
    const value = env[name];
    return value && value.length >= 12 ? [{ name, value }] : [];
  });
}

function staticFiles(): string[] {
  const dir = path.join(ROOT, ".next/static");
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).map((f) => path.join(dir, f)).filter((f) => /\.(js|css|json|txt|html)$/.test(f));
}

test("the build's client output exists to be scanned", () => {
  // Guards the two tests below from passing vacuously on an empty directory.
  expect(staticFiles().filter((f) => f.endsWith(".js")).length).toBeGreaterThan(10);
  expect(SERVER_ONLY_NAMES.length).toBeGreaterThanOrEqual(10);
});

test("no client chunk names a server-only variable", () => {
  const hits: string[] = [];
  for (const file of staticFiles()) {
    const text = readFileSync(file, "utf8");
    for (const name of SERVER_ONLY_NAMES) if (text.includes(name)) hits.push(`${name} in ${path.basename(file)}`);
  }
  expect(hits).toEqual([]);
});

test("no client chunk contains a server-only value", () => {
  const values = secretValues();
  const hits: string[] = [];
  for (const file of staticFiles()) {
    const text = readFileSync(file, "utf8");
    for (const { name, value } of values) if (text.includes(value)) hits.push(`value of ${name} in ${path.basename(file)}`);
  }
  expect(hits).toEqual([]);
});

test("public pages' HTML carries no server-only name or value", async ({ request }) => {
  const values = secretValues();
  const hits: string[] = [];
  for (const route of ["/", "/pricing", "/login", "/signup", "/privacy", "/terms", "/security"]) {
    const response = await request.get(route);
    expect(response.status(), route).toBeLessThan(500);
    const html = await response.text();
    for (const name of SERVER_ONLY_NAMES) if (html.includes(name)) hits.push(`${name} on ${route}`);
    for (const { name, value } of values) if (html.includes(value)) hits.push(`value of ${name} on ${route}`);
  }
  expect(hits).toEqual([]);
});
