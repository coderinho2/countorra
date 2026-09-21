import type { NextConfig } from "next";
import { SERVER_ACTION_BODY_LIMIT } from "./src/domain/documents/upload-limits";
import { STATIC_ASSET_CONTENT_SECURITY_POLICY } from "./src/lib/security/content-security-policy";

/**
 * Response security headers.
 *
 * WHERE EACH ONE IS SET
 *
 * The Content-Security-Policy for pages is NOT here. It carries a fresh nonce
 * per response, so it is built in src/proxy.ts
 * (src/lib/security/content-security-policy.ts). It must not be set here as
 * well: a response with two CSP headers is held to both, and a static one
 * cannot carry the nonce — every script on every page would be blocked.
 *
 * What IS here applies to every response, including the ones the proxy never
 * sees: `_next/static`, files in `public/`, and the two webhook endpoints.
 */
const baseSecurityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Superseded by CSP `frame-ancestors 'none'`; kept for browsers that
  // predate it.
  { key: "X-Frame-Options", value: "DENY" },
  // Send the origin, never the path, cross-origin: /app/<orgId>/... paths
  // carry tenant and record identifiers.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // Nothing in this product uses these; deny them rather than inherit the
  // browser default.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
];

/**
 * HSTS: production only, and deliberately without `includeSubDomains` or
 * `preload`.
 *
 * The previous value was `max-age=63072000; includeSubDomains; preload` on
 * every deployment. Both extra flags are commitments about hosts this
 * repository does not control or know: `includeSubDomains` forces every
 * current and future *.countorra.com name onto HTTPS for two years — any
 * subdomain a mail, docs or status provider serves over plain HTTP
 * becomes unreachable — and `preload` invites browsers to hard-code that,
 * a decision that takes months to reverse. hstspreload.org reports the
 * domain as not submitted, so nothing is lost by withdrawing the invitation.
 * Add either flag back only after every subdomain has been verified to serve
 * HTTPS.
 *
 * `VERCEL_ENV === "production"` is the deployment signal the rest of the
 * app uses (src/lib/env.ts). Vercel serves production only over HTTPS and
 * redirects plain HTTP with a 308 before the app runs, so this header only
 * ever travels over HTTPS. Browsers ignore it over HTTP regardless, which is
 * why local `next start` needs no special case.
 */
const HSTS_HEADER = { key: "Strict-Transport-Security", value: "max-age=63072000" };

/**
 * Files served without the proxy — build output and `public/` — are never
 * pages, so they get a policy that permits nothing. (An SVG opened directly
 * is a document that can run script; this is what stops one from doing so.)
 *
 * They also get an explicit `Access-Control-Allow-Origin` naming this app.
 * Vercel's CDN otherwise answers static and prerendered files with
 * `Access-Control-Allow-Origin: *` — the "Cross-Domain Misconfiguration" ZAP
 * reported. Countorra's own pages load these files same-origin and need no
 * CORS grant at all; the header only narrows who else may read them.
 */
const APP_ORIGIN = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").origin;
const staticAssetHeaders = [
  { key: "Content-Security-Policy", value: STATIC_ASSET_CONTENT_SECURITY_POLICY },
  { key: "Access-Control-Allow-Origin", value: APP_ORIGIN },
];

const nextConfig: NextConfig = {
  // Don't advertise the framework version to scanners.
  poweredByHeader: false,

  experimental: {
    serverActions: {
      /**
       * Back down from 20 MB, because nothing needs 20 MB any more.
       *
       * This was raised so `uploadDocumentAction` could receive a file. It
       * could not be scoped to that one action — `bodySizeLimit` is global —
       * so every authenticated Server Action in the product accepted a 20 MB
       * body before its own validation ran, to serve one upload path.
       *
       * Uploads now go directly to Storage over a signed URL
       * (src/server/documents/actions.ts). The actions on that path exchange a
       * filename and two UUIDs. Keeping the 20 MB window open would be paying
       * a global cost for a capability no longer in use.
       */
      bodySizeLimit: SERVER_ACTION_BODY_LIMIT,
    },
  },

  /**
   * Countorra launches personal-only (src/domain/organizations/launch-scope.ts).
   * The Solutions index and the Freelancer and Business pages are retired;
   * permanent redirects keep every existing link and search result landing on
   * the product as it is, rather than on a 404.
   */
  async redirects() {
    return [
      { source: "/solutions", destination: "/solutions/personal", permanent: true },
      { source: "/solutions/freelancer", destination: "/solutions/personal", permanent: true },
      { source: "/solutions/business", destination: "/solutions/personal", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: process.env.VERCEL_ENV === "production" ? [...baseSecurityHeaders, HSTS_HEADER] : baseSecurityHeaders,
      },
      // Exactly the paths src/proxy.ts's matcher excludes.
      { source: "/_next/static/:path*", headers: staticAssetHeaders },
      { source: "/_next/image", headers: staticAssetHeaders },
      { source: "/:file(.*\\.(?:svg|png|jpg|jpeg|webp|ico))", headers: staticAssetHeaders },
      { source: "/api/stripe/:path*", headers: [{ key: "Content-Security-Policy", value: STATIC_ASSET_CONTENT_SECURITY_POLICY }] },
      { source: "/api/bank-connections/webhooks/:path*", headers: [{ key: "Content-Security-Policy", value: STATIC_ASSET_CONTENT_SECURITY_POLICY }] },
      {
        // Authenticated pages must never sit in a shared or browser cache:
        // a back-button read of another user's dashboard on a shared
        // machine is a real leak, and these pages are all dynamic anyway.
        source: "/app/:path*",
        headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
