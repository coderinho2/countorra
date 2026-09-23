import { describe, expect, it } from "vitest";
import { applyStructured, expenseStatus, shouldRunStructured } from "./structured";
import { structuredKindFor } from "./provider";
import type { Classification, ExtractionDraft } from "./types";

/**
 * The second stage, folded back into one extraction.
 *
 * Two properties are load-bearing: a purpose-built reading REPLACES the
 * heuristic one rather than sitting beside it, and an unusable payload leaves
 * the heuristic reading standing rather than failing the document.
 */

const classification = (over: Partial<Classification> = {}): Classification => ({
  documentType: "RECEIPT",
  confidence: "HIGH",
  method: "CONTENT_SIGNALS",
  signals: [],
  reviewRequired: false,
  reviewReason: null,
  ...over,
});

const draft = (over: Partial<ExtractionDraft> = {}): ExtractionDraft => ({
  status: "PARTIAL",
  classification: classification(),
  taxYear: null,
  fields: [
    {
      schemaId: "receipt.2026.1",
      fieldKey: "total",
      label: "Total",
      section: "TOTALS",
      box: null,
      valueKind: "MONEY",
      rawValue: "guessed by layout",
      normalizedDecimal: "99.99",
      amountMinor: 9999,
      currency: "USD",
      currencySource: "DOCUMENT_TEXT",
      normalizedDate: null,
      normalizedText: null,
      reviewState: "LOW_CONFIDENCE",
      reviewReason: null,
      providerConfidence: null,
      pageNumber: 1,
      lineIndex: 0,
      position: null,
      method: "pdf-text-layer/label-same-line",
    },
  ],
  pageCount: 1,
  textCharCount: 100,
  textTruncated: false,
  warnings: ["OCR_LOW_CONFIDENCE"],
  ...over,
});

const expensePayload = {
  summaryFields: [
    { type: "TOTAL", label: null, value: { text: "21.60", confidence: 0.99 }, currency: "USD", pageNumber: 1 },
    { type: "VENDOR_NAME", label: null, value: { text: "Northwind", confidence: 0.98 }, currency: "USD", pageNumber: 1 },
  ],
  lineItems: [],
};

describe("which operation a document earns", () => {
  it("sends receipts, invoices and bills to the expense reader", () => {
    for (const type of ["RECEIPT", "INVOICE", "BILL"]) expect(structuredKindFor(type), type).toBe("EXPENSE");
  });

  it("sends only the two documents AnalyzeID actually supports to it", () => {
    expect(structuredKindFor("DRIVER_LICENSE")).toBe("IDENTITY");
    expect(structuredKindFor("PASSPORT")).toBe("IDENTITY");
    // AnalyzeID does not read these, so nothing is sent and no confident
    // wrong reading is produced.
    expect(structuredKindFor("SSN_DOCUMENT")).toBeNull();
    expect(structuredKindFor("GOVERNMENT_ID")).toBeNull();
  });

  it("sends nothing for a type with no purpose-built operation", () => {
    for (const type of ["W2", "BANK_STATEMENT", "UNKNOWN"]) expect(structuredKindFor(type), type).toBeNull();
  });
});

describe("whether a billed call is worth making", () => {
  it("does not pay to analyse a document it could not classify", () => {
    expect(shouldRunStructured(draft({ classification: classification({ documentType: "UNKNOWN", confidence: "NONE" }) }))).toBe(false);
  });

  it("holds identity documents to a higher bar than receipts", () => {
    const low = classification({ documentType: "DRIVER_LICENSE", confidence: "LOW" });
    expect(shouldRunStructured(draft({ classification: low }))).toBe(false);
    expect(shouldRunStructured(draft({ classification: { ...low, confidence: "MEDIUM" } }))).toBe(true);
    // A receipt on the same weak evidence is still worth reading: the cost of
    // being wrong is a figure someone checks, not a document sent to an
    // identity reader.
    expect(shouldRunStructured(draft({ classification: classification({ confidence: "LOW" }) }))).toBe(true);
  });
});

