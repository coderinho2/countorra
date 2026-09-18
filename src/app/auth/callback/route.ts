import { NextResponse } from "next/server";
import { createClient } from "@/server/supabase/server";
import { callbackDestination, callbackOutcome, flowHint, shouldExchange } from "@/lib/auth-callback";

/**
 * Exchanges the code Supabase sends in an emailed link for a real session, on
 * the server, using the PKCE verifier cookie of the browser that asked for the
 * link. Two flows use it: sign-up confirmation (`emailRedirectTo` in `signUp`)
 * and password recovery (`redirectTo` in `requestPasswordReset`), both in
 * src/server/auth/actions.ts.
 *
 * Which page the visitor lands on is decided in src/lib/auth-callback.ts —
 * including a link opened in a different browser, where Supabase has already
 * accepted the link but PKCE (correctly) refuses to create a session, and a
 * recovery exchange, which always lands on /reset-password.
 *
 * The code is exchanged at most once per visit and never forwarded: every
 * destination is a fixed path, or `?redirectTo=` after `safeRedirectPath`
 * (src/lib/safe-redirect.ts) — see that module for the open redirect this
 * previously allowed.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const providerErrorCode = searchParams.get("error_code") ?? searchParams.get("error");

  let exchangeError: unknown = null;
  let redirectType: string | null = null;
  if (shouldExchange(code, providerErrorCode)) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    exchangeError = error;
    // auth-js returns `redirectType` — read from the verifier cookie — at
    // runtime but does not declare it on this method's type. The mechanism
    // test in tests/server/auth-callback-route.test.ts pins that it is there.
    redirectType = (data as { redirectType?: string | null } | null)?.redirectType ?? null;
  }

  const outcome = callbackOutcome({ code, providerErrorCode, exchangeError, redirectType });
  return NextResponse.redirect(new URL(callbackDestination(outcome, searchParams.get("redirectTo"), flowHint(searchParams.get("flow"))), origin));
}
