import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ENVIRONMENT SAFETY, PROVEN WITHOUT A NETWORK.
 *
 * The single most consequential line in this integration is the one that turns
 * `PLAID_ENV` into a hostname: get it wrong and a test run reaches somebody's
 * real bank. Nothing asserted this until now — Task 12 verified the adapter
 * and Task 13 the worker, both against a test double.
 *
 * So: sandbox credentials can only ever reach sandbox.plaid.com, production is
 * never a default or a fallback, and a deployment with no `PLAID_ENV` has no
 * provider at all (which is why no Plaid endpoint can be contacted from this
 * repository as it stands).
 *
 * A base64 key is used below only because the keyset parser requires 32 bytes.
 * It is a throwaway generated for this file, encrypts nothing, and is not a
 * credential of any kind.
 */

const TEST_KEY = `test:${Buffer.alloc(32, 7).toString("base64")}`;

const env: Record<string, string | undefined> = {};

vi.mock("@/lib/env", () => ({
  serverEnv: () => env,
}));

const loadConfig = async () => {
  const configModule = await import("./config");
  configModule.__resetPlaidConfigForTests();
  return configModule;
};

beforeEach(() => {
  for (const key of Object.keys(env)) delete env[key];
});

afterEach(async () => {
  (await import("./config")).__resetPlaidConfigForTests();
});

describe("which Plaid host this deployment can reach", () => {
  it("sends sandbox credentials to the sandbox host and nowhere else", async () => {
    Object.assign(env, { PLAID_CLIENT_ID: "client", PLAID_SECRET: "secret", PLAID_ENV: "sandbox", BANK_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    const { plaidConfig, plaidProviderVersion } = await loadConfig();

    const config = plaidConfig();

    expect(config?.environment).toBe("sandbox");
    expect(config?.basePath).toBe("https://sandbox.plaid.com");
    expect(config?.basePath).not.toContain("production");
    // Carried on every connection, so a sandbox row can never read as real money.
    expect(plaidProviderVersion("sandbox")).toBe("2020-09-14+sandbox");
  });

  it("reaches the production host only when production is named explicitly", async () => {
    Object.assign(env, { PLAID_CLIENT_ID: "client", PLAID_SECRET: "secret", PLAID_ENV: "production", BANK_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    const { plaidConfig } = await loadConfig();

    expect(plaidConfig()?.basePath).toBe("https://production.plaid.com");
  });

  it("has no provider, and therefore no host, when Plaid is not configured", async () => {
    const { plaidConfig } = await loadConfig();
    expect(plaidConfig()).toBeNull();

    // Each piece missing on its own is still no provider — there is no
    // environment default anywhere in this path.
    for (const missing of ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV", "BANK_CREDENTIAL_ENCRYPTION_KEY"]) {
      for (const key of Object.keys(env)) delete env[key];
      Object.assign(env, { PLAID_CLIENT_ID: "client", PLAID_SECRET: "secret", PLAID_ENV: "sandbox", BANK_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
      delete env[missing];
      const { plaidConfig: reload } = await loadConfig();
      expect(reload()).toBeNull();
    }
  });

  it("refuses key material it cannot use, rather than holding a bank token it cannot protect", async () => {
    Object.assign(env, { PLAID_CLIENT_ID: "client", PLAID_SECRET: "secret", PLAID_ENV: "sandbox", BANK_CREDENTIAL_ENCRYPTION_KEY: "not-a-key" });
    const { plaidConfig } = await loadConfig();
    expect(() => plaidConfig()).toThrow();
  });

  it("never carries a credential in the value the rest of the app reads for display", async () => {
    Object.assign(env, { PLAID_CLIENT_ID: "client-id-value", PLAID_SECRET: "secret-value", PLAID_ENV: "sandbox", BANK_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    const { plaidConfig, plaidProviderVersion } = await loadConfig();
    const config = plaidConfig()!;

    // The provider version is what lands on rows and in the UI.
    const version = plaidProviderVersion(config.environment);
    expect(version).not.toContain("client-id-value");
    expect(version).not.toContain("secret-value");
    expect(version).not.toContain(TEST_KEY);
  });
});
