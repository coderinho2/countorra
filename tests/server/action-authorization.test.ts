import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "@/types/database";

/**
 * The role gate on every mutating Server Action, exercised through the same
 * boundary an attacker uses: a direct call, no UI, no form.
 *
 * RLS is the real enforcement (tests/rls/tenant-isolation.test.ts proves the
 * database refuses these writes regardless), and `src/domain/organizations/
 * permissions.ts` has its own unit tests. What was untested is the seam: that
 * each action actually *calls* `can()` with the right permission, before
 * doing any work, and refuses rather than proceeding.
 *
 * A missing `can()` here would not be caught by either of the other two
 * suites — RLS would silently discard the write and the user would be told it
 * succeeded, which is exactly the failure mode 0021 and the confirmAiAction
 * ordering bug both had.
 */

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    role: "owner" as OrgRole,
    rateLimited: false,
    rateLimitGroups: [] as string[],
    userId: "22222222-2222-4222-8222-222222222222",
    writes: [] as string[],
    targetRole: "employee" as OrgRole,
  };
});

// Invoicing is deferred at launch (src/domain/organizations/launch-scope.ts).
// These tests exercise the preserved module as it will behave once it is
// re-enabled; tests/server/launch-scope.test.ts proves it refuses meanwhile.
vi.mock("@/domain/organizations/launch-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/organizations/launch-scope")>()),
  isModuleEnabled: () => true,
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
vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/server/supabase/admin", () => ({ createAdminClient: () => ({}) }));

vi.mock("@/server/auth/session", () => ({
  requireUser: async () => ({ id: state.userId }),
  getSession: async () => ({ id: state.userId }),
  requireOrgMembership: async (organizationId: string) => ({
    user: { id: state.userId },
    membership: { organizationId, userId: state.userId, role: state.role },
  }),
}));

vi.mock("@/server/security/rate-limit", () => ({
  enforceRateLimit: async (group: string) => {
    state.rateLimitGroups.push(group);
    return { allowed: !state.rateLimited, retryAfterSeconds: 0, message: "Too many requests. Please wait.", degraded: false };
  },
  clientAddress: async () => "127.0.0.1",
  normalizeIdentifier: (v: string) => v,
}));

