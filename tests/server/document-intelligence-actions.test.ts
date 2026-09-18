import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The document intelligence Server Actions.
 *
 * AB: rate limiting and authorization come before any work.  T, U: a proposal
 * is PROPOSED, attributed to no one, carries the extracted amount and its
 * provenance, and never touches an existing figure.  P: no currency is
 * converted.  W: another organization's extraction is refused.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const DOC = "22222222-2222-4222-8222-222222222222";
const EXTRACTION = "55555555-5555-4555-8555-555555555555";
const CASE = "66666666-6666-4666-8666-666666666666";

const state = vi.hoisted(() => ({
  role: "owner",
  rateLimited: false,
  processCalls: 0,
  processOutcome: { kind: "completed", jobId: "job-1", extractionId: "ext-1", status: "SUCCEEDED", documentType: "W2", durationMs: 40 } as Record<string, unknown>,
  audits: [] as { action: string; metadata?: Record<string, unknown> }[],
  extraction: null as Record<string, unknown> | null,
  document: null as Record<string, unknown> | null,
  fields: [] as Record<string, unknown>[],
  currency: "USD",
  liveCase: null as Record<string, unknown> | null,
  facts: [] as Record<string, unknown>[],
  recorded: [] as Record<string, unknown>[],
  caseUpdates: [] as Record<string, unknown>[],
  uniqueViolationOnce: false,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/server/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("@/server/auth/session", () => ({ requireOrgMembership: async () => ({ user: { id: USER }, membership: { role: state.role } }) }));
vi.mock("@/server/security/rate-limit", () => ({
  enforceRateLimit: async () => (state.rateLimited ? { allowed: false, message: "Too many requests. Please wait a moment and try again." } : { allowed: true }),
}));
vi.mock("@/lib/observability", () => ({ reportError: () => {}, reportEvent: () => {} }));
vi.mock("@/domain/audit/audit-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/audit/audit-log")>()),
  recordAuditEvent: async (_client: unknown, event: { action: string; metadata?: Record<string, unknown> }) => void state.audits.push(event),
}));
vi.mock("@/server/documents/processing", () => ({
  processDocument: async () => {
    state.processCalls += 1;
    return state.processOutcome;
  },
}));
vi.mock("@/server/storage/documents", () => ({ downloadDocumentBytes: async () => ({ ok: false, reason: "missing" }) }));
vi.mock("@/server/db/repositories/documents", () => ({ getVisibleDocument: async () => state.document }));
vi.mock("@/server/db/repositories/document-intelligence", () => ({
  getExtraction: async () => state.extraction,
  listFieldsForExtraction: async () => state.fields,
}));
vi.mock("@/server/db/repositories/organizations", () => ({ getOrganization: async () => ({ id: ORG, baseCurrency: state.currency, country: "US" }) }));
vi.mock("@/server/db/repositories/tax-preparation", () => ({
  findLivePreparationCase: async () => state.liveCase,
  listCurrentFacts: async () => state.facts,
  recordFact: async (_client: unknown, input: Record<string, unknown>) => {
    if (state.uniqueViolationOnce) {
      state.uniqueViolationOnce = false;
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    }
    state.recorded.push(input);
    return { id: `fact-${state.recorded.length}`, ...input };
  },
  updatePreparationCase: async (_client: unknown, caseId: string, patch: Record<string, unknown>) => void state.caseUpdates.push({ caseId, ...patch }),
}));

const { processDocumentAction, proposeDocumentFactsAction } = await import("@/server/documents/intelligence-actions");

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

const wagesField = (overrides: Record<string, unknown> = {}) => ({
  id: "77777777-7777-4777-8777-777777777777",
  extractionId: EXTRACTION,
  documentId: DOC,
  schemaId: "w2.2026.1",
  fieldKey: "box1_wages",
  label: "Wages, tips, other compensation",
  box: "1",
  pageNumber: 1,
  amountMinor: 8_500_000,
  currency: "USD",
  normalizedDecimal: "85000.00",
  reviewState: "MEDIUM_CONFIDENCE",
  ...overrides,
});

beforeEach(() => {
  Object.assign(state, {
    role: "owner",
    rateLimited: false,
    processCalls: 0,
    processOutcome: { kind: "completed", jobId: "job-1", extractionId: "ext-1", status: "SUCCEEDED", documentType: "W2", durationMs: 40 },
    audits: [],
    extraction: { id: EXTRACTION, organizationId: ORG, documentId: DOC, version: 1, status: "SUCCEEDED", documentType: "W2", classificationConfidence: "HIGH", taxYear: 2026 },
    document: { id: DOC, organizationId: ORG, mimeType: "application/pdf" },
    fields: [wagesField()],
    currency: "USD",
    liveCase: { id: CASE, organizationId: ORG, taxYear: 2026, status: "CALCULATED", currentVersion: 4 },
    facts: [],
    recorded: [],
    caseUpdates: [],
    uniqueViolationOnce: false,
  });
});

