import { renderToStaticMarkup } from "react-dom/server";
import { AuthSessionMissingError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Setting a new password, through the real `resetPassword` Server Action and
 * the real /reset-password page.
 *
 * THE DEFECT (Task 7.1.3)
 *
 * The recovery link pointed at /reset-password, which never exchanged the
 * code: the person who clicked it had no session, so no reset could succeed.
 * Meanwhile the page rendered its form for anyone and the action updated the
 * password of whatever session the request carried — an ordinary signed-in
 * session could replace the password without knowing it.
 *
 * Only the Supabase client, the rate-limit store and the event sink are
 * replaced. The recovery rule, the claim handling, validation and the action's
 * ordering are the real implementation. The verified-token check itself is the
 * library's `getClaims`; what is pinned here is that nothing else is trusted.
 */

const PASSWORD = "Synthetic-Reset-Pass-7431";
const USER_ID = "3f1c2b8e-0000-4000-8000-000000000001";
const CLAIM_EMAIL = "recovering-user@example.test";

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    claims: null as Record<string, unknown> | null,
    claimsThrows: false,
    updateError: null as { message: string } | null,
    globalSignOutError: null as { message: string } | null,
    limited: false,
    updateUser: [] as unknown[],
    signOut: [] as unknown[],
    rateLimit: [] as { group: string; keys: Record<string, string> }[],
    events: [] as unknown[],
    console: [] as unknown[],
  };
});

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    const e = new Error(`NEXT_REDIRECT:${to}`) as Error & { digest?: string };
    e.digest = `NEXT_REDIRECT;${to}`;
    throw e;
  },
}));

vi.mock("@/server/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getClaims: async () => {
        if (state.claimsThrows) throw new TypeError("fetch failed");
        return state.claims ? { data: { claims: state.claims }, error: null } : { data: null, error: new AuthSessionMissingError() };
      },
      updateUser: async (attributes: unknown) => {
        state.updateUser.push(attributes);
        return { data: { user: null }, error: state.updateError };
      },
      signOut: async (options: { scope?: string }) => {
        state.signOut.push(options);
        return { error: options?.scope === "global" ? state.globalSignOutError : null };
      },
    },
  }),
}));

vi.mock("@/server/security/rate-limit", () => ({
  clientAddress: async () => "203.0.113.7",
  normalizeIdentifier: (value: string) => `id:${value.toLowerCase()}`,
  enforceRateLimit: async (group: string, keys: Record<string, string>) => {
    state.rateLimit.push({ group, keys });
    return state.limited ? { allowed: false, message: "Too many requests. Please wait and try again." } : { allowed: true };
  },
}));

vi.mock("@/lib/observability", () => ({
  reportEvent: (...args: unknown[]) => void state.events.push(args),
  reportError: (...args: unknown[]) => void state.events.push(args),
}));

const { resetPassword } = await import("@/server/auth/actions");
const { default: ResetPasswordPage } = await import("@/app/(auth)/reset-password/page");

const nowSeconds = () => Math.floor(Date.now() / 1000);
const recoveryClaims = (ageSeconds = 30) => ({
  sub: USER_ID,
  email: CLAIM_EMAIL,
  role: "authenticated",
  session_id: "session-1",
  amr: [{ method: "recovery", timestamp: nowSeconds() - ageSeconds }],
});

function formData(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function submit(fields: Record<string, string> = { password: PASSWORD, confirmPassword: PASSWORD }) {
  try {
    return { result: await resetPassword({}, formData(fields)), redirectedTo: null };
  } catch (e) {
    const match = /^NEXT_REDIRECT:(.*)$/.exec((e as Error).message);
    if (match) return { result: null, redirectedTo: match[1] };
    throw e;
  }
}

const RECOVERY_REQUIRED = /reset link has expired/i;

beforeEach(() => {
  state.claims = null;
  state.claimsThrows = false;
  state.updateError = null;
  state.globalSignOutError = null;
  state.limited = false;
  state.updateUser = [];
  state.signOut = [];
  state.rateLimit = [];
  state.events = [];
  state.console = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void state.console.push(args));
  }
});

afterEach(() => {
  // Whatever the scenario, the password never reaches a log or an event.
  const recorded = JSON.stringify([state.console, state.events], (_key, value) => (value instanceof Error ? `${value.name}: ${value.message}` : value));
  expect(recorded).not.toContain(PASSWORD);
  vi.restoreAllMocks();
});