vi.mock("@/domain/audit/audit-log", () => ({
  recordAuditEvent: async () => {},
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

/** Every repository write records that it was reached. If a role gate is
 *  missing, the corresponding name shows up here for a role that should have
 *  been refused. */
const write = (name: string) =>
  async (...args: unknown[]) => {
    state.writes.push(name);
    return name === "deleteTransaction" ? true : ({ id: "new-id", ...(args[1] as object) } as unknown);
  };

vi.mock("@/server/db/repositories/transactions", () => ({
  createTransaction: write("createTransaction"),
  deleteTransaction: write("deleteTransaction"),
  categorizeTransaction: write("categorizeTransaction"),
  bulkCategorize: write("bulkCategorize"),
  markTransactionsReviewed: write("markTransactionsReviewed"),
  listTransactions: async () => ({ transactions: [], total: 0, page: 1, pageSize: 50 }),
  getTransaction: async () => null,
}));
vi.mock("@/server/db/repositories/merchants", () => ({ findOrCreateMerchant: async () => ({ id: "m" }), listMerchants: async () => [] }));
vi.mock("@/server/db/repositories/bank-connections", () => ({ listBankFedAccounts: async () => new Map() }));
vi.mock("@/server/db/repositories/accounts", () => ({
  createAccount: write("createAccount"),
  archiveAccount: write("archiveAccount"),
  listAccounts: async () => [],
  listAccountBalances: async () => [],
}));
vi.mock("@/server/db/repositories/customers", () => ({ createCustomer: write("createCustomer"), listCustomers: async () => [] }));
vi.mock("@/server/db/repositories/invoices", () => ({
  createInvoice: write("createInvoice"),
  // `updateInvoiceStatus` was replaced by a transition guarded against the
  // state machine (0037 / domain/invoicing/lifecycle.ts). The action now
  // reads the invoice first, so `getInvoice` has to return one that is in a
  // state the requested transition is legal from — `sent` permits both
  // `paid` and `void`, which are the two cases this suite exercises.
  transitionInvoiceStatus: write("transitionInvoiceStatus"),
  recordInvoiceReminder: async () => {},
  listInvoices: async () => ({ invoices: [], total: 0 }),
  getInvoice: async () => ({
    id: "66666666-6666-4666-8666-666666666666",
    organizationId: ORG,
    status: "sent",
    dueDate: null,
    publicToken: null,
    paymentUrl: null,
    lineItems: [],
  }),
}));
vi.mock("@/server/db/repositories/documents", () => ({
  createPendingDocument: write("createPendingDocument"),
  markDocumentUploaded: write("markDocumentUploaded"),
  markDocumentRejected: write("markDocumentRejected"),
  deleteDocument: write("deleteDocument"),
  listReclaimableDocuments: async () => [],
  getDocument: async () => ({ id: DOCUMENT, organizationId: ORG, storagePath: `${ORG}/${DOCUMENT}.pdf`, status: "pending", mimeType: "application/pdf" }),
  getVisibleDocument: async () => ({ id: DOCUMENT, organizationId: ORG, storagePath: `${ORG}/${DOCUMENT}.pdf`, status: "uploaded", mimeType: "application/pdf" }),
  listDocuments: async () => [],
}));
vi.mock("@/server/storage/documents", () => ({
  createSignedUploadTarget: async (_c: unknown, storagePath: string) => {
    state.writes.push("createSignedUploadTarget");
    return { storagePath, signedUrl: "https://example.test/upload", token: "token" };
  },
  // A real PDF header, so the confirm path reaches its authorization outcome
  // rather than failing verification for an unrelated reason.
  observeUploadedObject: async () => ({ exists: true, sizeBytes: 1024, header: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]) }),
  deleteDocumentFile: write("deleteDocumentFile"),
  deleteDocumentFileIfPresent: async () => true,
  getDocumentDownloadUrl: async () => "https://example.test/signed",
}));
vi.mock("@/server/db/repositories/organizations", () => ({
  updateOrganization: write("updateOrganization"),
  getOrganization: async (_c: unknown, id: string) => ({ id, name: "Org", entityType: "personal", country: "US", baseCurrency: "USD" }),
  listMyOrganizations: async () => [],
}));
vi.mock("@/server/db/repositories/categories", () => ({ createCategory: write("createCategory"), listCategories: async () => [] }));
vi.mock("@/server/db/repositories/memberships", () => ({
  updateMemberRole: write("updateMemberRole"),
  getMyMembership: async (_c: unknown, organizationId: string, userId: string) => ({ organizationId, userId, role: state.targetRole }),
  listMembers: async () => [],
  listMembersWithEmail: async () => [],
}));
vi.mock("@/server/db/repositories/profiles", () => ({ updateProfile: write("updateProfile"), getProfile: async () => null }));

const ORG = "11111111-1111-4111-8111-111111111111";
const TARGET_USER = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "44444444-4444-4444-8444-444444444444";
const DOCUMENT = "77777777-7777-4777-8777-777777777777";

const { createTransactionAction, deleteTransactionAction } = await import("@/server/transactions/actions");
const { archiveAccountAction } = await import("@/server/accounts/actions");
const { updateInvoiceStatusAction } = await import("@/server/invoices/actions");
const { deleteDocumentAction, requestDocumentUpload, confirmDocumentUpload } = await import("@/server/documents/actions");
const { updateOrganizationAction } = await import("@/server/settings/actions");
const { updateMemberRoleAction } = await import("@/server/members/actions");

const ALL_ROLES: OrgRole[] = ["owner", "admin", "accountant", "manager", "employee", "viewer"];
const WRITE_ROLES: OrgRole[] = ["owner", "admin", "accountant", "manager", "employee"];
const DELETE_ROLES: OrgRole[] = ["owner", "admin", "accountant"];
const ADMIN_ROLES: OrgRole[] = ["owner", "admin"];

function transactionForm() {
  const form = new FormData();
  form.set("organizationId", ORG);
  form.set("accountId", ACCOUNT);
  form.set("kind", "expense");
  form.set("amount", "42.50");
  form.set("currency", "USD");
  form.set("occurredOn", "2026-03-01");
  return form;
}

function organizationForm() {
  const form = new FormData();
  form.set("organizationId", ORG);
  form.set("name", "Renamed Org");
  form.set("country", "US");
  form.set("stateRegion", "CA");
  form.set("baseCurrency", "USD");
  return form;
}

/** Runs `fn` and reports whether it refused — by returning an error, or by
 *  throwing, since the actions use both shapes. */
async function refused(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    const result = (await fn()) as { error?: string } | undefined;
    return Boolean(result?.error);
  } catch {
    return true;
  }
}

