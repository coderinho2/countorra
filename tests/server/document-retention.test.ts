import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE RETENTION SWEEP, and the endpoint that runs it.
 *
 * Two boundaries, tested separately. The SWEEP has to be safe to run twice,
 * safe to interrupt, and incapable of touching a document it was not offered.
 * The ENDPOINT has to be unreachable without the deployment secret.
 *
 * The database side — what is offered, and to whom — is proven against real
 * Postgres in tests/rls/identity-document-retention.test.ts. Here the
 * repository is a stub, so these cases are about the ORDER of operations and
 * what happens when a step fails.
 */

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  return {
    due: [] as { documentId: string; organizationId: string; storagePath: string }[],
    /** Paths whose object is already gone, as a re-run would find. */
    missing: new Set<string>(),
    /** Paths whose delete throws, as a storage outage would. */
    deleteThrows: new Set<string>(),
    /** Documents the mark step refuses, as an already-marked row does. */
    markRefuses: new Set<string>(),
    markThrows: new Set<string>(),
    /** Everything that happened, in order. */
    calls: [] as string[],
    limitAsked: 0,
    // Route state.
    cronSecret: null as string | null,
    rateLimited: false,
    sweepThrows: false,
    sweeps: 0,
    events: [] as { name: string; detail: Record<string, unknown> }[],
  };
});

vi.mock("server-only", () => ({}));

vi.mock("@/server/db/repositories/documents", () => ({
  listExpiredDocumentOriginals: async (_client: unknown, limit: number) => {
    state.limitAsked = limit;
    state.calls.push(`list(${limit})`);
    return state.due;
  },
  markDocumentOriginalRemoved: async (_client: unknown, organizationId: string, documentId: string) => {
    state.calls.push(`mark(${organizationId},${documentId})`);
    if (state.markThrows.has(documentId)) throw new Error("mark failed");
    return !state.markRefuses.has(documentId);
  },
}));

vi.mock("@/server/storage/documents", () => ({
  deleteDocumentFileIfPresent: async (_client: unknown, path: string) => {
    state.calls.push(`delete(${path})`);
    if (state.deleteThrows.has(path)) throw new Error("storage unavailable");
    return !state.missing.has(path);
  },
}));

vi.mock("@/lib/observability", () => ({
  reportEvent: (name: string, context: { detail?: Record<string, unknown> }) => state.events.push({ name, detail: context.detail ?? {} }),
  reportError: () => {},
}));

const { sweepExpiredIdentityOriginals } = await import("@/server/documents/retention");
const { RETENTION_SWEEP_BATCH, IDENTITY_ORIGINAL_RETENTION_DAYS, identityOriginalExpiry, originalExpiresAfterReading } = await import("@/domain/documents/retention");

const client = {} as never;

const row = (index: number, organizationId = "org-a") => ({ documentId: `doc-${index}`, organizationId, storagePath: `${organizationId}/file-${index}.jpg` });

beforeEach(() => {
  state.due = [];
  state.missing = new Set();
  state.deleteThrows = new Set();
  state.markRefuses = new Set();
  state.markThrows = new Set();
  state.calls = [];
  state.events = [];
});

describe("the policy itself", () => {
  it("expires an identity document and nothing else", () => {
    expect(originalExpiresAfterReading("DRIVER_LICENSE")).toBe(true);
    expect(originalExpiresAfterReading("PASSPORT")).toBe(true);
    expect(originalExpiresAfterReading("SSN_DOCUMENT")).toBe(true);
    expect(originalExpiresAfterReading("GOVERNMENT_ID")).toBe(true);
    // A receipt is evidence for a tax figure and may be wanted years later.
    for (const type of ["RECEIPT", "INVOICE", "BILL", "W2", "BANK_STATEMENT", "PAY_STUB", "UNKNOWN"] as const) {
      expect(originalExpiresAfterReading(type), type).toBe(false);
    }
  });

  it("measures the window from the read", () => {
    const read = new Date("2026-09-24T12:00:00.000Z");
    const expiry = identityOriginalExpiry(read);
    expect((expiry.getTime() - read.getTime()) / (24 * 60 * 60 * 1000)).toBe(IDENTITY_ORIGINAL_RETENTION_DAYS);
  });
});

