import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Auth configuration, asserted as tests rather than left as a checklist.
 *
 * Every case here corresponds to a concrete finding from the audit. Config
 * drift is invisible until someone tries to confirm an account or click a
 * reset link, which is far too late to notice — so the settings that would
 * silently break production are pinned.
 */

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

/** Reads a key from a named TOML section, ignoring commented lines. */
function tomlValue(source: string, section: string, key: string): string | null {
  const sectionAt = source.indexOf(`[${section}]`);
  if (sectionAt === -1) return null;
  const nextSection = source.indexOf("\n[", sectionAt + 1);
  const block = source.slice(sectionAt, nextSection === -1 ? undefined : nextSection);

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const match = trimmed.match(new RegExp(`^${key}\\s*=\\s*(.+)$`));
    if (match) return match[1].trim();
  }
  return null;
}

describe("supabase/config.toml matches production intent", () => {
  const config = read("supabase/config.toml");

  it("requires email confirmation", () => {
    // The linked project reports `mailer_autoconfirm: false` (confirmation
    // ON) while this file said `false` (confirmation OFF). Since
    // `supabase config push` overwrites the project with this file, the drift
    // was one command away from turning signup into an unverified-email
    // endpoint in production.
    expect(tomlValue(config, "auth.email", "enable_confirmations")).toBe("true");
  });

  it("requires re-authentication before a password change", () => {
    // Without it, a borrowed session becomes permanent account takeover.
    expect(tomlValue(config, "auth.email", "secure_password_change")).toBe("true");
  });

  it("keeps anonymous sign-in disabled", () => {
    expect(tomlValue(config, "auth", "enable_anonymous_sign_ins")).toBe("false");
  });

  it("keeps SMS signup disabled, since no SMS flow exists", () => {
    expect(tomlValue(config, "auth.sms", "enable_signup")).toBe("false");
  });

  it("warns that config push overwrites the linked project", () => {
    // The command is destructive in the direction nobody expects: local wins.
    expect(config).toMatch(/config push.{0,80}OVERWRITES/is);
  });
});

describe("outbound redirect targets are server-controlled", () => {
  const actions = read("src/server/auth/actions.ts");

  it("builds every email redirect from NEXT_PUBLIC_APP_URL", () => {
    // Never from a request parameter, a header, or form input — that is what
    // makes them un-poisonable regardless of what a visitor sends.
    const redirects = actions.match(/(?:emailRedirectTo|redirectTo):\s*`[^`]+`/g) ?? [];

    // Confirmation and password-reset. A third (OAuth) was removed with the
    // Google button; see the "no OAuth entry point" block below.
    expect(redirects.length).toBeGreaterThanOrEqual(2);
    for (const redirect of redirects) {
      expect(redirect, redirect).toContain("publicEnv.NEXT_PUBLIC_APP_URL");
    }
  });

  it("never interpolates a request value into a redirect", () => {
    expect(actions).not.toMatch(/redirectTo:\s*`\$\{(?!publicEnv)/);
    expect(actions).not.toMatch(/redirectTo:\s*formData/);
  });
});

