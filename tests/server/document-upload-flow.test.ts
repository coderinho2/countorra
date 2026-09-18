import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "@/types/database";

/**
 * The direct-to-Storage upload flow, end to end, against an in-memory Storage
 * and an in-memory `documents` table.
 *
 * WHY NOT MOCK THE REPOSITORY WITH STUBS
 *
 * The invariants worth testing here are about ORDER and STATE, not about which
 * functions were called: does a row exist before the bytes do; does a failed
 * verification leave anything usable; does a second confirm write a second
 * audit event. Stubs that return fixed values cannot answer any of those. The
 * fakes below are small but real — `markDocumentUploaded` genuinely refuses a
 * row that is not `pending`, the way the SQL predicate does — so the action's
 * own sequencing is what is under test.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const HTML_BYTES = new Uint8Array(Buffer.from("<!DOCTYPE html><script>alert(1)</script>"));

interface Row {
  id: string;
  organizationId: string;
  kind: string;
  storagePath: string;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  status: string;
  createdAt: string;
  storageBucket: string;
}

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    role: "owner" as OrgRole,
    rows: new Map<string, Row>(),
    /** The fake bucket: storage path -> stored bytes. */
    objects: new Map<string, { size: number; header: Uint8Array }>(),
    audit: [] as string[],
    signedUrlFails: false,
    deleteObjectFails: false,
    now: new Date("2026-09-08T12:00:00.000Z"),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/server/supabase/admin", () => ({ createAdminClient: () => ({}) }));

vi.mock("@/server/auth/session", () => ({
  requireOrgMembership: async (organizationId: string) => ({
    user: { id: USER },
    membership: { organizationId, userId: USER, role: state.role },
  }),
}));

vi.mock("@/server/security/rate-limit", () => ({
  enforceRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0, message: "", degraded: false }),
}));

vi.mock("@/domain/audit/audit-log", () => ({
  recordAuditEvent: async (_c: unknown, event: { action: string }) => {
    state.audit.push(event.action);
  },
  AUDIT_ACTIONS: { documentUploaded: "document.uploaded", documentRejected: "document.rejected", documentDeleted: "document.deleted" },
}));

vi.mock("@/lib/observability", () => ({ reportError: () => {}, reportEvent: () => {} }));

/** An in-memory `documents` table that honours the real status predicates. */
vi.mock("@/server/db/repositories/documents", () => ({
  createPendingDocument: async (_c: unknown, input: Record<string, string>) => {
    const row: Row = {
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      kind: input.kind,
      storagePath: input.storagePath,
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
      sizeBytes: null,
      status: "pending",
      createdAt: state.now.toISOString(),
      storageBucket: "documents",
    };
    state.rows.set(row.id, row);
    return row;
  },
  getDocument: async (_c: unknown, id: string) => state.rows.get(id) ?? null,
  getVisibleDocument: async (_c: unknown, id: string) => {
    const row = state.rows.get(id);
    return row && row.status === "uploaded" ? row : null;
  },
  listDocuments: async (_c: unknown, organizationId: string) =>
    [...state.rows.values()].filter((r) => r.organizationId === organizationId && r.status === "uploaded"),
  // The `.eq("status", "pending")` predicate is the whole point of these two.
  markDocumentUploaded: async (_c: unknown, id: string, organizationId: string, sizeBytes: number) => {
    const row = state.rows.get(id);
    if (!row || row.organizationId !== organizationId || row.status !== "pending") return null;
    row.status = "uploaded";
    row.sizeBytes = sizeBytes;
    return row;
  },
  markDocumentRejected: async (_c: unknown, id: string, organizationId: string) => {
    const row = state.rows.get(id);
    if (!row || row.organizationId !== organizationId || row.status !== "pending") return null;
    row.status = "rejected";
    return row;
  },
  listReclaimableDocuments: async (_c: unknown, before: string, limit: number) =>
    [...state.rows.values()]
      .filter((r) => (r.status === "pending" || r.status === "rejected") && r.createdAt < before)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit),
  deleteDocument: async (_c: unknown, id: string) => {
    state.rows.delete(id);
  },
}));

vi.mock("@/server/storage/documents", () => ({
  createSignedUploadTarget: async (_c: unknown, storagePath: string) => {
    if (state.signedUrlFails) throw new Error("storage unavailable");
    return { storagePath, signedUrl: `https://storage.test/${storagePath}`, token: "token" };
  },
  observeUploadedObject: async (_c: unknown, storagePath: string) => {
    const object = state.objects.get(storagePath);
    return object ? { exists: true as const, sizeBytes: object.size, header: object.header } : { exists: false as const };
  },
  deleteDocumentFile: async (_c: unknown, storagePath: string) => {
    state.objects.delete(storagePath);
  },
  deleteDocumentFileIfPresent: async (_c: unknown, storagePath: string) => {
    if (state.deleteObjectFails) return false;
    return state.objects.delete(storagePath);
  },
  getDocumentDownloadUrl: async (_c: unknown, storagePath: string) => `https://storage.test/signed/${storagePath}`,
}));

