import { AuthApiError, AuthPKCECodeVerifierMissingError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { callbackDestination, callbackOutcome, flowHint, shouldExchange } from "./auth-callback";

/**
 * Regression tests for the "That link has expired" report on a confirmation
 * that had in fact succeeded.
 *
 * Observed live against the real project: Supabase confirmed the account,
 * redirected to /auth/callback with a valid code, and the link was opened in a
 * browser without the PKCE verifier cookie. The exchange failed with
 * AuthPKCECodeVerifierMissingError and the visitor was told the link expired.
 * A second click then arrived as `error_code=otp_expired`.
 */

describe("which outcome a callback visit has", () => {
  it("signs in when the exchange succeeds", () => {
    expect(callbackOutcome({ code: "abc", providerErrorCode: null, exchangeError: null })).toBe("signed_in");
  });

  it("recognises a confirmation opened in a different browser", () => {
    // The exact error auth-js raises when the verifier cookie is absent.
    expect(callbackOutcome({ code: "abc", providerErrorCode: null, exchangeError: new AuthPKCECodeVerifierMissingError() })).toBe("opened_in_other_browser");
  });

  it("does not mistake any other exchange failure for a different-browser open", () => {
    const failure = new AuthApiError("invalid flow state, no valid flow state found", 404, "flow_state_not_found");
    expect(callbackOutcome({ code: "abc", providerErrorCode: null, exchangeError: failure })).toBe("link_invalid");
  });

  it("treats a generic error as an invalid link", () => {
    expect(callbackOutcome({ code: "abc", providerErrorCode: null, exchangeError: new Error("boom") })).toBe("link_invalid");
  });

  it("reports a link Supabase refused as invalid", () => {
    expect(callbackOutcome({ code: null, providerErrorCode: "otp_expired", exchangeError: null })).toBe("link_invalid");
  });

  it("lets a provider error win even if a code is also present", () => {
    // A crafted URL carrying both must not be treated as a successful sign-in.
    expect(callbackOutcome({ code: "abc", providerErrorCode: "otp_expired", exchangeError: null })).toBe("link_invalid");
  });

  it("reports a visit with no code as invalid", () => {
    expect(callbackOutcome({ code: null, providerErrorCode: null, exchangeError: null })).toBe("link_invalid");
    expect(callbackOutcome({ code: "", providerErrorCode: null, exchangeError: null })).toBe("link_invalid");
  });
});

describe("whether to attempt an exchange", () => {
  it("exchanges a code Supabase did not flag", () => {
    expect(shouldExchange("abc", null)).toBe(true);
  });

  it("never exchanges when Supabase already refused the link", () => {
    // No request whose answer is already known — and no retry of a spent link.
    expect(shouldExchange("abc", "otp_expired")).toBe(false);
  });

  it("never exchanges without a code", () => {
    expect(shouldExchange(null, null)).toBe(false);
  });
});

describe("where the visitor lands", () => {
  it("honours a safe same-origin redirect after signing in", () => {
    expect(callbackDestination("signed_in", "/app/abc/dashboard")).toBe("/app/abc/dashboard");
  });

  it("defaults to the app after signing in", () => {
    expect(callbackDestination("signed_in", null)).toBe("/app");
  });

  it("still refuses an off-origin redirect", () => {
    expect(callbackDestination("signed_in", "//evil.com")).toBe("/app");
    expect(callbackDestination("signed_in", "@evil.com/")).toBe("/app");
  });

  it("sends a different-browser confirmation to sign in, not to an expiry message", () => {
    expect(callbackDestination("opened_in_other_browser", "/app")).toBe("/login?emailConfirmed=1");
  });

  it("never carries redirectTo into the non-signed-in pages", () => {
    expect(callbackDestination("opened_in_other_browser", "//evil.com")).not.toContain("evil");
    expect(callbackDestination("link_invalid", "//evil.com")).not.toContain("evil");
  });

  it("keeps the expiry message for links that really are spent or invalid", () => {
    expect(callbackDestination("link_invalid", null)).toBe("/login?linkExpired=1");
  });
});

describe("password recovery through the callback", () => {
  it("recognises a recovery exchange from the exchange result", () => {
    expect(callbackOutcome({ code: "abc", providerErrorCode: null, exchangeError: null, redirectType: "recovery" })).toBe("recovery");
  });

  it("treats any other successful exchange as an ordinary sign-in", () => {
    expect(callbackOutcome({ code: "abc", providerErrorCode: null, exchangeError: null, redirectType: null })).toBe("signed_in");
    expect(callbackOutcome({ code: "abc", providerErrorCode: null, exchangeError: null, redirectType: "signup" })).toBe("signed_in");
  });

  it("never reports recovery for a failed exchange, whatever redirectType says", () => {
    expect(callbackOutcome({ code: "abc", providerErrorCode: null, exchangeError: new Error("boom"), redirectType: "recovery" })).toBe("link_invalid");
    expect(callbackOutcome({ code: "abc", providerErrorCode: "otp_expired", exchangeError: null, redirectType: "recovery" })).toBe("link_invalid");
  });

  it("sends a recovery to the reset page and ignores redirectTo", () => {
    expect(callbackDestination("recovery", null)).toBe("/reset-password");
    expect(callbackDestination("recovery", "/app/abc/settings", "recovery")).toBe("/reset-password");
    expect(callbackDestination("recovery", "//evil.com", null)).toBe("/reset-password");
  });

  it("sends a failed reset link to request a new one, not to sign in", () => {
    expect(callbackDestination("link_invalid", null, "recovery")).toBe("/forgot-password?linkExpired=1");
    expect(callbackDestination("opened_in_other_browser", null, "recovery")).toBe("/forgot-password?openedElsewhere=1");
  });

  it("accepts only the exact hint, and a hint never changes a successful sign-in", () => {
    expect(flowHint("recovery")).toBe("recovery");
    expect(flowHint("RECOVERY")).toBeNull();
    expect(flowHint("recovery/../evil")).toBeNull();
    expect(flowHint(null)).toBeNull();
    expect(callbackDestination("signed_in", null, "recovery")).toBe("/app");
  });
});
