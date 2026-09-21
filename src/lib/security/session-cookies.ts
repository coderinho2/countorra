/**
 * Attributes for every cookie Supabase Auth writes: the session tokens and
 * the PKCE code verifiers for sign-up, password reset and email change.
 *
 * THE FINDING (ZAP "Cookie No HttpOnly Flag" / "Cookie Without Secure Flag",
 * 2026-09-20)
 *
 * ZAP submitted the forgot-password form and got back three
 * `sb-…-code-verifier` cookies with neither flag. That is @supabase/ssr's
 * default (`httpOnly: false`, no `secure`), applied to every auth cookie,
 * session tokens included. The default exists so a browser-side Supabase
 * client can read the session from `document.cookie`.
 *
 * WHY HttpOnly IS SAFE HERE
 *
 * Nothing in the browser reads the session. Every sign-in, sign-up, reset,
 * code exchange and token refresh runs on the server (src/server/auth/,
 * src/app/auth/callback, src/proxy.ts). The browser Supabase client is used
 * in exactly one place that runs in the browser — the document upload dialog
 * — and that call, `uploadToSignedUrl`, is authorized by the single-use token
 * in the signed URL the server issued, not by the session. So the one thing
 * `httpOnly: false` enables, script access to the tokens, is used by nothing
 * in Countorra and available to any XSS.
 *
 * `Secure` is set whenever the app is served over HTTPS: always on Vercel,
 * and whenever NEXT_PUBLIC_APP_URL is https. Plain-HTTP localhost is the one
 * exception, because Safari drops `Secure` cookies set over http://localhost
 * and local sign-in would silently stop working there.
 *
 * `SameSite=Lax` is kept rather than tightened to `Strict`: `Strict` would
 * drop the session on every inbound top-level navigation — following an
 * invoice link from an email, or returning from Stripe Checkout or a bank's
 * OAuth page — and the app would appear signed out. Cross-site POSTs are
 * refused regardless (src/lib/security/request-origin.ts).
 *
 * Existing browsers pick the new attributes up the next time Supabase
 * rewrites the cookies, which it does on every token refresh.
 */

export interface SessionCookieOptions {
  path: "/";
  sameSite: "lax";
  httpOnly: true;
  secure: boolean;
}

export function sessionCookieOptions({ appUrl, onVercel }: { appUrl: string; onVercel: boolean }): SessionCookieOptions {
  return {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: onVercel || new URL(appUrl).protocol === "https:",
  };
}
