import "server-only";
import { z } from "zod";

/**
 * SERVER environment — secrets. Never reaches a browser.
 *
 * `import "server-only"` makes that a build error rather than a convention: a
 * Client Component whose import graph reaches this file does not compile.
 * The public half lives in src/lib/env.ts. They were one module until Task 18,
 * which meant every page that needed the public Supabase URL also shipped the
 * server schema — the names of SUPABASE_SERVICE_ROLE_KEY, PLAID_SECRET,
 * BANK_CREDENTIAL_ENCRYPTION_KEY and the rest — to the browser. No values,
 * but a map of what to look for.
 *
 * Validation here is unchanged by the split.
 */

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  /** Direct Postgres connection, used only by local RLS test scripts — never by the app at runtime. */
  DATABASE_URL: z.url().optional(),
  /**
   * Optional pepper for the rate limiter's identifier hashing
   * (src/server/security/rate-limit.ts). When unset, the pepper is derived
   * from SUPABASE_SERVICE_ROLE_KEY, which is always present — so the limiter
   * is fully functional without this being configured. Setting it decouples
   * the two, so rotating the service-role key no longer resets in-flight
   * rate-limit windows.
   */
  RATE_LIMIT_HASH_SECRET: z.string().min(16).optional(),

  // ── Plaid (bank connections) ──────────────────────────────────────────
  // Server-only, all of them. A NEXT_PUBLIC_ prefix on any of these would
  // inline a bank-data credential into the browser bundle. The browser only
  // ever receives a short-lived Link token, created server-side.
  //
  // All-or-nothing, enforced below: a deployment that can create Link tokens
  // but cannot store the resulting access token — or vice versa — fails
  // halfway through connecting somebody's bank.
  PLAID_CLIENT_ID: z.string().min(1).optional(),
  PLAID_SECRET: z.string().min(1).optional(),
  /** Which Plaid environment these credentials belong to. Never guessed: the
   *  same client id exists in sandbox and production with different secrets,
   *  and pointing a test at production is the mistake this prevents. */
  PLAID_ENV: z.enum(["sandbox", "production"]).optional(),
  /** Where Plaid posts webhooks. Must be the deployed https origin + the
   *  route path; omit it and Plaid simply sends nothing. */
  PLAID_WEBHOOK_URL: z.url().optional(),
  /** Only needed for OAuth institutions, which return to this exact URI. */
  PLAID_REDIRECT_URI: z.url().optional(),
  /**
   * The shared secret a scheduler presents to POST /api/bank-connections/worker
   * (Vercel Cron sends it as `Authorization: Bearer …`). Without it that route
   * answers 404 and no background sync runs — which is the safe default: an
   * unauthenticated endpoint that makes provider calls on every organization's
   * behalf is worse than no worker at all. 32 characters minimum, compared in
   * constant time. Never sent to the browser.
   */
  BANK_SYNC_WORKER_SECRET: z.string().min(32).optional(),
  /**
   * What Vercel Cron sends as `Authorization: Bearer …`. It is NOT a second
   * key to the worker — the worker accepts only BANK_SYNC_WORKER_SECRET — so
   * on Vercel the two must hold the same value. Read only so that a mismatch
   * (every cron call answered 401, silently) is reported as an error instead
   * of discovered a week later. See DEPLOYMENT.md, "Worker cron".
   */
  CRON_SECRET: z.string().min(1).optional(),
  /**
   * Bearer token for the INTERNAL operations endpoints — the detailed
   * readiness report and the operational summary (src/app/api/health/ready,
   * src/app/api/operations/summary). Unset means those detailed views are
   * off: the public health checks still answer, with a status and nothing
   * else. Server-only; never sent to a browser.
   */
  OPERATIONS_TOKEN: z.string().min(32).optional(),
  /**
   * Optional dead-man's-switch URL (healthchecks.io, Cronitor, Better Stack
   * heartbeats — any service that alerts when pings STOP). The worker route
   * GETs it after each successful invocation, with no body. HTTPS only. Often
   * contains a secret path segment, so it is never logged.
   */
  BANK_SYNC_HEARTBEAT_URL: z.url().startsWith("https://").optional(),
  /**
   * Key material for encrypting provider credentials at rest
   * (src/server/bank-connections/credential-crypto.ts).
   *
   * `<key-id>:<base64 32 bytes>`, newest first, comma-separated. The first
   * key encrypts; every key listed can decrypt, which is what makes rotation
   * possible without a flag day. See PLAID-INTEGRATION.md.
   *
   * `BANK_CREDENTIAL_ENCRYPTION_KEYS` is accepted as an alias, because the
   * value is a LIST of keys and that is what people type.
   */
  BANK_CREDENTIAL_ENCRYPTION_KEY: z.string().min(32).optional(),

  // -- Amazon Textract (document OCR) -----------------------------------
  // Server-only. Textract is called from the server with the document bytes
  // in the request body; no bucket is involved, so no S3 permission is
  // needed and the document never leaves Supabase Storage for another store.
  //
  // Credentials are OPTIONAL in two different senses. The region enables the
  // reader. The key pair is only needed where no ambient role exists: on a
  // platform that provides credentials itself (an EC2/ECS/Lambda task role,
  // or OIDC), leave both unset and the AWS SDK's default provider chain is
  // used instead, which is strictly better than a long-lived key.
  /** e.g. "us-east-1". Unset means no OCR reader in this deployment. */
  AWS_REGION: z.string().min(1).max(32).optional(),
  AWS_ACCESS_KEY_ID: z.string().min(16).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
});

