import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Account deletion and ownership transfer at the Server Action boundary.
 *
 * The properties that matter are the ones that protect OTHER people: a sole
 * owner cannot delete a shared workspace out from under its members, storage
 * is cleared before the rows that point at it, and nothing is removed at all
 * unless the whole plan is safe.
 */

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    reauthOk: true,
    memberships: [] as { organization_id: string; user_id: string; role: string }[],
    orgNames: {} as Record<string, string>,
    role: "owner",
    /** Ordered log of every destructive operation actually performed. */
    operations: [] as string[],
    filesRemoved: [] as string[],
    deletedUser: null as string | null,
    signedOut: false,
    /** Failure injection, so the unhappy paths are exercised rather than
     *  assumed. Each is the error a real Supabase call would return. */
    deleteUserError: null as { message: string } | null,
    conversationDeleteError: null as { message: string } | null,
    /** Bank credential release (Task 11). */
    bankRelease: { ok: true, released: 0 } as { ok: true; released: number } | { ok: false; reason: string },
  };
});

vi.mock("@/server/bank-connections/runtime", () => ({ bankCredentialDependencies: () => ({}) }));
vi.mock("@/server/bank-connections/service", () => ({
  releaseOrganizationBankCredentials: async (_deps: unknown, organizationId: string) => {
    state.operations.push(`bank-credentials:${organizationId}`);
    return state.bankRelease;
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    const e = new Error(`NEXT_REDIRECT:${to}`) as Error & { digest?: string };
    e.digest = `NEXT_REDIRECT;${to}`;
    throw e;
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/server/auth/session", () => ({
  requireUser: async () => ({ id: state.userId, email: "owner@example.test" }),
  getSession: async () => ({ id: state.userId }),
  requireOrgMembership: async (organizationId: string) => ({
    user: { id: state.userId, email: "owner@example.test" },
    membership: { organizationId, userId: state.userId, role: state.role },
  }),
}));

vi.mock("@/server/auth/reauthentication", () => ({
  reauthenticate: async () => (state.reauthOk ? { ok: true } : { ok: false, error: "That password isn't correct. Please try again." }),
}));

/**
 * Minimal PostgREST-shaped stub: enough for the exact calls this flow makes.
 *
 * The operation is recorded when the chain is AWAITED, not when `.delete()` is
 * called — PostgREST builders are `from().delete().eq(...)`, so the filters
 * that say *which* rows are being removed do not exist yet at `.delete()`
 * time. Recording early logged `delete:memberships` with no scope, which would
 * have let a test pass while the code deleted the wrong rows.
 */
function table(name: string) {
  const filters: Record<string, unknown> = {};
  let pending: "delete" | "update" | null = null;

  const record = () => {
    if (!pending) return;
    const scope = filters.id ?? filters.organization_id;
    state.operations.push(`${pending}:${name}${scope ? `:${String(scope)}` : ""}`);
    pending = null;
  };

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, value: unknown) => {
      filters[col] = value;
      return builder;
    },
    in: () => builder,
    update: () => {
      pending = "update";
      return builder;
    },
    delete: () => {
      pending = "delete";
      return builder;
    },
    maybeSingle: async () => {
      record();
      if (name === "organizations") return { data: { name: state.orgNames[String(filters.id)] ?? "Untitled" }, error: null };
      const row = state.memberships.find((m) => m.organization_id === filters.organization_id && m.user_id === filters.user_id);
      return { data: row ?? null, error: null };
    },
    then: (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
      record();
      if (name === "ai_conversations" && state.conversationDeleteError) {
        return resolve({ data: null, error: state.conversationDeleteError });
      }
      return resolve({ data: name === "memberships" && !filters.user_id ? state.memberships : [], error: null });
    },
  };
  return builder;
}

const supabase = {
  from: (name: string) => table(name),
  auth: {
    signOut: async () => {
      state.signedOut = true;
      return { error: null };
    },
    admin: {
      deleteUser: async (id: string) => {
        if (state.deleteUserError) return { error: state.deleteUserError };
        state.deletedUser = id;
        state.operations.push("delete:auth.user");
        return { error: null };
      },
    },
  },
  storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ error: null }) }) },
};

vi.mock("@/server/supabase/server", () => ({ createClient: async () => supabase }));
vi.mock("@/server/supabase/admin", () => ({ createAdminClient: () => supabase }));

vi.mock("@/server/storage/documents", () => ({
  deleteAllOrganizationFiles: async (_c: unknown, organizationId: string) => {
    state.operations.push(`storage:${organizationId}`);
    state.filesRemoved.push(organizationId);
    return { removed: 1 };
  },
  uploadDocumentFile: async () => ({ storagePath: "p" }),
  deleteDocumentFile: async () => {},
  getDocumentDownloadUrl: async () => "https://example.test/x",
}));

vi.mock("@/domain/audit/audit-log", () => ({ recordAuditEvent: async () => {}, AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }) }));

const { deleteAccountAction, transferOrganizationOwnershipAction } = await import("@/server/account/actions");

