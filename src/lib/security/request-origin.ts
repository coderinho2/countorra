/**
 * Cross-site request forgery: refuse any state-changing request a browser
 * made on another site's behalf.
 *
 * THE FINDING (ZAP "Absence of Anti-CSRF Tokens", 2026-09-20)
 *
 * ZAP flagged the forgot-password and sign-in forms because neither carries a
 * hidden token field. What actually protected them was spread across two
 * mechanisms, neither of them ours and neither of them complete:
 *
 *   - Next.js compares a Server Action request's `Origin` with its `Host` and
 *     refuses a mismatch — but when `Origin` is missing it only logs a
 *     warning and runs the action anyway, and it does nothing at all for
 *     Route Handlers.
 *   - The Supabase session cookie is `SameSite=Lax`, which keeps it off a
 *     cross-site POST. That protects signed-in mutations; it does nothing for
 *     a signed-OUT form (login CSRF: signing a victim into an attacker's
 *     account, so what they enter lands in the attacker's books), and it
 *     relies on a cookie attribute rather than on the server deciding.
 *
 * THE FIX
 *
 * One server-side check, in src/proxy.ts, in front of every route: a
 * request whose method can change state (anything but GET, HEAD, OPTIONS) is
 * accepted only if the browser itself says it came from this origin. This is
 * OWASP's "Fetch Metadata" and "verify origin with standard headers" defence;
 * both headers are set by the browser and cannot be forged by page script.
 *
 *   1. `Sec-Fetch-Site`, when present, must be `same-origin`. Every current
 *      browser sends it. `same-site` is refused on purpose: a sibling
 *      subdomain is a different application, and exactly the kind of host
 *      that gets compromised or taken over.
 *   2. Otherwise `Origin`, when present, must be one of this deployment's own
 *      origins. The opaque origin `null` — sandboxed frames, some redirects —
 *      is refused.
 *   3. A request carrying neither header did not come from a browser page:
 *      every browser that implements CORS sends `Origin` on a cross-origin
 *      POST. Such a caller has no victim's ambient cookies to ride, so there
 *      is no forgery to stop, and refusing it would only break server-to-
 *      server callers that authenticate themselves.
 *
 * Why not a synchronizer token as well: its only advantage over the above is
 * against browsers that send neither `Origin` nor `Sec-Fetch-Site` on a
 * cross-site POST, which no supported browser does — and SameSite=Lax still
 * stands behind this for the signed-in case.
 *
 * Some endpoints are called cross-site by design and authenticate the caller
 * themselves; see CROSS_SITE_ENDPOINTS.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Endpoints whose legitimate callers are other systems, not this site's pages.
 * Each authenticates every request by something a forger cannot have, and
 * none of them reads the session cookie — so there is no ambient credential
 * for a forged request to borrow.
 */
const CROSS_SITE_ENDPOINTS: { pattern: RegExp; reason: string }[] = [
  { pattern: /^\/api\/stripe\/webhook\/?$/, reason: "Stripe signature over the raw body" },
  { pattern: /^\/api\/bank-connections\/webhooks\/[^/]+\/?$/, reason: "provider signature over the raw body" },
  // RFC 8058 one-click unsubscribe: the mail provider POSTs from its own
  // servers. Authorized by the HMAC in the link, never by a cookie.
  { pattern: /^\/unsubscribe\/?$/, reason: "HMAC token in the link" },
];

export function isCrossSiteEndpoint(pathname: string): boolean {
  return CROSS_SITE_ENDPOINTS.some(({ pattern }) => pattern.test(pathname));
}

export interface OriginCheckInput {
  method: string;
  pathname: string;
  /** `Sec-Fetch-Site`, verbatim, or null. */
  secFetchSite: string | null;
  /** `Origin`, verbatim, or null. */
  origin: string | null;
  /** This deployment's own origins, e.g. the request's origin and NEXT_PUBLIC_APP_URL's. */
  allowedOrigins: readonly string[];
}

export type OriginCheckResult = { allowed: true } | { allowed: false; reason: "cross-site-fetch" | "foreign-origin" };

export function checkRequestOrigin({ method, pathname, secFetchSite, origin, allowedOrigins }: OriginCheckInput): OriginCheckResult {
  if (SAFE_METHODS.has(method.toUpperCase())) return { allowed: true };
  if (isCrossSiteEndpoint(pathname)) return { allowed: true };

  if (secFetchSite !== null) {
    return secFetchSite === "same-origin" ? { allowed: true } : { allowed: false, reason: "cross-site-fetch" };
  }

  if (origin !== null) {
    return allowedOrigins.includes(origin) ? { allowed: true } : { allowed: false, reason: "foreign-origin" };
  }

  return { allowed: true };
}
