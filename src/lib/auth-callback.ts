import { isAuthPKCECodeVerifierMissingError } from "@supabase/supabase-js";
import { safeRedirectPath } from "@/lib/safe-redirect";

/**
 * What a visit to /auth/callback means, decided without touching the network.
 *
 * THE BUG THIS REPLACED
 *
 * Every failure used to land on `/login?linkExpired=1`. The most common
 * "failure" was not one: Countorra signs people up on the server through
 * @supabase/ssr, which uses PKCE, so the code verifier needed to finish the
 * exchange lives in a cookie in THE BROWSER THAT SUBMITTED THE SIGN-UP FORM.
 * Open the confirmation email on a phone, or in a different browser, and
 * Supabase has already confirmed the address (its /verify endpoint does that
 * before redirecting here with a code) — but the exchange cannot run, because
 * that browser has no verifier. The person was told their link had expired,
 * when in fact their account was confirmed and a password sign-in would work.
 *
 * WHAT IS DELIBERATELY NOT CHANGED
 *
 * No session is ever created without the verifier: the PKCE check is the
 * library's, and this code only chooses which page to show afterwards.
 * Confirmation stays mandatory. And the outcome for a missing verifier is the
 * same for any code, genuine or forged, so the page reveals nothing about
 * whether a given link was ever valid — its wording is conditional for exactly
 * that reason.
 *
 * TWO FLOWS COME THROUGH HERE
 *
 * Sign-up confirmation, and password recovery (`requestPasswordReset` points
 * its link here — the reset page used to receive the code and never exchange
 * it, so no reset could ever succeed). They are told apart in two ways that
 * carry very different weight:
 *
 *   `redirectType` — AUTHORITATIVE. auth-js stores the recovery verifier as
 *   "<verifier>/recovery" when THIS server requests the reset, and reports it
 *   back from the exchange. It comes from a cookie set by our own server call,
 *   never from the URL, and it only exists after a successful exchange. It is
 *   the only thing that sends a visitor to /reset-password — and even there,
 *   the page and action re-check the verified session (src/server/auth/recovery.ts).
 *
 *   `flow=recovery` — A HINT. Part of the link, so anyone can add or remove
 *   it. It only chooses which help page a FAILED link lands on, so a person
 *   whose reset link expired is sent to request a new one rather than to a
 *   sign-in page that assumes they know their password. It grants nothing: a
 *   successful exchange ignores it entirely.
 */

export type CallbackOutcome =
  /** The exchange succeeded; a session exists in this browser. */
  | "signed_in"
  /** The exchange succeeded, and the verifier this browser stored when the
   *  reset was requested marks it as password recovery. */
  | "recovery"
  /** Supabase handed over a code, but this browser holds no PKCE verifier —
   *  the link was opened somewhere other than where it was requested. */
  | "opened_in_other_browser"
  /** Supabase reported an error, there was no code, or the exchange failed
   *  for any other reason. Spent, expired or tampered — deliberately not
   *  distinguished. */
  | "link_invalid";

export interface CallbackInput {
  code: string | null;
  /** `error_code` Supabase appends when it refuses a link, e.g. `otp_expired`. */
  providerErrorCode: string | null;
  /** The error from `exchangeCodeForSession`, when one was attempted. */
  exchangeError: unknown;
  /** `redirectType` from a successful `exchangeCodeForSession`. Server-held. */
  redirectType?: string | null;
}

/** Which kind of link the URL claims to be. Untrusted; see the header. */
export type FlowHint = "recovery" | null;

export function flowHint(raw: string | null): FlowHint {
  return raw === "recovery" ? "recovery" : null;
}

/**
 * Whether to attempt an exchange at all.
 *
 * Not when Supabase has already said the link is bad: there is nothing to
 * exchange, and trying would only add a request whose answer is known.
 */
export function shouldExchange(code: string | null, providerErrorCode: string | null): code is string {
  return Boolean(code) && !providerErrorCode;
}

export function callbackOutcome({ code, providerErrorCode, exchangeError, redirectType = null }: CallbackInput): CallbackOutcome {
  if (!shouldExchange(code, providerErrorCode)) return "link_invalid";
  if (!exchangeError) return redirectType === "recovery" ? "recovery" : "signed_in";
  if (isAuthPKCECodeVerifierMissingError(exchangeError)) return "opened_in_other_browser";
  return "link_invalid";
}

/** The same-origin path to send the visitor to. `redirectTo` is untrusted and
 *  goes through `safeRedirectPath`; only an ordinary sign-in may use it. */
export function callbackDestination(outcome: CallbackOutcome, redirectTo: string | null, hint: FlowHint = null): string {
  switch (outcome) {
    case "signed_in":
      return safeRedirectPath(redirectTo);
    case "recovery":
      return "/reset-password";
    case "opened_in_other_browser":
      return hint === "recovery" ? "/forgot-password?openedElsewhere=1" : "/login?emailConfirmed=1";
    case "link_invalid":
      return hint === "recovery" ? "/forgot-password?linkExpired=1" : "/login?linkExpired=1";
  }
}