describe("who may set a password", () => {
  it("refuses an anonymous request without asking Supabase to change anything", async () => {
    const { result, redirectedTo } = await submit();
    expect(result?.error).toMatch(RECOVERY_REQUIRED);
    expect(redirectedTo).toBeNull();
    expect(state.updateUser).toEqual([]);
    expect(state.rateLimit).toEqual([]);
  });

  it("refuses an ordinary signed-in session — no password change without recovery", async () => {
    state.claims = { ...recoveryClaims(), amr: [{ method: "password", timestamp: nowSeconds() - 10 }] };
    const { result } = await submit();
    expect(result?.error).toMatch(RECOVERY_REQUIRED);
    expect(state.updateUser).toEqual([]);
  });

  it("refuses a session from a sign-up confirmation link", async () => {
    state.claims = { ...recoveryClaims(), amr: [{ method: "email/signup", timestamp: nowSeconds() - 10 }] };
    expect((await submit()).result?.error).toMatch(RECOVERY_REQUIRED);
    expect(state.updateUser).toEqual([]);
  });

  it("refuses a recovery session older than the window", async () => {
    state.claims = recoveryClaims(16 * 60);
    expect((await submit()).result?.error).toMatch(RECOVERY_REQUIRED);
    expect(state.updateUser).toEqual([]);
  });

  it("refuses when the token cannot be verified", async () => {
    state.claimsThrows = true;
    expect((await submit()).result?.error).toMatch(RECOVERY_REQUIRED);
    expect(state.updateUser).toEqual([]);
  });
});

describe("a valid recovery session", () => {
  it("sets the password, revokes every session and sends the person to sign in", async () => {
    state.claims = recoveryClaims();
    const { redirectedTo } = await submit();

    expect(state.updateUser).toEqual([{ password: PASSWORD }]);
    expect(state.signOut).toEqual([{ scope: "global" }]);
    expect(redirectedTo).toBe("/login?passwordUpdated=1");
  });

  it("cannot be pointed at another account: identity fields in the request are ignored", async () => {
    state.claims = recoveryClaims();
    await submit({
      password: PASSWORD,
      confirmPassword: PASSWORD,
      userId: "00000000-0000-4000-8000-00000000beef",
      user_id: "00000000-0000-4000-8000-00000000beef",
      email: "victim@example.test",
      access_token: "attacker-token",
    });

    // Exactly the new password — no id, email or token reaches Supabase...
    expect(state.updateUser).toEqual([{ password: PASSWORD }]);
    // ...and the budget is charged to the verified account, not the form's email.
    expect(state.rateLimit[0]?.keys.passwordResetPerIdentifier).toBe(`id:${CLAIM_EMAIL}`);
    expect(JSON.stringify(state.rateLimit)).not.toContain("victim");
  });

  it("requires the confirmation to match", async () => {
    state.claims = recoveryClaims();
    const { result } = await submit({ password: PASSWORD, confirmPassword: `${PASSWORD}x` });
    expect(result?.error).toMatch(/don't match/);
    expect(state.updateUser).toEqual([]);
  });

  it("keeps the existing password policy", async () => {
    state.claims = recoveryClaims();
    const { result } = await submit({ password: "short", confirmPassword: "short" });
    expect(result?.error).toMatch(/at least 8 characters/);
    expect(state.updateUser).toEqual([]);
  });

  it("never returns the provider's message", async () => {
    state.claims = recoveryClaims();
    state.updateError = { message: "New password should be different from the old password." };
    const { result, redirectedTo } = await submit();

    expect(result?.error).toBe("That password couldn't be set. Choose a different one and try again.");
    expect(result?.error).not.toMatch(/old password/i);
    expect(redirectedTo).toBeNull();
    expect(state.signOut).toEqual([]);
  });

  it("is rate limited before Supabase is asked", async () => {
    state.claims = recoveryClaims();
    state.limited = true;
    const { result } = await submit();
    expect(result?.error).toMatch(/too many requests/i);
    expect(state.updateUser).toEqual([]);
  });

  it("still ends this session when revoking the others fails", async () => {
    state.claims = recoveryClaims();
    state.globalSignOutError = { message: "network down" };
    const { redirectedTo } = await submit();
    expect(state.signOut).toEqual([{ scope: "global" }, { scope: "local" }]);
    expect(redirectedTo).toBe("/login?passwordUpdated=1");
  });
});

describe("the /reset-password page", () => {
  async function render() {
    return renderToStaticMarkup(await ResetPasswordPage());
  }

  it("shows no form without a recovery session, only a way to ask for a new link", async () => {
    const html = await render();
    expect(html).toContain("This reset link can");
    expect(html).toContain('href="/forgot-password"');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("<form");
  });

  it("shows no form to an ordinary signed-in session", async () => {
    state.claims = { ...recoveryClaims(), amr: [{ method: "password", timestamp: nowSeconds() - 10 }] };
    const html = await render();
    expect(html).not.toContain('type="password"');
  });

  it("shows the new-password form, with confirmation, to a recovery session", async () => {
    state.claims = recoveryClaims();
    const html = await render();
    expect(html).toContain('name="password"');
    expect(html).toContain('name="confirmPassword"');
    // Nothing about the session is written into the page.
    expect(html).not.toContain(USER_ID);
    expect(html).not.toContain(CLAIM_EMAIL);
    expect(html).not.toContain("session-1");
  });
});