beforeEach(() => {
  state.role = "owner";
  state.writes = [];
  state.targetRole = "employee";
  state.rateLimited = false;
  state.rateLimitGroups = [];
});

describe.each([
  {
    name: "createTransactionAction",
    permitted: WRITE_ROLES,
    repository: "createTransaction",
    run: () => createTransactionAction({}, transactionForm()),
  },
  {
    name: "deleteTransactionAction",
    permitted: DELETE_ROLES,
    repository: "deleteTransaction",
    run: () => deleteTransactionAction(ORG, "55555555-5555-4555-8555-555555555555"),
  },
  {
    name: "archiveAccountAction",
    permitted: DELETE_ROLES,
    repository: "archiveAccount",
    run: () => archiveAccountAction(ORG, ACCOUNT),
  },
  {
    name: "updateInvoiceStatusAction (void)",
    permitted: DELETE_ROLES,
    repository: "transitionInvoiceStatus",
    run: () => updateInvoiceStatusAction(ORG, "66666666-6666-4666-8666-666666666666", "void"),
  },
  {
    name: "updateInvoiceStatusAction (paid)",
    permitted: WRITE_ROLES,
    repository: "transitionInvoiceStatus",
    run: () => updateInvoiceStatusAction(ORG, "66666666-6666-4666-8666-666666666666", "paid"),
  },
  {
    name: "deleteDocumentAction",
    permitted: DELETE_ROLES,
    repository: "deleteDocument",
    run: () => deleteDocumentAction(ORG, DOCUMENT),
  },
  // Both halves of the direct-to-Storage upload are gated independently. The
  // second one matters as much as the first: if only `requestDocumentUpload`
  // checked the role, a viewer who obtained a pending document id — their own
  // from before a demotion, say — could still promote it into a real document.
  {
    name: "requestDocumentUpload",
    permitted: WRITE_ROLES,
    repository: "createPendingDocument",
    run: () => requestDocumentUpload({ organizationId: ORG, kind: "receipt", originalFilename: "r.pdf", mimeType: "application/pdf", sizeBytes: 1024 }),
  },
  {
    name: "confirmDocumentUpload",
    permitted: WRITE_ROLES,
    repository: "markDocumentUploaded",
    run: () => confirmDocumentUpload({ organizationId: ORG, documentId: DOCUMENT }),
  },
  {
    name: "updateOrganizationAction",
    permitted: ADMIN_ROLES,
    repository: "updateOrganization",
    run: () => updateOrganizationAction({}, organizationForm()),
  },
])("$name", ({ permitted, repository, run }) => {
  const denied = ALL_ROLES.filter((r) => !permitted.includes(r));

  it.each(permitted)("permits %s, reaching the repository", async (role) => {
    state.role = role;
    await run().catch(() => {});
    expect(state.writes).toContain(repository);
  });

  it.each(denied)("refuses %s, without reaching the repository", async (role) => {
    state.role = role;
    expect(await refused(run)).toBe(true);
    expect(state.writes).not.toContain(repository);
  });
});

/**
 * Member role changes have their own rule, stricter than `org:manage_members`
 * alone: only an owner may grant owner, or touch someone who already is one.
 * Blocking self-edits was not enough — an admin used a second account they
 * controlled, granted it owner, then removed the real owner.
 */
