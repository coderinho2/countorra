import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * The bank webhook route and the production provider registry.
 *
 * With no provider configured, the public endpoint answers 404 before it reads
 * a body or creates a database client. And the only provider implementation in
 * the repository is a test fixture that production code never imports.
 */

const state = vi.hoisted(() => {
  // The route reaches the provider registry, which reads server configuration.
  // None of these is a real credential, and no PLAID_* value is set — which is
  // exactly the state this suite asserts.
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  return { dependenciesCreated: 0 };
});

vi.mock("@/server/bank-connections/runtime", () => ({
  productionBankDependencies: () => {
    state.dependenciesCreated += 1;
    throw new Error("no database client may be created for an unconfigured provider");
  },
}));

const { POST } = await import("@/app/api/bank-connections/webhooks/[provider]/route");
const { configuredBankProviders, configuredSecretStore } = await import("@/server/bank-connections/providers");

const post = (provider: string, body: string, headers: Record<string, string> = {}) =>
  POST(new Request(`http://localhost/api/bank-connections/webhooks/${encodeURIComponent(provider)}`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } }), {
    params: Promise.resolve({ provider }),
  });

describe("the bank webhook endpoint on this deployment", () => {
  it("answers 404 for any provider, without touching the database", async () => {
    for (const provider of ["plaid", "fixture", "teller", "mx"]) {
      const response = await post(provider, JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1" }), { "plaid-verification": "forged" });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_configured" });
    }
    expect(state.dependenciesCreated).toBe(0);
  });

  it("refuses malformed provider names the same way", async () => {
    for (const provider of ["../stripe", "PLAID", "a", "x".repeat(40)]) expect((await post(provider, "{}")).status).toBe(404);
    expect(state.dependenciesCreated).toBe(0);
  });
});

describe("the production provider registry", () => {
  it("has no bank provider and no secret store", () => {
    expect(configuredBankProviders()).toEqual([]);
    // No key material in this environment, so there is nowhere to put a bank
    // credential — and `completeBankLink` refuses rather than holding one.
    expect(configuredSecretStore({} as never)).toBeNull();
  });

  it("never imports a test fixture, and confines the Plaid SDK to the gateway", () => {
    const root = path.resolve(process.cwd(), "src");
    const fixtures: string[] = [];
    const sdk: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        const source = readFileSync(full, "utf8");
        const relative = path.relative(root, full).replace(/\\/g, "/");
        // A double or fixture in production code is how a "connected" screen
        // ships with nothing behind it.
        if (/FixtureBankProvider|MemorySecretStore|bank-provider-fixture|PlaidGatewayDouble|plaid-gateway-double/.test(source)) fixtures.push(relative);
        if (/from "plaid"|require\("plaid"\)/.test(source)) sdk.push(relative);
      }
    };
    walk(root);

    expect(fixtures).toEqual([]);
    expect(sdk).toEqual(["server/bank-connections/providers/plaid/gateway.ts"]);
  });

  it("depends on the official SDK at an exact version", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    // Pinned, not a range: a bank integration should not change underneath a
    // deployment because a transitive release went out.
    expect(pkg.dependencies.plaid).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(pkg.devDependencies)).not.toContain("plaid");
  });
});