describe("applying an expense reading", () => {
  it("replaces the heuristic fields entirely", () => {
    const result = applyStructured(draft(), "EXPENSE", expensePayload);
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    // The layout guess is gone, not sitting beside the better reading.
    expect(result.draft.fields.every((field) => field.method.startsWith("textract-expense"))).toBe(true);
    expect(result.draft.fields.find((field) => field.fieldKey === "total")?.normalizedDecimal).toBe("21.60");
    expect(JSON.stringify(result.draft.fields)).not.toContain("guessed by layout");
  });

  it("keeps warnings about HOW the file was read, and drops warnings about what was found", () => {
    const result = applyStructured(draft({ warnings: ["OCR_LOW_CONFIDENCE", "CONFLICTING_VALUES"] }), "EXPENSE", expensePayload);
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.draft.warnings).toContain("OCR_LOW_CONFIDENCE");
    expect(result.draft.warnings).not.toContain("CONFLICTING_VALUES");
  });

  it("leaves the first reading in place when the payload is malformed", () => {
    const result = applyStructured(draft(), "EXPENSE", { summaryFields: "not an array" });
    expect(result).toEqual({ applied: false, reason: "MALFORMED" });
  });

  it("leaves the first reading in place when the payload is empty", () => {
    expect(applyStructured(draft(), "EXPENSE", { summaryFields: [], lineItems: [] })).toEqual({ applied: false, reason: "EMPTY" });
  });
});

describe("applying an identity reading", () => {
  const identityDraft = draft({ classification: classification({ documentType: "DRIVER_LICENSE" }) });
  const identityPayload = {
    fields: [
      { type: "FIRST_NAME", value: { text: "ALEX", confidence: 0.99, normalizedValue: null } },
      { type: "DOCUMENT_NUMBER", value: { text: "Y1234567", confidence: 0.99, normalizedValue: null } },
      { type: "ID_TYPE", value: { text: "DRIVER LICENSE", confidence: 0.99, normalizedValue: null } },
    ],
  };

  it("discards everything the text stage read, not just the identity parts", () => {
    const result = applyStructured(identityDraft, "IDENTITY", identityPayload);
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    // The text stage had read a money total off the document. After an
    // identity reading nothing of it survives — there is no amount left to
    // propose anywhere.
    expect(result.draft.fields.every((field) => field.section === "IDENTITY")).toBe(true);
    expect(result.draft.fields.every((field) => field.amountMinor === null)).toBe(true);
    expect(JSON.stringify(result.draft.fields)).not.toContain("ALEX");
  });

  it("is always REVIEW_REQUIRED, however cleanly it was read", () => {
    const result = applyStructured(identityDraft, "IDENTITY", identityPayload);
    expect(result.applied && result.draft.status).toBe("REVIEW_REQUIRED");
  });

  it("clears any tax year, because an identity document has none", () => {
    const result = applyStructured(draft({ taxYear: 2026, classification: classification({ documentType: "PASSPORT" }) }), "IDENTITY", identityPayload);
    expect(result.applied && result.draft.taxYear).toBeNull();
  });
});

describe("the status an expense reading earns", () => {
  const money = (over: Partial<ExtractionDraft["fields"][number]>) => ({ ...draft().fields[0], ...over });

  it("is REVIEW_REQUIRED whenever the arithmetic disagrees, however well each number was read", () => {
    expect(expenseStatus([money({ fieldKey: "total", reviewState: "HIGH_CONFIDENCE" })], ["TOTALS_INCONSISTENT"])).toBe("REVIEW_REQUIRED");
  });

  it("is PARTIAL with no total at all", () => {
    expect(expenseStatus([money({ fieldKey: "merchant", amountMinor: null })], [])).toBe("PARTIAL");
  });

  it("is REVIEW_REQUIRED when the total itself was read poorly", () => {
    expect(expenseStatus([money({ fieldKey: "total", reviewState: "LOW_CONFIDENCE" })], [])).toBe("REVIEW_REQUIRED");
  });

  it("is PARTIAL when something else could not be read", () => {
    expect(expenseStatus([money({ fieldKey: "total", reviewState: "HIGH_CONFIDENCE" }), money({ fieldKey: "tax", reviewState: "UNREADABLE" })], [])).toBe("PARTIAL");
  });

  it("is SUCCEEDED only when the total is solid and nothing failed", () => {
    expect(expenseStatus([money({ fieldKey: "total", reviewState: "HIGH_CONFIDENCE" })], [])).toBe("SUCCEEDED");
  });
});