/**
 * Plaid is configured only when the whole set is present.
 *
 * Reported as a thrown error at the first server call that needs secrets, not
 * silently degraded: a half-configured bank integration is worse than an
 * unconfigured one, because the failure lands on a customer mid-Link with
 * their bank credentials already entered.
 */
function assertBankConfigurationIsWhole(env: z.infer<typeof serverSchema>): void {
  const plaid = [
    ["PLAID_CLIENT_ID", env.PLAID_CLIENT_ID],
    ["PLAID_SECRET", env.PLAID_SECRET],
    ["PLAID_ENV", env.PLAID_ENV],
  ] as const;
  const present = plaid.filter(([, value]) => value !== undefined);
  if (present.length === 0) return;
  if (present.length !== plaid.length) {
    const missing = plaid.filter(([, value]) => value === undefined).map(([name]) => name);
    throw new Error(`Plaid is partly configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Set all of PLAID_CLIENT_ID, PLAID_SECRET and PLAID_ENV, or none of them.`);
  }
  if (!env.BANK_CREDENTIAL_ENCRYPTION_KEY) {
    throw new Error(
      "Plaid is configured but BANK_CREDENTIAL_ENCRYPTION_KEY is not. A bank access token must be encrypted before it is stored, so connecting a bank is refused until the key exists. See PLAID-INTEGRATION.md.",
    );
  }
}

/**
 * Textract is configured only in a shape that can actually authenticate.
 *
 * A region with exactly one half of a key pair is the failure that would
 * otherwise surface as an opaque AWS credential error on somebody's receipt,
 * so it is refused at configuration time instead.
 */
function assertTextractConfigurationIsWhole(env: z.infer<typeof serverSchema>): void {
  const hasId = env.AWS_ACCESS_KEY_ID !== undefined;
  const hasSecret = env.AWS_SECRET_ACCESS_KEY !== undefined;
  if (hasId !== hasSecret) {
    throw new Error(
      `AWS credentials are partly configured: ${hasId ? "AWS_SECRET_ACCESS_KEY" : "AWS_ACCESS_KEY_ID"} is missing. Set both, or neither to use the deployment's own IAM role.`,
    );
  }
  if (!env.AWS_REGION && (hasId || hasSecret)) {
    throw new Error("AWS credentials are set but AWS_REGION is not, so no Textract endpoint can be chosen. Set AWS_REGION, or unset the credentials.");
  }
}

let cachedServerEnv: z.infer<typeof serverSchema> | undefined;

/**
 * Server secrets. NEVER import this module from a file that can end up in
 * a Client Component bundle. Lazily validated (rather than at module load)
 * so importing this file doesn't crash tooling that doesn't need secrets
 * (e.g. a lint pass), while still failing fast the first time a secret is
 * actually needed.
 */
export function serverEnv() {
  if (typeof window !== "undefined") {
    throw new Error("serverEnv() must never be called from the client.");
  }
  if (!cachedServerEnv) {
    cachedServerEnv = serverSchema.parse({
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      DATABASE_URL: process.env.DATABASE_URL,
      RATE_LIMIT_HASH_SECRET: process.env.RATE_LIMIT_HASH_SECRET || undefined,
      PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID || undefined,
      PLAID_SECRET: process.env.PLAID_SECRET || undefined,
      PLAID_ENV: process.env.PLAID_ENV || undefined,
      PLAID_WEBHOOK_URL: process.env.PLAID_WEBHOOK_URL || undefined,
      PLAID_REDIRECT_URI: process.env.PLAID_REDIRECT_URI || undefined,
      BANK_SYNC_WORKER_SECRET: process.env.BANK_SYNC_WORKER_SECRET || undefined,
      CRON_SECRET: process.env.CRON_SECRET || undefined,
      OPERATIONS_TOKEN: process.env.OPERATIONS_TOKEN || undefined,
      BANK_SYNC_HEARTBEAT_URL: process.env.BANK_SYNC_HEARTBEAT_URL || undefined,
      // Both spellings are accepted, singular first. The keyset holds several
      // keys (rotation), so operators reasonably write the plural, and getting
      // it wrong would not fail at boot — it would fail on somebody who had
      // already typed their bank password, because the credential store would
      // be missing at exactly that moment.
      BANK_CREDENTIAL_ENCRYPTION_KEY: process.env.BANK_CREDENTIAL_ENCRYPTION_KEY || process.env.BANK_CREDENTIAL_ENCRYPTION_KEYS || undefined,
      AWS_REGION: process.env.AWS_REGION || undefined,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || undefined,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || undefined,
    });
    assertBankConfigurationIsWhole(cachedServerEnv);
    assertTextractConfigurationIsWhole(cachedServerEnv);
  }
  return cachedServerEnv;
}