describe("reading a document", () => {
  it("authorizes, then reads, then audits ids and statuses only", async () => {
    const result = await processDocumentAction({}, form({ organizationId: ORG, documentId: DOC }));
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/nothing is used until you confirm it/);
    expect(state.processCalls).toBe(1);
    expect(state.audits[0]).toMatchObject({ action: "document.processing_completed", metadata: { jobId: "job-1", status: "SUCCEEDED", documentType: "W2" } });
  });

  it("refuses a viewer before any work", async () => {
    state.role = "viewer";
    expect((await processDocumentAction({}, form({ organizationId: ORG, documentId: DOC }))).error).toMatch(/permission/);
    expect(state.processCalls).toBe(0);
  });

  it("refuses repeated processing once rate limited, before any work", async () => {
    state.rateLimited = true;
    expect((await processDocumentAction({}, form({ organizationId: ORG, documentId: DOC }))).error).toMatch(/Too many requests/);
    expect(state.processCalls).toBe(0);
  });

  it("refuses malformed ids, and any client-supplied type, confidence or value is ignored", async () => {
    expect((await processDocumentAction({}, form({ organizationId: ORG, documentId: "../../etc" }))).error).toBe("That document can't be read.");
    await processDocumentAction({}, form({ organizationId: ORG, documentId: DOC, documentType: "W2", confidence: "HIGH", amount: "0" }));
    expect(state.processCalls).toBe(1);
  });

  it("tells the truth about each outcome", async () => {
    state.processOutcome = { kind: "not_configured", message: "Reading photos and scanned images needs an OCR provider, and none is configured for this deployment." };
    expect((await processDocumentAction({}, form({ organizationId: ORG, documentId: DOC }))).error).toMatch(/none is configured/);
    state.processOutcome = { kind: "failed", jobId: "j", category: "PROVIDER_TIMEOUT", message: "Reading this file took too long and was stopped.", canRetry: true };
    expect((await processDocumentAction({}, form({ organizationId: ORG, documentId: DOC }))).error).toBe("Reading this file took too long and was stopped. You can try again.");
    expect(state.audits.at(-1)).toMatchObject({ action: "document.processing_failed", metadata: { category: "PROVIDER_TIMEOUT" } });
  });
});

describe("proposing figures to Tax preparation", () => {
  const propose = () => proposeDocumentFactsAction({}, form({ organizationId: ORG, extractionId: EXTRACTION }));

  it("adds a PROPOSED DOCUMENT figure with the extracted amount, its provenance, and no author", async () => {
    const result = await propose();
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/as suggestions\. Nothing is used until you confirm it there\./);
    expect(state.recorded).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        caseId: CASE,
        version: 4,
        key: "W2_WAGES",
        amountMinor: 8_500_000,
        currency: "USD",
        source: "DOCUMENT",
        state: "PROPOSED",
        evidenceDocumentId: DOC,
        evidenceExtractionFieldId: "77777777-7777-4777-8777-777777777777",
        createdBy: null,
      }),
    ]);
    expect(state.caseUpdates).toEqual([{ caseId: CASE, status: "COLLECTING" }]);
    expect(state.audits[0]).toMatchObject({ action: "document.facts_proposed", metadata: { keys: ["W2_WAGES"], count: 1 } });
    expect(JSON.stringify(state.audits)).not.toMatch(/8500000|85000/);
  });

  it("never confirms anything, whatever the extraction's confidence", async () => {
    state.fields = [wagesField({ reviewState: "HIGH_CONFIDENCE" })];
    await propose();
    expect(state.recorded.every((fact) => fact.state === "PROPOSED")).toBe(true);
  });

  it("does not overwrite a confirmed figure: a conflicting one is proposed alongside, and the confirmed row is untouched", async () => {
    state.facts = [{ id: "confirmed-1", key: "W2_WAGES", amountMinor: 8_350_000, currency: "USD", state: "CONFIRMED", source: "USER_ENTERED", evidenceDocumentId: DOC, evidenceExtractionFieldId: null }];
    await propose();
    expect(state.recorded).toHaveLength(1);
    expect(state.recorded[0]).toMatchObject({ state: "PROPOSED", amountMinor: 8_500_000 });
    expect(state.facts[0]).toMatchObject({ state: "CONFIRMED", amountMinor: 8_350_000 });
  });

  it("does not duplicate a figure already recorded from this document", async () => {
    state.facts = [{ id: "c1", key: "W2_WAGES", amountMinor: 8_500_000, currency: "USD", state: "CONFIRMED", source: "DOCUMENT", evidenceDocumentId: DOC, evidenceExtractionFieldId: null }];
    const result = await propose();
    expect(result.message).toMatch(/Nothing new to propose/);
    expect(state.recorded).toEqual([]);
  });

  it("writes nothing when the document prints no tax year", async () => {
    state.extraction = { ...state.extraction!, taxYear: null };
    expect((await propose()).error).toMatch(/No tax year is printed/);
    expect(state.recorded).toEqual([]);
  });

  it("writes nothing when the workspace currency differs — nothing is converted", async () => {
    state.currency = "EUR";
    await propose();
    expect(state.recorded).toEqual([]);
  });

  it("refuses another organization's extraction", async () => {
    state.extraction = { ...state.extraction!, organizationId: "99999999-9999-4999-8999-999999999999" };
    expect((await propose()).error).toBe("That reading isn't in this workspace.");
    expect(state.recorded).toEqual([]);
  });

  it("treats a concurrent duplicate as already proposed", async () => {
    state.uniqueViolationOnce = true;
    const result = await propose();
    expect(result.success).toBe(true);
    expect(state.recorded).toEqual([]);
  });

  it("refuses a viewer, and refuses when rate limited, before any read", async () => {
    state.role = "viewer";
    expect((await propose()).error).toMatch(/permission/);
    state.role = "owner";
    state.rateLimited = true;
    expect((await propose()).error).toMatch(/Too many requests/);
    expect(state.recorded).toEqual([]);
  });
});