describe("the sweep does the right things in the right order", () => {
  it("deletes the bytes BEFORE marking the row", async () => {
    state.due = [row(1)];
    await sweepExpiredIdentityOriginals(client);
    // Marking first and then failing to delete would record a file as gone
    // while it sat in the bucket, and nothing would look at it again.
    expect(state.calls).toEqual(["list(50)", "delete(org-a/file-1.jpg)", "mark(org-a,doc-1)"]);
  });

  it("passes each row's own organization to the mark, never a shared one", async () => {
    state.due = [row(1, "org-a"), row(2, "org-b")];
    await sweepExpiredIdentityOriginals(client);
    expect(state.calls).toContain("mark(org-a,doc-1)");
    expect(state.calls).toContain("mark(org-b,doc-2)");
  });

  it("counts a file that was already gone as done, so a re-run is not wedged", async () => {
    state.due = [row(1)];
    state.missing.add("org-a/file-1.jpg");

    const result = await sweepExpiredIdentityOriginals(client);

    expect(result.filesRemoved).toBe(0);
    // The row is still marked: the outcome wanted is "no bytes", and there
    // are none.
    expect(result.rowsMarked).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("reports a row the database had already marked without calling it a failure", async () => {
    state.due = [row(1)];
    state.markRefuses.add("doc-1");
    const result = await sweepExpiredIdentityOriginals(client);
    expect(result.rowsMarked).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("keeps going after one row fails, and leaves that one for the next run", async () => {
    state.due = [row(1), row(2), row(3)];
    state.deleteThrows.add("org-a/file-2.jpg");

    const result = await sweepExpiredIdentityOriginals(client);

    expect(result.failed).toBe(1);
    expect(result.rowsMarked).toBe(2);
    // The failed row was NOT marked, so the database still offers it.
    expect(state.calls).not.toContain("mark(org-a,doc-2)");
    expect(state.calls).toContain("mark(org-a,doc-3)");
  });

  it("does not mark a row whose delete threw", async () => {
    state.due = [row(1)];
    state.deleteThrows.add("org-a/file-1.jpg");
    const result = await sweepExpiredIdentityOriginals(client);
    expect(state.calls).toEqual(["list(50)", "delete(org-a/file-1.jpg)"]);
    expect(result.rowsMarked).toBe(0);
  });

  it("is bounded, and cannot be asked for more than the batch", async () => {
    await sweepExpiredIdentityOriginals(client, { batchSize: 10_000 });
    expect(state.limitAsked).toBe(RETENTION_SWEEP_BATCH);
    await sweepExpiredIdentityOriginals(client, { batchSize: 0 });
    expect(state.limitAsked).toBe(1);
  });

  it("says when more is waiting rather than looping here", async () => {
    state.due = Array.from({ length: 3 }, (_, index) => row(index));
    expect((await sweepExpiredIdentityOriginals(client, { batchSize: 3 })).remaining).toBe(true);
    expect((await sweepExpiredIdentityOriginals(client, { batchSize: 4 })).remaining).toBe(false);
  });

  it("does nothing at all when nothing is due", async () => {
    const result = await sweepExpiredIdentityOriginals(client);
    expect(state.calls).toEqual(["list(50)"]);
    expect(result).toMatchObject({ considered: 0, filesRemoved: 0, rowsMarked: 0, failed: 0, remaining: false });
  });
});

describe("what the sweep says about itself", () => {
  it("reports counts and no path, filename or organization", async () => {
    state.due = [row(1)];
    await sweepExpiredIdentityOriginals(client);

    const event = state.events.find((entry) => entry.name === "documents.retention_swept");
    expect(event).toBeDefined();
    expect(Object.keys(event!.detail).sort()).toEqual(["considered", "failed", "filesRemoved", "rowsMarked"]);
    const serialized = JSON.stringify(event);
    // A storage path contains a document id, and this ends up in a log.
    expect(serialized).not.toContain("file-1.jpg");
    expect(serialized).not.toContain("org-a");
    expect(serialized).not.toContain("doc-1");
  });
});