describe("the app URL cannot ship pointing at localhost", () => {
  const env = read("src/lib/env.ts");

  it("asserts a deployable app URL", () => {
    expect(env).toContain("assertDeployableAppUrl");
    expect(env).toMatch(/localhost/);
  });

  it("keys the check on the deployment signal, not NODE_ENV", () => {
    // NODE_ENV is "production" for a local `next build && next start`, which
    // is exactly how the E2E suite runs against localhost on purpose.
    expect(env).toContain("VERCEL_ENV");
    expect(env).not.toMatch(/NODE_ENV\s*===\s*["']production["']/);
  });
});

describe("credential endpoints do not disclose provider detail", () => {
  const actions = read("src/server/auth/actions.ts");

  it("returns a generic message from signIn", () => {
    expect(actions).toContain('return { error: "Incorrect email or password." }');
  });

  it("never returns a raw provider message from signUp or resetPassword", () => {
    // `signUp` leaked "User already registered" (account enumeration);
    // `resetPassword` leaked policy messages that describe the old password.
    const rawReturns = actions.match(/return \{ error: error\.message \}/g) ?? [];
    expect(rawReturns).toEqual([]);
  });

  it("keeps the password-reset request response uniform whether or not the account exists", () => {
    expect(actions).toMatch(/Deliberately return the same success response/);
  });

  it("rate limits every credential endpoint, including setting a new password", () => {
    // signIn / signUp / requestPasswordReset share the `limitAuthAttempt`
    // helper, which consumes an IP bucket and an identifier bucket so neither
    // rotation alone gets past both.
    for (const group of ['"login"', '"signup"', '"passwordReset"']) {
      expect(actions, group).toContain(`limitAuthAttempt(${group}`);
    }

    // resetPassword sets the credential and had no budget at all — a leaked
    // recovery link was an unlimited attempt surface.
    const resetBody = actions.slice(actions.indexOf("export async function resetPassword"));
    expect(resetBody).toContain("enforceRateLimit");
    expect(resetBody).toContain("passwordResetPerIp");
  });

  it("consumes the limit before the credential is ever checked", () => {
    // Otherwise throttling itself becomes the account-existence oracle the
    // uniform responses exist to prevent.
    const signInBody = actions.slice(actions.indexOf("export async function signIn("), actions.indexOf("export async function signOut"));
    expect(signInBody.indexOf("limitAuthAttempt")).toBeLessThan(signInBody.indexOf("signInWithPassword"));
  });
});

describe("no OAuth entry point is advertised, because none is configured", () => {
  const actions = read("src/server/auth/actions.ts");
  const login = read("src/app/(auth)/login/page.tsx");
  const signup = read("src/app/(auth)/signup/page.tsx");
  const privacy = read("src/app/privacy/page.tsx");

  it("has no OAuth server action at all", () => {
    // The linked project reports `external: { email: true }` and nothing
    // else, so every click on the old button produced a provider error. An
    // advertised auth path that cannot work is worse than an absent one:
    // a user who believes they signed up with Google has no password to
    // fall back on.
    expect(actions).not.toContain("signInWithOAuth");
    expect(actions).not.toContain("signInWithGoogle");
  });

  it("exposes no Google button on either auth page", () => {
    for (const [name, source] of [["login", login], ["signup", signup]] as const) {
      expect(source, name).not.toMatch(/Google/i);
      expect(source, name).not.toContain("GoogleAuthButton");
    }
  });

  it("no longer ships the button, glyph, or the divider that separated it", () => {
    for (const file of ["google-auth-button.tsx", "google-glyph.tsx", "auth-divider.tsx"]) {
      expect(existsSync(path.join(ROOT, "src/components/auth", file)), file).toBe(false);
    }
  });

  it("does not claim in the privacy policy that data is shared with Google", () => {
    // A policy describing data sharing that does not happen is a false
    // statement about data handling, not a harmless leftover.
    expect(privacy).not.toMatch(/Continue with Google/i);
    expect(privacy).not.toMatch(/Google sign-in/i);
  });
});

describe("the auth callback fails closed and explains itself", () => {
  // The route performs the exchange; which page follows is decided in
  // src/lib/auth-callback.ts. The properties below span both, so both are read.
  // Behaviour is covered separately in tests/server/auth-callback-route.test.ts.
  const callback = read("src/app/auth/callback/route.ts");
  const decision = read("src/lib/auth-callback.ts");

  it("only redirects onward after a successful code exchange", () => {
    // Signed in (or recovering) only when the exchange returned no error...
    expect(decision).toMatch(/if \(!exchangeError\) return redirectType === "recovery" \? "recovery" : "signed_in"/);
    // ...only the signed-in outcome may use the caller's redirectTo, and a
    // recovery always lands on the reset page, whatever the link asks for.
    expect(decision).toMatch(/case "signed_in":\s*return safeRedirectPath\(redirectTo\)/);
    expect(decision).toMatch(/case "recovery":\s*return "\/reset-password"/);
    expect(decision.match(/safeRedirectPath\(/g)?.length).toBe(1);
    // The route redirects exactly once, to the decided destination.
    expect(callback.match(/NextResponse\.redirect/g)?.length).toBe(1);
    expect(callback).toMatch(/NextResponse\.redirect\(new URL\(callbackDestination\(/);
  });

  it("sends an invalid or expired link back to sign-in with a generic reason", () => {
    expect(decision).toContain("linkExpired=1");
  });

  it("never surfaces the exchange error itself", () => {
    expect(callback).not.toMatch(/error\.message/);
    expect(decision).not.toMatch(/error\.message|\.message/);
  });

  it("passes ?redirectTo through the strict allowlist", () => {
    expect(decision).toContain("safeRedirectPath");
    expect(callback).toMatch(/callbackDestination\(outcome, searchParams\.get\("redirectTo"\), flowHint\(/);
  });

  it("never exchanges a link Supabase has already refused", () => {
    expect(callback).toMatch(/if \(shouldExchange\(code, providerErrorCode\)\)/);
    expect(decision).toMatch(/Boolean\(code\) && !providerErrorCode/);
  });

  it("recognises recovery from the exchange result, never from the link", () => {
    // `redirectType` comes back from auth-js, read from the verifier cookie our
    // own server set; `flow=` is in the URL and only picks a help page.
    expect(callback).toMatch(/redirectType = \(data as [^)]+\)\?\.redirectType \?\? null/);
    const outcomeBody = decision.slice(decision.indexOf("export function callbackOutcome"), decision.indexOf("export function callbackDestination"));
    expect(outcomeBody).not.toMatch(/hint|flow/i);
  });
});

describe("setting a password requires a recovery session, and nothing else counts", () => {
  const actions = read("src/server/auth/actions.ts");
  const recovery = read("src/server/auth/recovery.ts");
  const page = read("src/app/(auth)/reset-password/page.tsx");
  const form = read("src/app/(auth)/reset-password/reset-password-form.tsx");
  const forgot = read("src/app/(auth)/forgot-password/page.tsx");
  const resetBody = actions.slice(actions.indexOf("export async function resetPassword"));

  it("sends the recovery link through the server-side code exchange", () => {
    // The old target, /reset-password, received the code and never exchanged it.
    expect(actions).toMatch(/redirectTo: `\$\{publicEnv\.NEXT_PUBLIC_APP_URL\}\/auth\/callback\?flow=recovery`/);
  });

  it("checks the recovery session before anything is changed or counted", () => {
    const gate = resetBody.indexOf("getRecoverySession()");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(resetBody.indexOf("enforceRateLimit"));
    expect(gate).toBeLessThan(resetBody.indexOf("updateUser"));
  });

  it("reads nothing from the request but the new password", () => {
    const fields = [...resetBody.matchAll(/formData\.get\("([^"]+)"\)/g)].map((match) => match[1]).sort();
    expect(fields).toEqual(["confirmPassword", "password"]);
    expect(resetBody).toMatch(/updateUser\(\{ password: parsed\.data\.password \}\)/);
  });

  it("revokes every session once the password is changed", () => {
    expect(resetBody).toMatch(/signOut\(\{ scope: "global" \}\)/);
    expect(resetBody).toMatch(/redirect\("\/login\?passwordUpdated=1"\)/);
  });

  it("trusts identity only from a verified token", () => {
    expect(recovery).toContain("auth.getClaims()");
    expect(recovery).not.toMatch(/auth\.getSession\(/);
  });

  it("decides on the server whether to show the form", () => {
    expect(page).not.toMatch(/^"use client"/);
    expect(page).toContain("getRecoverySession()");
  });

  it("keeps tokens out of browser storage and the browser Supabase client out of the flow", () => {
    for (const [name, source] of [
      ["reset page", page],
      ["reset form", form],
      ["forgot page", forgot],
      ["recovery", recovery],
      ["actions", actions],
    ] as const) {
      expect(source, name).not.toMatch(/localStorage|sessionStorage/);
      expect(source, name).not.toContain("@/server/supabase/client");
    }
  });
});
