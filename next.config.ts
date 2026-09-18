import type { NextConfig } from "next";
import { SERVER_ACTION_BODY_LIMIT } from "./src/domain/documents/upload-limits";

/**
 * Response security headers. There were none before this — no clickjacking
 * protection, no HSTS, no MIME-sniffing protection, and a default
 * `Referrer-Policy` that could leak an `/app/<orgId>/invoices/<invoiceId>`
 * URL (organization and record ids, in the path) to any third-party host a
 * user navigates to.
 *
 * What's deliberately NOT here: a `script-src` CSP. Next.js's App Router
 * emits inline bootstrap and flight-data scripts, so a useful `script-src`
 * needs per-request nonces plumbed through the proxy, and a `script-src`
 * with `'unsafe-inline'` is theatre — it would advertise a protection that
 * isn't there. The directives below are the ones that are meaningful
 * without nonces and that cannot break a legitimate page:
 * `frame-ancestors` (clickjacking, and it supersedes X-Frame-Options),
 * `base-uri` (stops an injected `<base>` from re-pointing every relative
 * URL), `form-action` (stops a form being posted to an attacker's host),
 * and `object-src` (plugin content). Adding a real nonce-based script-src
 * is tracked as remaining work in the audit report, not silently skipped.
 *
 * `connect-src` is left open on purpose: the browser client talks directly
 * to the project's Supabase host, which is environment-specific, and a
 * wrong value here fails closed in a way that looks like an outage.
 */
/**
 * Note the absence of `default-src`. Adding it looks like a free win and is
 * not: `default-src 'self'` becomes the fallback for `script-src` and
 * `style-src`, which blocks the inline bootstrap/flight scripts the App
 * Router emits — the e2e suite caught this immediately, with server-rendered
 * pages that never hydrated, so every interactive control silently stopped
 * responding. Each directive below is one that changes nothing for a
 * legitimate page.
 */
const CONTENT_SECURITY_POLICY = [
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  // Two years, preloadable. Only ever honoured over HTTPS, so it is inert
  // on http://localhost during development.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // Send the origin, never the path, cross-origin: /app/<orgId>/... paths
  // carry tenant and record identifiers.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // Nothing in this product uses these; deny them rather than inherit the
  // browser default.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
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

  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
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
