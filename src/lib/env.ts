import { z } from "zod";

/**
 * PUBLIC environment — the half that is safe in a browser bundle.
 *
 * Only `NEXT_PUBLIC_*` values live here, plus the deploy-time check on the
 * app URL. Client Components import this module (through
 * src/server/supabase/client.ts, for one), and whatever it contains ships to
 * every visitor. So it contains nothing secret — not even the NAMES of the
 * server's secrets, which used to travel along inside the server schema.
 *
 * Server secrets are in src/lib/server-env.ts, which begins with
 * `import "server-only"`: a Client Component that reaches it fails the build
 * instead of shipping it. tests/security/browser-bundle-env.test.ts checks
 * the built client output for both the names and the values.
 *
 * Nothing in this codebase should read `process.env.*` directly outside these
 * two files (and the Stripe configuration, which is server-only for the same
 * reason) — that keeps every secret's blast radius auditable in one place
 * (DESIGN §17 Security).
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
