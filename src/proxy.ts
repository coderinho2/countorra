import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";
import { reportEvent, requestIdFrom } from "@/lib/observability";
import { buildContentSecurityPolicy, generateNonce } from "@/lib/security/content-security-policy";
import { checkRequestOrigin } from "@/lib/security/request-origin";
import { sessionCookieOptions } from "@/lib/security/session-cookies";

/**
 * Runs in front of every page and route (see `config.matcher`). In order:
 *
 *   1. Refuses cross-site state-changing requests (src/lib/security/
 *      request-origin.ts), before anything else is spent on them.
 *   2. Generates this response's CSP nonce and gives it to Next.js through
 *      the forwarded request's own `Content-Security-Policy` header, which is
 *      where Next looks for it when stamping its scripts
 *      (src/lib/security/content-security-policy.ts).
 *   3. Refreshes the Supabase session cookie (required by @supabase/ssr so a
 *      Server Component's session doesn't silently expire mid-visit), with
 *      the same cookie attributes src/server/supabase/server.ts uses.
 *   4. Enforces the one hard boundary that belongs at this layer:
 *      unauthenticated requests to /app/* redirect to /login. Per-org
 *      membership/role checks happen deeper, in
 *      src/server/auth/session.ts#requireOrgMembership — the proxy only knows
 *      "is there a session", not "does this session belong to this org".
 */
export async function proxy(request: NextRequest) {
  const origin = checkRequestOrigin({
    method: request.method,
    pathname: request.nextUrl.pathname,
    secFetchSite: request.headers.get("sec-fetch-site"),
    origin: request.headers.get("origin"),
    allowedOrigins: [request.nextUrl.origin, new URL(publicEnv.NEXT_PUBLIC_APP_URL).origin],
  });
  if (!origin.allowed) {
    reportEvent("security.cross_site_request_refused", { scope: "security", detail: { reason: origin.reason, method: request.method } }, "warning");
    return new NextResponse("Cross-site request refused.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const contentSecurityPolicy = buildContentSecurityPolicy({
    nonce: generateNonce(),
    supabaseUrl: publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    plaidEnv: plaidEnvironment(),
    development: process.env.NODE_ENV === "development",
  });
  // Forwarded to the render: Next.js reads the nonce out of this header and
  // applies it to every script it emits.
  request.headers.set("content-security-policy", contentSecurityPolicy);
  // One correlation id per request, forwarded to the render and the server
  // actions (read back with `requestIdFrom`) and returned to the caller, so a
  // support report can quote it and a log search can find every line of it.
  const requestId = requestIdFrom(request.headers);
  request.headers.set("x-request-id", requestId);

  let response = NextResponse.next({ request });

  const supabase = createServerClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    // HttpOnly, Secure over HTTPS, SameSite=Lax — see session-cookies.ts.
    // Must match src/server/supabase/server.ts, the other place these
    // cookies are written.
    cookieOptions: sessionCookieOptions({ appUrl: publicEnv.NEXT_PUBLIC_APP_URL, onVercel: process.env.VERCEL === "1" }),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && request.nextUrl.pathname.startsWith("/app")) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirectTo", request.nextUrl.pathname);
    return withRequestId(withContentSecurityPolicy(NextResponse.redirect(loginUrl), contentSecurityPolicy), requestId);
  }

  return withRequestId(withContentSecurityPolicy(response, contentSecurityPolicy), requestId);
}

function withRequestId(response: NextResponse, requestId: string): NextResponse {
  response.headers.set("x-request-id", requestId);
  return response;
}

function withContentSecurityPolicy(response: NextResponse, policy: string): NextResponse {
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

/** Which Plaid API host the page may call, if bank connections are configured
 *  at all. Only the environment name is read — never a credential. */
function plaidEnvironment(): "sandbox" | "production" | undefined {
  const value = process.env.PLAID_ENV;
  return value === "sandbox" || value === "production" ? value : undefined;
}

export const config = {
  matcher: [
    /*
     * Skip static assets and Next.js internals — matching those would
     * needlessly call Supabase on every image/font request. They get their
     * headers, including a CSP that permits nothing, from next.config.ts.
     *
     * `api/stripe` is skipped for a different reason. The webhook carries no
     * session cookie and authenticates itself by signature, so refreshing a
     * session here achieves nothing — it just adds a Supabase round trip, and
     * a failure mode, to the request path of an endpoint Stripe retries on
     * any non-2xx. Its own authentication is strictly stronger than this
     * layer's: see src/app/api/stripe/webhook/route.ts.
     *
     * `api/health` and `api/operations` are skipped so a health check never
     * depends on — or spends — a Supabase auth round trip: liveness must
     * answer even when auth is down. They carry no session; the detailed
     * views authenticate with OPERATIONS_TOKEN themselves.
     *
     * `api/bank-connections/webhooks` is skipped for the same reason: a bank
     * provider's webhook has no session and is verified by its own signature
     * (src/server/bank-connections/webhooks.ts). Both are also listed as
     * cross-site endpoints in request-origin.ts, so the origin check would
     * pass them even if this exclusion were ever removed.
     */
    "/((?!_next/static|_next/image|favicon.ico|api/stripe|api/bank-connections/webhooks|api/health|api/operations|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)",
  ],
};