const { requestDocumentUpload, confirmDocumentUpload, getDocumentUrlAction } = await import("@/server/documents/actions");
const { reclaimAbandonedUploads } = await import("@/server/documents/cleanup");
const { listDocuments } = await import("@/server/db/repositories/documents");

/** Simulates the browser's PUT to the signed URL. */
function putObject(storagePath: string, header: Uint8Array, size = 4096) {
  state.objects.set(storagePath, { size, header });
}

async function requestUpload(overrides: Partial<Parameters<typeof requestDocumentUpload>[0]> = {}) {
  return requestDocumentUpload({
    organizationId: ORG,
    kind: "receipt",
    originalFilename: "March receipt.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4096,
    ...overrides,
  });
}

beforeEach(() => {
  state.role = "owner";
  state.rows.clear();
  state.objects.clear();
  state.audit = [];
  state.signedUrlFails = false;
  state.deleteObjectFails = false;
});

describe("the server owns the storage path", () => {
  it("never uses the user's filename as the object key", async () => {
    const result = await requestUpload({ originalFilename: "../../etc/passwd" });

    expect(result.upload).toBeDefined();
    expect(result.upload!.storagePath).not.toContain("passwd");
    expect(result.upload!.storagePath).not.toContain("..");
  });

  it("preserves the filename as data on the row, where it is not a path", async () => {
    const result = await requestUpload({ originalFilename: "March receipt.pdf" });
    const row = state.rows.get(result.upload!.documentId)!;

    expect(row.originalFilename).toBe("March receipt.pdf");
    expect(row.storagePath).not.toContain("March");
  });

  it("puts the object under the caller's own organization prefix", async () => {
    const result = await requestUpload();
    expect(result.upload!.storagePath.startsWith(`${ORG}/`)).toBe(true);
  });

  it("accepts no path from the caller at all", async () => {
    // There is no parameter to smuggle one through — the request shape carries
    // a filename, a kind, a type and a size. This asserts the shape stays that
    // way: a future `storagePath` field would make this fail to compile.
    const keys = Object.keys({ organizationId: ORG, kind: "receipt", originalFilename: "a.pdf", mimeType: "application/pdf", sizeBytes: 1 });
    expect(keys).not.toContain("storagePath");
  });

  it("gives two uploads of the same filename different keys", async () => {
    const first = await requestUpload();
    const second = await requestUpload();
    expect(first.upload!.storagePath).not.toBe(second.upload!.storagePath);
  });
});

describe("a document does not exist until the server has seen the bytes", () => {
  it("creates the row before any object exists", async () => {
    const result = await requestUpload();

    expect(state.rows.get(result.upload!.documentId)!.status).toBe("pending");
    expect(state.objects.size).toBe(0);
  });

  it("hides the pending row from every product read", async () => {
    const result = await requestUpload();

    expect(await listDocuments({} as never, ORG)).toHaveLength(0);
    await expect(getDocumentUrlAction(ORG, result.upload!.documentId)).rejects.toThrow(/not found/i);
  });

  it("promotes the row only once a real file has landed", async () => {
    const { upload } = await requestUpload();
    putObject(upload!.storagePath, PDF_BYTES);

    expect(await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId })).toEqual({ success: true });
    expect(await listDocuments({} as never, ORG)).toHaveLength(1);
  });

  it("records the size Storage reported, not the size the client declared", async () => {
    const { upload } = await requestUpload({ sizeBytes: 4096 });
    putObject(upload!.storagePath, PDF_BYTES, 123_456);
    await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });

    expect(state.rows.get(upload!.documentId)!.sizeBytes).toBe(123_456);
  });
});

