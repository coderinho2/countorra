/**
 * The document Content-Security-Policy, built per request.
 *
 * THE FINDINGS THIS REPLACES (ZAP, 2026-09-20)
 *
 * The previous policy was five directives — `base-uri`, `form-action`,
 * `frame-ancestors`, `object-src`, `upgrade-insecure-requests` — and nothing
 * else. With no `default-src`, every fetch directive falls back to "allow
 * anything": scripts, styles, images, fonts, frames and connections from any
 * host, and inline script and style of any kind. ZAP reported that as a
 * wildcard directive, `script-src 'unsafe-inline'` and `style-src
 * 'unsafe-inline'`, and it was right on all three: an HTML-injection bug
 * anywhere in the product would have been a full XSS.
 *
 * It was left that way because the App Router emits inline bootstrap and
 * flight-data scripts, so a real `script-src` needs a per-request nonce. That
 * is now what happens: src/proxy.ts generates one, hands it to Next.js through
 * the request's own CSP header (which is how Next finds it and stamps it onto
 * every script it renders), and sends this policy on the response.
 *
 * WHAT EACH DIRECTIVE ALLOWS, AND WHY
 *
 *   script-src   Only scripts carrying this response's nonce, plus scripts
 *                those scripts load (`'strict-dynamic'`). That is how Next's
 *                chunk loader and Plaid Link's on-demand loader keep working
 *                without listing either as a trusted host. `'self'` and the
 *                Plaid host are CSP-level-2 fallbacks only; a browser that
 *                understands `'strict-dynamic'` ignores them.
 *                No `'unsafe-inline'`. `'unsafe-eval'` in development only,
 *                where React's dev tooling requires it.
 *   style-src    Stylesheets from this origin and nonce-bearing `<style>`
 *                elements. No `'unsafe-inline'`.
 *   style-src-attr  `'unsafe-inline'` — the one deliberate exception, scoped
 *                to `style="…"` ATTRIBUTES only. React server-renders every
 *                `style={…}` prop as an attribute, and motion/react
 *                server-renders its initial animation state the same way;
 *                blocking them breaks layout on first paint. An attribute
 *                cannot contain selectors or `@import`, so it cannot be used
 *                for the CSS-selector data-exfiltration that makes inline
 *                `<style>` dangerous, and `img-src`/`font-src` below stop a
 *                `url(…)` in one from reaching another host.
 *   connect-src  This origin, the project's Supabase host (document uploads
 *                go straight to Storage over a signed URL), and Plaid's API
 *                host for the configured environment.
 *   frame-src    Plaid Link's iframe, and nothing else.
 *   img-src      This origin, plus `data:` and `blob:` for images generated in
 *                the page. No remote hosts.
 *   font-src     This origin: next/font self-hosts every face.
 *
 * Stripe is deliberately absent. Checkout and the Customer Portal are
 * top-level redirects, which CSP does not govern; no Stripe script, frame or
 * API call runs inside a Countorra page.
 */

export interface ContentSecurityPolicyInput {
  /** Fresh, unguessable, per-response. */
  nonce: string;
  /** `NEXT_PUBLIC_SUPABASE_URL`. Only its origin is used. */
  supabaseUrl: string;
  /** `PLAID_ENV`, when bank connections are configured. */
  plaidEnv?: "sandbox" | "production";
  /** `next dev`: allows eval and the HMR websocket, and nothing more. */
  development: boolean;
}

export const PLAID_LINK_ORIGIN = "https://cdn.plaid.com";

const PLAID_API_ORIGIN = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
} as const;

export function buildContentSecurityPolicy({ nonce, supabaseUrl, plaidEnv, development }: ContentSecurityPolicyInput): string {
  const supabaseOrigin = new URL(supabaseUrl).origin;

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      PLAID_LINK_ORIGIN,
      ...(development ? ["'unsafe-eval'"] : []),
    ],
    // Next's dev server injects un-nonced <style> elements for CSS hot
    // reload. That exception exists only under `next dev`.
    "style-src": development ? ["'self'", "'unsafe-inline'"] : ["'self'", `'nonce-${nonce}'`],
    "style-src-attr": ["'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'"],
    "connect-src": [
      "'self'",
      supabaseOrigin,
      ...(plaidEnv ? [PLAID_API_ORIGIN[plaidEnv]] : []),
      ...(development ? ["ws:"] : []),
    ],
    "frame-src": [PLAID_LINK_ORIGIN],
    "media-src": ["'none'"],
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };

  const policy = Object.entries(directives).map(([name, sources]) => `${name} ${sources.join(" ")}`);
  // Over plain-HTTP localhost this would rewrite subresource URLs to an
  // https:// origin that does not exist.
  if (!development) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}

/**
 * 128 bits from the platform CSPRNG, base64-encoded. Available in both the
 * Node and edge runtimes, so the proxy does not care which it runs on.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The policy for responses the proxy never sees — files served straight from
 * `public/` (SVG, images, icons). None of them is a page, so none needs to
 * run anything. An SVG opened directly is a document that can carry script,
 * so it gets a policy that permits nothing at all.
 */
export const STATIC_ASSET_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
