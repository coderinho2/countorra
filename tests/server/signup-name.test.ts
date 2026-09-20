import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the sign-up form sends, and what the account ends up storing.
 *
 * The redesigned /signup collects a given and a family name rather than one
 * "Full name" box, but the account still stores a single display name
 * (`raw_user_meta_data.full_name`, which src/lib/identity.ts reads). The
 * composition happens in the Server Action, not in the browser, so it holds
 * for anything that posts to the action — including a submission with
 * JavaScript disabled, where no client-side code runs at all.
 *
 * Only the Supabase client and the rate-limit store are replaced. Validation,
 * the composition, the ordering and the error handling are the real
 * implementation.
 */

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    signUpCalls: [] as { email: string; password: string; options?: { data?: { full_name?: string } } }[],
    signUpError: null as { message: string } | null,
    limited: false,
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
      signUp: async (credentials: (typeof state.signUpCalls)[number]) => {
        state.signUpCalls.push(credentials);
        return { error: state.signUpError };
      },
    },
  }),
}));

vi.mock("@/server/security/rate-limit", () => ({
  clientAddress: async () => "203.0.113.7",
  normalizeIdentifier: (value: string) => `id:${value.toLowerCase()}`,
  enforceRateLimit: async () =>
    state.limited ? { allowed: false, message: "Too many requests. Please wait and try again." } : { allowed: true },
}));

const { signUp } = await import("@/server/auth/actions");

const PASSWORD = "Synthetic-Signup-Pass-8812";

function formData(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

/** A successful signup redirects, which throws — so both outcomes are returned. */
async function submit(fields: Record<string, string>) {
  try {
    return { result: await signUp({}, formData(fields)), redirectedTo: null };
  } catch (e) {
    const match = /^NEXT_REDIRECT:(.*)$/.exec((e as Error).message);
    if (match) return { result: null, redirectedTo: match[1] };
    throw e;
  }
}

const storedName = () => state.signUpCalls.at(-1)?.options?.data?.full_name;

beforeEach(() => {
  state.signUpCalls = [];
  state.signUpError = null;
  state.limited = false;
  state.console = [];
  vi.spyOn(console, "error").mockImplementation((...args) => void state.console.push(args));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the two name fields become the one name the account stores", () => {
  it("joins first and last name and completes the signup", async () => {
    const { redirectedTo } = await submit({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.test",
      password: PASSWORD,
    });

    expect(redirectedTo).toBe("/verify-email");
    expect(storedName()).toBe("Ada Lovelace");
  });

  it("trims the surrounding whitespace a paste usually brings with it", async () => {
    await submit({
      firstName: "  Grace ",
      lastName: " Hopper  ",
      email: "grace@example.test",
      password: PASSWORD,
    });

    expect(storedName()).toBe("Grace Hopper");
  });

  it("still accepts a posted fullName, so the action's existing contract holds", async () => {
    // Nothing that already submits to this action has to be rewritten — and
    // the stored shape is identical either way.
    const { redirectedTo } = await submit({
      fullName: "Katherine Johnson",
      email: "katherine@example.test",
      password: PASSWORD,
    });

    expect(redirectedTo).toBe("/verify-email");
    expect(storedName()).toBe("Katherine Johnson");
  });
});

describe("a missing half of the name is refused, not silently dropped", () => {
  it("refuses a blank first name", async () => {
    const { result } = await submit({
      firstName: "   ",
      lastName: "Lovelace",
      email: "ada@example.test",
      password: PASSWORD,
    });

    expect(result?.error).toBe("First name is required.");
    // Refused before the provider was ever asked to create anything.
    expect(state.signUpCalls).toEqual([]);
  });

  it("refuses a blank last name", async () => {
    const { result } = await submit({
      firstName: "Ada",
      lastName: "",
      email: "ada@example.test",
      password: PASSWORD,
    });

    expect(result?.error).toBe("Last name is required.");
    expect(state.signUpCalls).toEqual([]);
  });

  it("names the field that is wrong, rather than reporting a missing full name", async () => {
    // The person filled in a form with two name boxes; telling them "Full
    // name is required" would point at a field that is not on their screen.
    const { result } = await submit({ firstName: "", lastName: "", email: "a@example.test", password: PASSWORD });
    expect(result?.error).not.toMatch(/full name/i);
  });
});

describe("the name never widens what the signup endpoint discloses", () => {
  it("keeps the provider's own message out of the response", async () => {
    // "User already registered" would turn this form into an
    // account-existence oracle; the generic message is the whole point.
    state.signUpError = { message: "User already registered" };

    const { result } = await submit({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.test",
      password: PASSWORD,
    });

    expect(result?.error).toBe("We couldn't create an account with those details. Please check them and try again.");
    expect(result?.error).not.toMatch(/already registered/i);
  });

  it("consumes the rate-limit budget for a submission that uses the split name fields", async () => {
    state.limited = true;

    const { result } = await submit({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.test",
      password: PASSWORD,
    });

    expect(result?.error).toMatch(/too many requests/i);
    expect(state.signUpCalls).toEqual([]);
  });
});