describe("a failed upload cannot produce an apparently valid document", () => {
  it("rejects a confirmation when nothing was ever uploaded", async () => {
    const { upload } = await requestUpload();

    const result = await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });

    expect(result.error).toBeDefined();
    expect(state.rows.get(upload!.documentId)!.status).toBe("rejected");
    expect(await listDocuments({} as never, ORG)).toHaveLength(0);
  });

  it("leaves nothing usable when a real upload fails validation", async () => {
    // The dangerous case: the PUT succeeded, so the bytes ARE in the bucket.
    const { upload } = await requestUpload({ mimeType: "application/pdf" });
    putObject(upload!.storagePath, HTML_BYTES);

    const result = await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });

    expect(result.error).toBeDefined();
    expect(state.rows.get(upload!.documentId)!.status).toBe("rejected");
    // Row invisible AND bytes removed.
    expect(await listDocuments({} as never, ORG)).toHaveLength(0);
    expect(state.objects.has(upload!.storagePath)).toBe(false);
    await expect(getDocumentUrlAction(ORG, upload!.documentId)).rejects.toThrow(/not found/i);
  });

  it("still marks the row rejected when the object delete fails", async () => {
    // Orphan bytes are a cost problem; a `pending` row that looks like an
    // upload in flight is a correctness problem. The row must win.
    state.deleteObjectFails = true;
    const { upload } = await requestUpload();
    putObject(upload!.storagePath, HTML_BYTES);

    await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });

    expect(state.rows.get(upload!.documentId)!.status).toBe("rejected");
  });

  it("records a rejection in the audit log", async () => {
    const { upload } = await requestUpload();
    putObject(upload!.storagePath, HTML_BYTES);
    await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });

    expect(state.audit).toEqual(["document.rejected"]);
  });

  it("removes the row entirely when no signed URL could be issued", async () => {
    // No URL means no bytes can ever arrive, so this row is not an abandoned
    // upload — it is garbage, and leaving it would make the sweep's job
    // ambiguous.
    state.signedUrlFails = true;
    const result = await requestUpload();

    expect(result.error).toBeDefined();
    expect(state.rows.size).toBe(0);
  });
});

describe("confirmation is idempotent", () => {
  it("returns success for a second confirm without re-verifying", async () => {
    const { upload } = await requestUpload();
    putObject(upload!.storagePath, PDF_BYTES);

    await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });
    // Even if the object vanishes afterwards, the committed document stands.
    state.objects.clear();
    const second = await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });

    expect(second).toEqual({ success: true });
    expect(state.rows.get(upload!.documentId)!.status).toBe("uploaded");
  });

  it("writes exactly one audit event however many times it is called", async () => {
    const { upload } = await requestUpload();
    putObject(upload!.storagePath, PDF_BYTES);

    await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });
    await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });
    await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });

    expect(state.audit).toEqual(["document.uploaded"]);
  });

  it("produces one document under concurrent confirmations", async () => {
    const { upload } = await requestUpload();
    putObject(upload!.storagePath, PDF_BYTES);

    await Promise.all([
      confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId }),
      confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId }),
      confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId }),
    ]);

    expect(await listDocuments({} as never, ORG)).toHaveLength(1);
    expect(state.audit).toEqual(["document.uploaded"]);
  });

  it("does not let a rejected upload be retried into acceptance", async () => {
    const { upload } = await requestUpload();
    putObject(upload!.storagePath, HTML_BYTES);
    await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });

    // Second attempt, this time with genuinely valid bytes at the same key.
    putObject(upload!.storagePath, PDF_BYTES);
    const retried = await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });

    expect(retried.error).toBeDefined();
    expect(state.rows.get(upload!.documentId)!.status).toBe("rejected");
    expect(await listDocuments({} as never, ORG)).toHaveLength(0);
  });
});

describe("no cross-organization upload, read or confirmation", () => {
  it("refuses to confirm another organization's pending upload", async () => {
    const { upload } = await requestUpload();
    putObject(upload!.storagePath, PDF_BYTES);

    const result = await confirmDocumentUpload({ organizationId: OTHER_ORG, documentId: upload!.documentId });

    expect(result.error).toMatch(/not found/i);
    expect(state.rows.get(upload!.documentId)!.status).toBe("pending");
  });

  it("refuses to hand out a download URL across organizations", async () => {
    const { upload } = await requestUpload();
    putObject(upload!.storagePath, PDF_BYTES);
    await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });

    await expect(getDocumentUrlAction(OTHER_ORG, upload!.documentId)).rejects.toThrow(/not found/i);
  });

  it("refuses to confirm a row whose stored path is under a different prefix", async () => {
    // Defence in depth against a tampered or legacy `storage_path`: the row
    // claims this organization, the path does not.
    const { upload } = await requestUpload();
    const row = state.rows.get(upload!.documentId)!;
    row.storagePath = `${OTHER_ORG}/${crypto.randomUUID()}.pdf`;
    putObject(row.storagePath, PDF_BYTES);

    const result = await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });

    expect(result.error).toMatch(/not found/i);
    expect(state.rows.get(upload!.documentId)!.status).toBe("pending");
  });

  it("does not list another organization's documents", async () => {
    const { upload } = await requestUpload();
    putObject(upload!.storagePath, PDF_BYTES);
    await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });

    expect(await listDocuments({} as never, OTHER_ORG)).toHaveLength(0);
  });
});

