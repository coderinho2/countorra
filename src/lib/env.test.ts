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
  return import("./server-env");
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
  delete process.env.AWS_REGION;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
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

/**
 * The AWS reader, which is deliberately NOT the whole-environment reader.
 *
 * The live Textract smoke test runs in a shell holding AWS credentials and
 * nothing else — no Supabase key, no Anthropic key, because it needs neither.
 * Reading those through `serverEnv()` made it fail with "Textract is not
 * configured for this deployment": a required, unrelated variable was missing
 * and the caller reports any failure as "no reader".
 *
 * NO REAL CREDENTIALS APPEAR HERE. The values are obvious placeholders; what
 * is asserted is the SHAPE of the decision, never an account.
 */
const FAKE_KEY_ID = "AKIAEXAMPLEEXAMPLE12";
const FAKE_SECRET = "placeholder-not-a-real-secret-key";

describe("the AWS environment reader", () => {
  it("finds a whole static configuration without any other secret being set", async () => {
    // Exactly the live test's shell: AWS present, everything else absent.
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = FAKE_KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = FAKE_SECRET;

    const { textractEnv } = await freshEnv();
    expect(textractEnv().AWS_REGION).toBe("us-east-1");

    // And the reader built on it agrees, which is the symptom that started
    // this: it used to answer false here.
    const { textractConfiguration } = await import("@/server/documents/textract/client");
    expect(textractConfiguration()).toEqual({ region: "us-east-1", usesStaticKeys: true });
  });

  it("reports a region alone as the IAM-role shape, not as static keys", async () => {
    process.env.AWS_REGION = "us-east-1";
    const { textractEnv } = await freshEnv();
    expect(textractEnv().AWS_ACCESS_KEY_ID).toBeUndefined();

    const { textractConfiguration } = await import("@/server/documents/textract/client");
    expect(textractConfiguration()).toEqual({ region: "us-east-1", usesStaticKeys: false });
  });

  it("still refuses half a key pair, naming the missing half", async () => {
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = FAKE_KEY_ID;
    const { textractEnv } = await freshEnv();
    expect(() => textractEnv()).toThrow(/AWS_SECRET_ACCESS_KEY is missing/);
  });

  it("still refuses credentials with no region to send them to", async () => {
    process.env.AWS_ACCESS_KEY_ID = FAKE_KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = FAKE_SECRET;
    const { textractEnv } = await freshEnv();
    expect(() => textractEnv()).toThrow(/AWS_REGION/);
  });

  it("is off when nothing AWS is set at all", async () => {
    const { textractEnv } = await freshEnv();
    expect(textractEnv().AWS_REGION).toBeUndefined();
  });

  it("does not require the AWS variables in order to read the rest", async () => {
    // The other direction of the same decoupling: a deployment with no OCR
    // reads its own secrets exactly as before.
    const { serverEnv } = await freshEnv();
    expect(serverEnv().SUPABASE_SERVICE_ROLE_KEY).toBe("service-role");
    expect(serverEnv().AWS_REGION).toBeUndefined();
  });
});