describe("updateMemberRoleAction", () => {
  it("lets an admin change an ordinary member's role", async () => {
    state.role = "admin";
    state.targetRole = "employee";
    await updateMemberRoleAction(ORG, TARGET_USER, "manager");
    expect(state.writes).toContain("updateMemberRole");
  });

  it("stops an admin granting owner", async () => {
    state.role = "admin";
    state.targetRole = "employee";
    expect(await refused(() => updateMemberRoleAction(ORG, TARGET_USER, "owner"))).toBe(true);
    expect(state.writes).not.toContain("updateMemberRole");
  });

  it("stops an admin demoting an existing owner", async () => {
    state.role = "admin";
    state.targetRole = "owner";
    expect(await refused(() => updateMemberRoleAction(ORG, TARGET_USER, "viewer"))).toBe(true);
    expect(state.writes).not.toContain("updateMemberRole");
  });

  it("lets an owner grant owner", async () => {
    state.role = "owner";
    state.targetRole = "employee";
    await updateMemberRoleAction(ORG, TARGET_USER, "owner");
    expect(state.writes).toContain("updateMemberRole");
  });

  it("stops a member escalating their own role", async () => {
    state.role = "admin";
    state.targetRole = "admin";
    expect(await refused(() => updateMemberRoleAction(ORG, state.userId, "owner"))).toBe(true);
    expect(state.writes).not.toContain("updateMemberRole");
  });

  it.each(["accountant", "manager", "employee", "viewer"] as OrgRole[])("stops %s changing anyone's role", async (role) => {
    state.role = role;
    expect(await refused(() => updateMemberRoleAction(ORG, TARGET_USER, "admin"))).toBe(true);
    expect(state.writes).not.toContain("updateMemberRole");
  });
});

/**
 * Rate limiting on record mutation.
 *
 * These actions were bounded only by authorization: an authenticated member
 * could insert or delete records as fast as the network allowed. That is a
 * storage-cost and audit-noise surface even though every write is
 * tenant-scoped, and the limiter has to sit AFTER authorization so it is keyed
 * on an identity that was verified rather than one the request asserted.
 */
describe("record mutation is rate limited, after authorization", () => {
  beforeEach(() => {
    state.rateLimited = false;
    state.rateLimitGroups = [];
  });

  it.each([
    ["createTransactionAction", () => createTransactionAction({}, transactionForm())],
    ["deleteTransactionAction", () => deleteTransactionAction(ORG, "55555555-5555-4555-8555-555555555555")],
    ["archiveAccountAction", () => archiveAccountAction(ORG, ACCOUNT)],
    ["updateInvoiceStatusAction", () => updateInvoiceStatusAction(ORG, "66666666-6666-4666-8666-666666666666", "paid")],
    ["deleteDocumentAction", () => deleteDocumentAction(ORG, DOCUMENT)],
    ["updateOrganizationAction", () => updateOrganizationAction({}, organizationForm())],
  ])("%s consumes a limit", async (_name, run) => {
    await run().catch(() => {});
    expect(state.rateLimitGroups).toContain("recordMutation");
  });

  it.each([
    ["createTransactionAction", "createTransaction", () => createTransactionAction({}, transactionForm())],
    ["deleteTransactionAction", "deleteTransaction", () => deleteTransactionAction(ORG, "55555555-5555-4555-8555-555555555555")],
    ["updateOrganizationAction", "updateOrganization", () => updateOrganizationAction({}, organizationForm())],
  ])("%s writes nothing once the limit is exhausted", async (_name, repository, run) => {
    state.rateLimited = true;
    expect(await refused(run)).toBe(true);
    expect(state.writes).not.toContain(repository);
  });

  it("uses the stricter privileged budget for a role change", async () => {
    state.role = "owner";
    state.targetRole = "employee";
    await updateMemberRoleAction(ORG, TARGET_USER, "manager").catch(() => {});

    expect(state.rateLimitGroups).toContain("privilegedMutation");
    expect(state.rateLimitGroups).not.toContain("recordMutation");
  });

  it("refuses an unauthorized caller BEFORE spending their limit", async () => {
    // Ordering: an attacker who cannot pass authorization must not be able to
    // exhaust a legitimate user's budget by trying.
    state.role = "viewer";
    state.rateLimited = false;
    await refused(() => deleteTransactionAction(ORG, "55555555-5555-4555-8555-555555555555"));

    expect(state.rateLimitGroups).toEqual([]);
  });
});
