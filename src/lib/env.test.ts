import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The environment reader's bank-credential rules.
 *
 * Both spellings of the keyset variable are accepted. That is not cosmetic: a
 * deployment that sets the plural and reads the singular starts up fine, opens
 * Plaid Link fine, and then fails to store the access token — after the person
 * has already signed in at their bank.
 */

const original = { ...process.env };

async function freshEnv() {
  // serverEnv() caches its parse, so each case needs the module re-evaluated.
  vi.resetModules();
  return import("./env");
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  process.env.ANTHROPIC_API_KEY = "anthropic";
  delete process.env.BANK_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.BANK_CREDENTIAL_ENCRYPTION_KEYS;
  delete process.env.PLAID_CLIENT_ID;
  delete process.env.PLAID_SECRET;
  delete process.env.PLAID_ENV;
});

afterEach(() => {
  process.env = { ...original };
});

const KEYSET = `test:${Buffer.alloc(32, 3).toString("base64")}`;

describe("the bank credential keyset variable", () => {
  it("is read from the singular name", async () => {
    process.env.BANK_CREDENTIAL_ENCRYPTION_KEY = KEYSET;
    const { serverEnv } = await freshEnv();
    expect(serverEnv().BANK_CREDENTIAL_ENCRYPTION_KEY).toBe(KEYSET);
  });

  it("is read from the plural name too, which is what a list of keys invites", async () => {
    process.env.BANK_CREDENTIAL_ENCRYPTION_KEYS = KEYSET;
    const { serverEnv } = await freshEnv();
    expect(serverEnv().BANK_CREDENTIAL_ENCRYPTION_KEY).toBe(KEYSET);
  });

  it("prefers the singular when both are set, rather than guessing", async () => {
    process.env.BANK_CREDENTIAL_ENCRYPTION_KEY = KEYSET;
    process.env.BANK_CREDENTIAL_ENCRYPTION_KEYS = `other:${Buffer.alloc(32, 9).toString("base64")}`;
    const { serverEnv } = await freshEnv();
    expect(serverEnv().BANK_CREDENTIAL_ENCRYPTION_KEY).toBe(KEYSET);
  });

  it("refuses Plaid credentials with no key to protect the token they will produce", async () => {
    process.env.PLAID_CLIENT_ID = "client";
    process.env.PLAID_SECRET = "secret";
    process.env.PLAID_ENV = "sandbox";
    const { serverEnv } = await freshEnv();
    expect(() => serverEnv()).toThrow(/BANK_CREDENTIAL_ENCRYPTION_KEY/);
  });

  it("refuses a half-configured Plaid, naming exactly what is missing", async () => {
    process.env.PLAID_CLIENT_ID = "client";
    process.env.BANK_CREDENTIAL_ENCRYPTION_KEY = KEYSET;
    const { serverEnv } = await freshEnv();
    expect(() => serverEnv()).toThrow(/PLAID_SECRET, PLAID_ENV are missing/);
  });

  it("accepts a deployment with no Plaid at all", async () => {
    const { serverEnv } = await freshEnv();
    expect(serverEnv().PLAID_ENV).toBeUndefined();
    expect(serverEnv().BANK_CREDENTIAL_ENCRYPTION_KEY).toBeUndefined();
  });
});
