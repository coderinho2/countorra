import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TextExtractionProvider } from "@/domain/documents/intelligence/provider";
import { PROCESSING_VERSION } from "@/domain/documents/intelligence/types";
import { PdfTextLayerProvider } from "@/server/documents/pdf-text-layer";
import { buildTextPdf, syntheticW2Lines } from "../fixtures/synthetic-pdf";

/**
 * The processing entry point, end to end through the real PDF reader, the real
 * extraction and the real state machine. Only persistence and observability are
 * replaced — with an in-memory store that applies the same transition rules.
 *
 * A (regression): only verified documents are read.  B, C, D: files that must
 * not be parsed.  E, F, G, H: states, idempotency, retries, versions.
 * AC, AD, AE: malformed, slow and failing providers.  Observability is checked
 * for leaked content.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

interface MemoryJob {
  id: string;
  organizationId: string;
  documentId: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
  processingVersion: string;
  provider: string;
  providerVersion: string;
  failureCategory: string | null;
  failureMessage: string | null;
  requestedBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const state = vi.hoisted(() => ({
  document: null as Record<string, unknown> | null,
  jobs: [] as MemoryJob[],
  extractions: [] as { jobId: string; draft: { status: string; fields: unknown[]; classification: { documentType: string } } }[],
  failRecord: false,
  events: [] as { name: string; context: unknown }[],
  errors: [] as unknown[],
  nextId: 1,
}));

vi.mock("@/lib/observability", () => ({
  reportEvent: (name: string, context: unknown) => void state.events.push({ name, context }),
  reportError: (error: unknown, context: unknown) => void state.errors.push({ error, context }),
}));

vi.mock("@/server/db/repositories/documents", () => ({
  getVisibleDocument: async () => state.document,
}));

vi.mock("@/server/db/repositories/document-intelligence", () => ({
  listJobsForDocument: async () => [...state.jobs].reverse(),
  insertQueuedJob: async (_admin: unknown, input: Record<string, unknown>) => {
    if (state.jobs.some((job) => job.idempotencyKey === input.idempotencyKey || ["QUEUED", "PROCESSING"].includes(job.status))) return "CONFLICT";
    const job: MemoryJob = {
      id: `job-${state.nextId++}`,
      organizationId: input.organizationId as string,
      documentId: input.documentId as string,
      status: "QUEUED",
      attempts: 0,
      maxAttempts: input.maxAttempts as number,
      idempotencyKey: input.idempotencyKey as string,
      processingVersion: input.processingVersion as string,
      provider: input.provider as string,
      providerVersion: input.providerVersion as string,
      failureCategory: null,
      failureMessage: null,
      requestedBy: input.requestedBy as string,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-09-14T10:00:00Z",
      updatedAt: "2026-09-14T10:00:00Z",
    };
    state.jobs.push(job);
    return { ...job };
  },
  claimJob: async (_admin: unknown, job: MemoryJob, now: Date) => {
    const stored = state.jobs.find((candidate) => candidate.id === job.id && candidate.status === "QUEUED");
    if (!stored) return null;
    Object.assign(stored, { status: "PROCESSING", attempts: stored.attempts + 1, startedAt: now.toISOString() });
    return { ...stored };
  },
  failJob: async (_admin: unknown, job: MemoryJob, from: string, category: string, message: string) => {
    const stored = state.jobs.find((candidate) => candidate.id === job.id && candidate.status === from);
    if (!stored) return null;
    Object.assign(stored, { status: "FAILED", failureCategory: category, failureMessage: message });
    return { ...stored };
  },
  requeueJob: async (_admin: unknown, job: MemoryJob) => {
    const stored = state.jobs.find((candidate) => candidate.id === job.id && candidate.status === "FAILED");
    if (!stored || stored.attempts >= stored.maxAttempts) return null;
    Object.assign(stored, { status: "QUEUED", failureCategory: null, failureMessage: null, startedAt: null });
    return { ...stored };
  },
  recordExtraction: async (_admin: unknown, input: { jobId: string; draft: { status: string; fields: unknown[]; classification: { documentType: string } } }) => {
    if (state.failRecord) throw new Error("connection reset while inserting document_extracted_fields");
    const stored = state.jobs.find((candidate) => candidate.id === input.jobId)!;
    if (stored.status !== "PROCESSING") throw new Error("only a running job can record an extraction");
    state.extractions.push({ jobId: input.jobId, draft: input.draft });
    stored.status = input.draft.status;
    return `extraction-${state.extractions.length}`;
  },
}));

const { processDocument } = await import("@/server/documents/processing");

const W2_BYTES = buildTextPdf([syntheticW2Lines()], { compress: true });
const pdfReader = new PdfTextLayerProvider();

function deps(overrides: Partial<Parameters<typeof processDocument>[0]> = {}) {
  return {
    client: {} as never,
    admin: {} as never,
    providers: [pdfReader] as readonly TextExtractionProvider[],
    now: () => new Date("2026-09-14T12:00:00.000Z"),
    download: vi.fn(async () => ({ ok: true as const, bytes: W2_BYTES })),
    providerTimeoutMs: 5_000,
    ...overrides,
  };
}

const run = (overrides: Partial<Parameters<typeof processDocument>[0]> = {}) => processDocument(deps(overrides), { organizationId: ORG, documentId: DOC, userId: USER });

function failing(behaviour: "throw" | "hang" | "malformed"): TextExtractionProvider {
  return {
    id: pdfReader.id,
    version: pdfReader.version,
    method: "PDF_TEXT_LAYER",
    supports: (mime) => mime === "application/pdf",
    extractText: async () => {
      if (behaviour === "throw") throw new Error("reader crashed on /documents/secret-path.pdf");
      if (behaviour === "hang") return new Promise(() => {});
      return { provider: pdfReader.id, providerVersion: pdfReader.version, method: "PDF_TEXT_LAYER", pageCount: 1, pages: [{ pageNumber: 1, lines: [{ text: 42 }] }], warnings: [] };
    },
  };
}

beforeEach(() => {
  Object.assign(state, {
    document: { id: DOC, organizationId: ORG, kind: "tax_form", storageBucket: "documents", storagePath: `${ORG}/44444444-4444-4444-8444-444444444444.pdf`, originalFilename: "w2.pdf", mimeType: "application/pdf", sizeBytes: W2_BYTES.byteLength, status: "uploaded", createdAt: "2026-09-14T09:00:00Z" },
    jobs: [],
    extractions: [],
    failRecord: false,
    events: [],
    errors: [],
    nextId: 1,
  });
});

describe("a successful read", () => {
  it("creates a job, reads the PDF, and records one extraction", async () => {
    const outcome = await run();
    expect(outcome).toMatchObject({ kind: "completed", status: "SUCCEEDED", documentType: "W2" });
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({ status: "SUCCEEDED", attempts: 1, processingVersion: PROCESSING_VERSION, provider: "pdf-text-layer", requestedBy: USER });
    expect(state.extractions).toHaveLength(1);
  });

  it("is idempotent: a second request returns the existing read and extracts nothing new", async () => {
    await run();
    const second = await run();
    expect(second).toMatchObject({ kind: "already_processed", status: "SUCCEEDED" });
    expect(state.extractions).toHaveLength(1);
    expect(state.jobs).toHaveLength(1);
  });

  it("reads again — as a new job and extraction — only under a new processing version", async () => {
    await run();
    state.jobs[0].idempotencyKey = state.jobs[0].idempotencyKey.replace(PROCESSING_VERSION, "document-intelligence.2025.9");
    const again = await run();
    expect(again).toMatchObject({ kind: "completed" });
    expect(state.jobs).toHaveLength(2);
    expect(state.extractions).toHaveLength(2);
  });

  it("leaves a live run alone", async () => {
    state.jobs.push({ ...(await (async () => { await run(); return state.jobs[0]; })()) });
    state.jobs.length = 1;
    Object.assign(state.jobs[0], { status: "PROCESSING", startedAt: "2026-09-14T11:59:30.000Z" });
    state.extractions.length = 0;
    expect(await run()).toMatchObject({ kind: "in_progress" });
    expect(state.extractions).toHaveLength(0);
  });

  it("recovers a run whose lease expired, and completes it", async () => {
    await run();
    Object.assign(state.jobs[0], { status: "PROCESSING", attempts: 1, startedAt: "2026-09-14T11:00:00.000Z" });
    state.extractions.length = 0;
    const outcome = await run();
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(state.jobs[0].attempts).toBe(2);
  });
});

describe("files that must not be parsed", () => {
  it("does not read another organization's document, or one not yet verified", async () => {
    state.document = { ...state.document!, organizationId: "99999999-9999-4999-8999-999999999999" };
    expect(await run()).toEqual({ kind: "unavailable", message: "Document not found." });
    state.document = null;
    expect(await run()).toEqual({ kind: "unavailable", message: "Document not found." });
    expect(state.jobs).toEqual([]);
  });

  it("does not read a document whose storage path is outside its organization", async () => {
    state.document = { ...state.document!, storagePath: "99999999-9999-4999-8999-999999999999/x.pdf" };
    expect(await run()).toMatchObject({ kind: "unavailable" });
  });

  it("says an image needs OCR which isn't configured, and creates no job", async () => {
    state.document = { ...state.document!, mimeType: "image/png" };
    const outcome = await run();
    expect(outcome).toMatchObject({ kind: "not_configured" });
    expect(state.jobs).toEqual([]);
  });

  it("refuses bytes that are not what the document claims to be — before any parser sees them", async () => {
    const html = new Uint8Array(Buffer.from("<html><body onload=alert(1)>%PDF-1.7</body></html>"));
    const outcome = await run({ download: vi.fn(async () => ({ ok: true as const, bytes: html })), providers: [failing("throw")] });
    expect(outcome).toMatchObject({ kind: "failed", category: "FILE_VALIDATION_FAILED", canRetry: true });
  });

  it("refuses an oversized object, however it is reported", async () => {
    expect(await run({ download: vi.fn(async () => ({ ok: false as const, reason: "too_large" as const })) })).toMatchObject({ kind: "failed", category: "FILE_VALIDATION_FAILED" });
    state.jobs.length = 0;
    const huge = new Uint8Array(20 * 1024 * 1024 + 1);
    huge.set(W2_BYTES.subarray(0, 16));
    expect(await run({ download: vi.fn(async () => ({ ok: true as const, bytes: huge })) })).toMatchObject({ kind: "failed", category: "FILE_VALIDATION_FAILED" });
  });

  it("fails honestly when the stored object is gone", async () => {
    expect(await run({ download: vi.fn(async () => ({ ok: false as const, reason: "missing" as const })) })).toMatchObject({ kind: "failed", category: "DOCUMENT_UNAVAILABLE" });
  });
});

describe("providers that misbehave", () => {
  it("records a malformed response as a failure and stores nothing from it", async () => {
    expect(await run({ providers: [failing("malformed")] })).toMatchObject({ kind: "failed", category: "MALFORMED_PROVIDER_RESPONSE" });
    expect(state.extractions).toEqual([]);
  });

  it("abandons a provider that hangs", async () => {
    expect(await run({ providers: [failing("hang")], providerTimeoutMs: 50 })).toMatchObject({ kind: "failed", category: "PROVIDER_TIMEOUT" });
  });

  it("retries after a provider error, within the attempt limit, and then stops", async () => {
    expect(await run({ providers: [failing("throw")] })).toMatchObject({ kind: "failed", category: "PROVIDER_ERROR", canRetry: true });
    expect(await run()).toMatchObject({ kind: "completed" });
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0].attempts).toBe(2);

    state.jobs.length = 0;
    state.extractions.length = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await run({ providers: [failing("throw")] })).toMatchObject({ kind: "failed", canRetry: attempt < 3 });
    }
    expect(await run()).toMatchObject({ kind: "attempts_exhausted" });
    expect(state.extractions).toEqual([]);
  });

  it("fails the job when recording the result fails, rather than leaving it running", async () => {
    state.failRecord = true;
    expect(await run()).toMatchObject({ kind: "failed", category: "INTERNAL_ERROR" });
    expect(state.jobs[0].status).toBe("FAILED");
  });
});

describe("observability", () => {
  it("records ids, statuses, durations and the document type — never text, values, names or paths", async () => {
    await run();
    await run({ providers: [failing("throw")], download: vi.fn(async () => ({ ok: true as const, bytes: W2_BYTES })) });
    const names = state.events.map((event) => event.name);
    expect(names).toEqual(expect.arrayContaining(["documents.processing_started", "documents.processing_completed"]));
    const completed = state.events.find((event) => event.name === "documents.processing_completed")!;
    expect(completed.context).toMatchObject({ scope: "documents", detail: { documentType: "W2", status: "SUCCEEDED", provider: "pdf-text-layer" } });
    const serialized = JSON.stringify([state.events, state.errors]);
    expect(serialized).not.toMatch(/85,000|8500000|123-45-6789|Example Test Employer|Wage and Tax Statement|secret-path|\.pdf/);
  });
});
