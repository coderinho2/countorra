import { z } from "zod";

/**
 * Centralized, validated environment access. Nothing in this codebase
 * should read `process.env.*` directly outside this file — that keeps
 * every secret's blast radius auditable in one place (DESIGN §17 Security).
 */

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  /**
   * The default is a DEVELOPMENT convenience only — it lets a fresh clone run
   * `npm run dev` with no `.env.local` at all. It is not a production
   * fallback: `assertDeployableAppUrl` below rejects it (and any other local
   * hostname) in a deployed environment, so an unset variable fails the build
   * rather than shipping localhost links.
   */
  NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3000"),
});

/**
 * Safe to import from Client Components — these are inlined at build time
 * and contain no secrets (Supabase's anon key is designed to be public;
 * access control is enforced by RLS, not by hiding this key).
 */
export const publicEnv = publicSchema.parse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
});

/**
 * `NEXT_PUBLIC_APP_URL` is not cosmetic — it is the single origin the whole
 * product publishes about itself:
 *
 *   signUp          -> `${APP_URL}/auth/callback`   (src/server/auth/actions.ts)
 *   password reset  -> `${APP_URL}/auth/callback?flow=recovery` (src/server/auth/actions.ts)
 *   metadataBase    -> canonical + OG + Twitter     (src/app/layout.tsx)
 *   robots.txt      -> sitemap location             (src/app/robots.ts)
 *   sitemap.xml     -> every indexed URL            (src/app/sitemap.ts)
 *
 * Deployed with the localhost default still in place, every confirmation and
 * reset email sends real users to a machine that is not the server, Supabase's
 * redirect allowlist rejects the callback, and every canonical tag and sitemap
 * entry names a host nobody can reach. The failure is total and silent at
 * deploy time — visible only once someone tries to confirm an account.
 *
 * WHY THIS IS CHECKED AT MODULE LOAD
 *
 * `next build` prerenders the static routes, and those routes import this
 * module, so the throw below happens during the BUILD rather than on the
 * first request. That matters more than it looks: `NEXT_PUBLIC_*` values are
 * inlined into the bundle at build time, so a correct value supplied only at
 * runtime arrives too late — the localhost string is already compiled in.
 * Failing the build is the last moment the mistake is still cheap.
 *
 * WHICH SIGNAL, AND WHY NOT `NODE_ENV`
 *
 * `NODE_ENV` is "production" for a local `next build && next start`, which is
 * exactly how the E2E suite runs against localhost on purpose, and how any
 * developer checks a production build. Keying on it would fail those for no
 * reason, and the pressure would then be to weaken the check.
 *
 * `VERCEL_ENV` names the actual deployment context. Both `production` and
 * `preview` are checked: a preview deployment mailing localhost links is
 * broken in exactly the same way, just to fewer people. `development` (i.e.
 * `vercel dev`) is excluded, because localhost is correct there.
 *
 * KNOWN LIMIT, STATED RATHER THAN IMPLIED
 *
 * This guard is Vercel-specific. A deployment to any other host sets no
 * `VERCEL_ENV`, so it would boot with the localhost default unchallenged.
 * There is no universal "am I deployed?" signal that a local production build
 * does not also match, so the alternative is a flag every local build has to
 * set — which is the kind of opt-out that ends up in a committed `.env` file
 * and silently disables the check everywhere. If this ever ships somewhere
 * other than Vercel, add that host's own environment signal to
 * `isDeployedEnvironment` in the same change.
 */
const DEPLOYED_VERCEL_ENVIRONMENTS = new Set(["production", "preview"]);

/** Whether this process is a real deployment, as opposed to local
 *  development or a local production build. */
export function isDeployedEnvironment(vercelEnv: string | undefined = process.env.VERCEL_ENV): boolean {
  return vercelEnv !== undefined && DEPLOYED_VERCEL_ENVIRONMENTS.has(vercelEnv);
}

/** Hostnames that can only ever mean "this machine". */
function isLocalHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost")
  );
}

export function assertDeployableAppUrl(url: string, vercelEnv: string | undefined = process.env.VERCEL_ENV): void {
  if (!isDeployedEnvironment(vercelEnv)) return;

  const { hostname, protocol } = new URL(url);

  if (isLocalHostname(hostname)) {
    throw new Error(
      `NEXT_PUBLIC_APP_URL is "${url}" in a ${vercelEnv} deployment. Confirmation and password-reset emails would send users to localhost, and every canonical URL would name a host nobody can reach. Set NEXT_PUBLIC_APP_URL to the deployed origin in the Vercel project's environment variables and REDEPLOY — the value is inlined at build time, so setting it without a rebuild changes nothing. Then add that origin to Supabase → Authentication → URL Configuration.`,
    );
  }

  // A deployed origin served over plain HTTP would put session cookies and
  // password-reset links on the wire in clear, and contradicts the HSTS header
  // this app already sends (next.config.ts).
  if (protocol !== "https:") {
    throw new Error(
      `NEXT_PUBLIC_APP_URL is "${url}" in a ${vercelEnv} deployment, which is not HTTPS. Auth links and session cookies would travel unencrypted. Use the https:// origin.`,
    );
  }
}

assertDeployableAppUrl(publicEnv.NEXT_PUBLIC_APP_URL);

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
      BANK_SYNC_HEARTBEAT_URL: process.env.BANK_SYNC_HEARTBEAT_URL || undefined,
      // Both spellings are accepted, singular first. The keyset holds several
      // keys (rotation), so operators reasonably write the plural, and getting
      // it wrong would not fail at boot — it would fail on somebody who had
      // already typed their bank password, because the credential store would
      // be missing at exactly that moment.
      BANK_CREDENTIAL_ENCRYPTION_KEY: process.env.BANK_CREDENTIAL_ENCRYPTION_KEY || process.env.BANK_CREDENTIAL_ENCRYPTION_KEYS || undefined,
    });
    assertBankConfigurationIsWhole(cachedServerEnv);
  }
  return cachedServerEnv;
}