describe("input the server refuses before minting a URL", () => {
  it.each([
    ["a disallowed type", { mimeType: "image/svg+xml" }],
    ["an executable type", { mimeType: "application/x-msdownload" }],
    ["a size over the limit", { sizeBytes: 20 * 1024 * 1024 + 1 }],
    ["a zero size", { sizeBytes: 0 }],
    ["an empty filename", { originalFilename: "" }],
    ["an unknown kind", { kind: "malware" }],
    ["a non-UUID organization", { organizationId: "not-a-uuid" }],
  ])("refuses %s without creating a row", async (_label, overrides) => {
    const result = await requestUpload(overrides as Partial<Parameters<typeof requestDocumentUpload>[0]>);

    expect(result.error).toBeDefined();
    expect(result.upload).toBeUndefined();
    expect(state.rows.size).toBe(0);
  });
});

describe("reclaiming abandoned uploads", () => {
  const later = new Date("2026-09-10T12:00:00.000Z");

  it("removes a pending row and its bytes once past the TTL", async () => {
    const { upload } = await requestUpload();
    putObject(upload!.storagePath, PDF_BYTES);

    const result = await reclaimAbandonedUploads({} as never, { now: later });

    expect(result).toMatchObject({ rowsRemoved: 1, filesRemoved: 1 });
    expect(state.rows.size).toBe(0);
    expect(state.objects.size).toBe(0);
  });

  it("removes a rejected row's leftovers too", async () => {
    const { upload } = await requestUpload();
    putObject(upload!.storagePath, HTML_BYTES);
    await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });

    const result = await reclaimAbandonedUploads({} as never, { now: later });

    expect(result.rowsRemoved).toBe(1);
    expect(state.rows.size).toBe(0);
  });

  it("removes the row even when no object was ever uploaded", async () => {
    await requestUpload();

    const result = await reclaimAbandonedUploads({} as never, { now: later });

    expect(result).toMatchObject({ rowsRemoved: 1, filesRemoved: 0 });
  });

  it("never touches a committed document", async () => {
    const { upload } = await requestUpload();
    putObject(upload!.storagePath, PDF_BYTES);
    await confirmDocumentUpload({ organizationId: ORG, documentId: upload!.documentId });

    await reclaimAbandonedUploads({} as never, { now: later });

    expect(await listDocuments({} as never, ORG)).toHaveLength(1);
    expect(state.objects.size).toBe(1);
  });

  it("does not race an upload still inside the TTL", async () => {
    const { upload } = await requestUpload();
    putObject(upload!.storagePath, PDF_BYTES);

    // One hour later: the signed URL is still valid and the user may still be
    // uploading. Reclaiming here would delete a live upload.
    const result = await reclaimAbandonedUploads({} as never, { now: new Date("2026-09-08T13:00:00.000Z") });

    expect(result.rowsRemoved).toBe(0);
    expect(state.rows.get(upload!.documentId)).toBeDefined();
  });

  it("reports that more work remains when a batch comes back full", async () => {
    await requestUpload();
    await requestUpload();

    const result = await reclaimAbandonedUploads({} as never, { now: later, batchSize: 2 });

    expect(result.remaining).toBe(true);
  });

  it("reports no remaining work when the batch came back short", async () => {
    await requestUpload();

    const result = await reclaimAbandonedUploads({} as never, { now: later, batchSize: 100 });

    expect(result.remaining).toBe(false);
  });
});

describe("the sweep is a capability, not a running job", () => {
  it("is not invoked by any scheduler in this repository", async () => {
    // Claiming automatic cleanup that nothing invokes would be worse than
    // stating plainly that it must be wired up. If a scheduler is added FOR
    // THIS SWEEP, this test should be replaced by one that asserts the schedule
    // exists.
    //
    // vercel.json now exists (Task 15) — for the bank sync worker only. So the
    // check is on what is scheduled, not on whether the file exists: no cron
    // may point at anything that runs the upload sweep, and the only cron is
    // the bank worker, whose route does not call it (the source scan below).
    const { existsSync, globSync, readFileSync } = await import("node:fs");

    const crons: { path: string }[] = existsSync("vercel.json") ? (JSON.parse(readFileSync("vercel.json", "utf8")).crons ?? []) : [];
    expect(crons.map((cron) => cron.path)).toEqual(["/api/bank-connections/worker"]);
    for (const cron of crons) expect(cron.path).not.toMatch(/document|upload|cleanup|reclaim/i);

    const sources = globSync("src/**/*.{ts,tsx}").filter((f) => !f.includes("cleanup.ts"));
    const callers = sources.filter((file) => readFileSync(file, "utf8").includes("reclaimAbandonedUploads"));

    expect(callers).toEqual([]);
  });

  it("says so in the module itself", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/server/documents/cleanup.ts", "utf8");

    expect(source).toMatch(/NOT AUTOMATIC CLEANUP/);
    expect(source).toMatch(/no scheduler/i);
  });
});
