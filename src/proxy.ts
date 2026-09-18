import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";

/**
 * Refreshes the Supabase session cookie on every request (required by
 * @supabase/ssr so a Server Component's session doesn't silently expire
 * mid-visit) and enforces the one hard boundary that belongs at this
 * layer: unauthenticated requests to /app/* redirect to /login. Per-org
 * membership/role checks happen deeper, in
 * src/server/auth/session.ts#requireOrgMembership — middleware only knows
 * "is there a session", not "does this session belong to this org".
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
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
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && request.nextUrl.pathname.startsWith("/app")) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirectTo", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Skip static assets and Next.js internals — matching those would
     * needlessly call Supabase on every image/font request.
     *
     * `api/stripe` is skipped for a different reason. The webhook carries no
     * session cookie and authenticates itself by signature, so refreshing a
     * session here achieves nothing — it just adds a Supabase round trip, and
     * a failure mode, to the request path of an endpoint Stripe retries on
     * any non-2xx. Its own authentication is strictly stronger than this
     * layer's: see src/app/api/stripe/webhook/route.ts.
     *
     * `api/bank-connections/webhooks` is skipped for the same reason: a bank
     * provider's webhook has no session and is verified by its own signature
     * (src/server/bank-connections/webhooks.ts).
     */
    "/((?!_next/static|_next/image|favicon.ico|api/stripe|api/bank-connections/webhooks|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)",
  ],
};