const SOLO = "22222222-2222-4222-8222-222222222222";
const SHARED = "33333333-3333-4333-8333-333333333333";
const OTHER_USER = "44444444-4444-4444-8444-444444444444";

function deletionForm(overrides: Record<string, string> = {}) {
  const form = new FormData();
  form.set("password", "correct horse battery staple");
  form.set("confirmation", "DELETE");
  for (const [k, v] of Object.entries(overrides)) form.set(k, v);
  return form;
}

async function runDeletion(form = deletionForm()) {
  try {
    return (await deleteAccountAction({}, form)) as { error?: string };
  } catch (error) {
    const digest = (error as Error & { digest?: string }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return { error: undefined };
    throw error;
  }
}

beforeEach(() => {
  state.reauthOk = true;
  state.role = "owner";
  state.memberships = [{ organization_id: SOLO, user_id: state.userId, role: "owner" }];
  state.orgNames = { [SOLO]: "My finances", [SHARED]: "Acme" };
  state.operations = [];
  state.filesRemoved = [];
  state.deletedUser = null;
  state.signedOut = false;
  state.deleteUserError = null;
  state.conversationDeleteError = null;
  state.bankRelease = { ok: true, released: 0 };
});

describe("bank-provider credentials (Task 11)", () => {
  it("destroys a workspace's bank credentials before its files and its row", async () => {
    await runDeletion();
    const credentials = state.operations.indexOf(`bank-credentials:${SOLO}`);
    expect(credentials).toBeGreaterThanOrEqual(0);
    expect(credentials).toBeLessThan(state.operations.indexOf(`storage:${SOLO}`));
    expect(state.deletedUser).toBe(state.userId);
  });

  it("deletes nothing at all when a credential cannot be destroyed", async () => {
    state.bankRelease = { ok: false, reason: "SECRET_STORE_UNAVAILABLE" };
    const result = await runDeletion();
    expect(result.error).toMatch(/couldn't finish deleting/i);
    expect(state.filesRemoved).toEqual([]);
    expect(state.operations.filter((operation) => operation.startsWith("delete:"))).toEqual([]);
    expect(state.deletedUser).toBeNull();
  });
});

describe("re-authentication is required", () => {
  it("refuses without a correct password, deleting nothing", async () => {
    state.reauthOk = false;
    const result = await runDeletion();

    expect(result.error).toMatch(/password/i);
    expect(state.operations).toEqual([]);
    expect(state.deletedUser).toBeNull();
  });

  it("refuses without the typed confirmation, before even checking the password", async () => {
    const result = await runDeletion(deletionForm({ confirmation: "delete" }));

    expect(result.error).toMatch(/type DELETE/i);
    expect(state.operations).toEqual([]);
  });

  it("proceeds once re-authenticated", async () => {
    expect((await runDeletion()).error).toBeUndefined();
    expect(state.deletedUser).toBe(state.userId);
  });
});

describe("personal workspace deletion", () => {
  it("removes storage BEFORE the organization row", async () => {
    await runDeletion();

    const storageAt = state.operations.indexOf(`storage:${SOLO}`);
    const orgAt = state.operations.indexOf(`delete:organizations:${SOLO}`);

    expect(storageAt).toBeGreaterThanOrEqual(0);
    expect(orgAt).toBeGreaterThan(storageAt);
  });

  it("removes the conversations that cannot be detached", async () => {
    await runDeletion();
    expect(state.operations).toContain("delete:ai_conversations");
  });

  it("deletes the auth user last", async () => {
    await runDeletion();
    expect(state.operations[state.operations.length - 1]).toBe("delete:auth.user");
  });

  it("signs the session out afterwards", async () => {
    await runDeletion();
    expect(state.signedOut).toBe(true);
  });
});

describe("shared workspace protection", () => {
  beforeEach(() => {
    state.memberships = [
      { organization_id: SHARED, user_id: state.userId, role: "owner" },
      { organization_id: SHARED, user_id: OTHER_USER, role: "employee" },
    ];
  });

  it("REFUSES when the account holder is the only owner and others are members", async () => {
    const result = await runDeletion();

    expect(result.error).toContain("Acme");
    expect(result.error).toMatch(/transfer ownership/i);
  });

  it("deletes nothing at all when blocked", async () => {
    await runDeletion();

    expect(state.operations).toEqual([]);
    expect(state.deletedUser).toBeNull();
    expect(state.filesRemoved).toEqual([]);
  });

  it("refuses the whole plan when only one of several workspaces is blocked", async () => {
    // All-or-nothing: the safe personal workspace must not be deleted either.
    state.memberships.push({ organization_id: SOLO, user_id: state.userId, role: "owner" });
    await runDeletion();

    expect(state.operations).toEqual([]);
  });

  it("leaves — never deletes — a workspace that has another owner", async () => {
    state.memberships = [
      { organization_id: SHARED, user_id: state.userId, role: "owner" },
      { organization_id: SHARED, user_id: OTHER_USER, role: "owner" },
    ];
    await runDeletion();

    expect(state.operations).toContain(`delete:memberships:${SHARED}`);
    expect(state.operations).not.toContain(`delete:organizations:${SHARED}`);
    expect(state.filesRemoved).toEqual([]);
  });

  it("leaves a workspace the account holder does not own", async () => {
    state.memberships = [
      { organization_id: SHARED, user_id: state.userId, role: "employee" },
      { organization_id: SHARED, user_id: OTHER_USER, role: "owner" },
    ];
    await runDeletion();

    expect(state.operations).toContain(`delete:memberships:${SHARED}`);
    expect(state.operations).not.toContain(`delete:organizations:${SHARED}`);
  });
});

describe("ownership transfer", () => {
  beforeEach(() => {
    state.memberships = [
      { organization_id: SHARED, user_id: state.userId, role: "owner" },
      { organization_id: SHARED, user_id: OTHER_USER, role: "employee" },
    ];
  });

  it("promotes the target and steps the caller down", async () => {
    const result = await transferOrganizationOwnershipAction(SHARED, OTHER_USER);

    expect(result.success).toBe(true);
    expect(state.operations.filter((o) => o.startsWith("update:memberships"))).toHaveLength(2);
  });

  it("refuses a non-owner caller", async () => {
    state.role = "admin";
    const result = await transferOrganizationOwnershipAction(SHARED, OTHER_USER);

    expect(result.error).toMatch(/only an owner/i);
    expect(state.operations).toEqual([]);
  });

  it("refuses transferring to yourself", async () => {
    const result = await transferOrganizationOwnershipAction(SHARED, state.userId);

    expect(result.error).toMatch(/different member/i);
    expect(state.operations).toEqual([]);
  });

  it("refuses a target who is not a member of the workspace", async () => {
    const result = await transferOrganizationOwnershipAction(SHARED, "55555555-5555-4555-8555-555555555555");

    expect(result.error).toMatch(/isn't a member/i);
    expect(state.operations).toEqual([]);
  });

  it("unblocks deletion once another owner exists", async () => {
    expect((await runDeletion()).error).toContain("Acme");

    state.memberships = state.memberships.map((m) => (m.user_id === OTHER_USER ? { ...m, role: "owner" } : m));
    state.operations = [];

    expect((await runDeletion()).error).toBeUndefined();
    expect(state.operations).toContain(`delete:memberships:${SHARED}`);
    expect(state.operations).not.toContain(`delete:organizations:${SHARED}`);
  });
});

/**
 * Failure paths.
 *
 * The P1 this suite now guards was not "an operation failed" — failures are
 * expected. It was that a failure arrived AFTER most of the account had
 * already been removed, and the flow then returned a message that read like
 * nothing had happened. These assert the two properties that matter when a
 * step does fail: the user is told, and the flow does not proceed as if it
 * had succeeded.
 */
describe("a failed step never reports success", () => {
  it("returns an error and does not sign out when the user delete fails", async () => {
    state.deleteUserError = { message: "insert or update on table violates foreign key constraint" };

    const result = await runDeletion();

    expect(result.error).toBeTruthy();
    expect(state.deletedUser).toBeNull();
    // No sign-out and no redirect: `runDeletion` returns `{ error: undefined }`
    // only when a NEXT_REDIRECT was thrown, which is the success path.
    expect(state.signedOut).toBe(false);
  });

  it("never leaks the database's own message to the user", async () => {
    // A constraint name tells an attacker the schema; it tells a user
    // nothing they can act on.
    state.deleteUserError = { message: 'violates foreign key constraint "ai_actions_confirmed_by_fkey"' };

    const result = await runDeletion();

    expect(result.error).not.toMatch(/constraint|foreign key|ai_actions|fkey/i);
    expect(result.error).toMatch(/couldn't finish deleting your account/i);
  });

  it("stops at the failed step rather than continuing to the account itself", async () => {
    state.conversationDeleteError = { message: "connection reset" };

    const result = await runDeletion();

    expect(result.error).toBeTruthy();
    expect(state.deletedUser).toBeNull();
    expect(state.operations).not.toContain("delete:auth.user");
  });

  it("succeeds normally when nothing fails, for contrast", async () => {
    const result = await runDeletion();

    expect(result.error).toBeUndefined();
    expect(state.deletedUser).toBe(state.userId);
    expect(state.signedOut).toBe(true);
  });
});

/**
 * Attribution is the database's job now, not this action's.
 *
 * There used to be an `ai_actions` UPDATE here that nulled `confirmed_by` on
 * the subset of rows the old CHECK allowed. It could not touch a confirmed or
 * executed WRITE, which is precisely what left the account half deleted; and
 * it was the one statement in the flow whose result was never checked.
 * Migration 0033 replaced it with ON DELETE SET NULL, so the detach happens in
 * the same statement as the deletion.
 */
describe("the flow does not rewrite attribution itself", () => {
  it("issues no ai_actions write at all", async () => {
    await runDeletion();

    expect(state.operations.filter((op) => op.includes("ai_actions"))).toEqual([]);
  });

  it("deletes the auth user last, so the cascade runs after everything else", async () => {
    await runDeletion();

    expect(state.operations.at(-1)).toBe("delete:auth.user");
  });
});
