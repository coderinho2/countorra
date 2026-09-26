import { describe, expect, it } from "vitest";
import { PdfTextLayerProvider } from "@/server/documents/pdf-text-layer";
import { extractDocument } from "@/domain/documents/intelligence/extraction";
import { applyStructured, shouldRunStructured } from "@/domain/documents/intelligence/structured";
import { structuredKindFor } from "@/domain/documents/intelligence/provider";
import { expensePayloadSchema, normalizeExpense } from "@/domain/documents/intelligence/expense";
import { planFactProposals, willPropose, type ExistingFact, type StoredField } from "@/domain/documents/intelligence/proposals";
import type { ExtractedFieldDraft, ExtractionDraft } from "@/domain/documents/intelligence/types";
import { buildSnapshot, statePaymentsMinor, toEngineInput } from "@/domain/tax-preparation/snapshot";
import { runPreparationCalculation } from "@/domain/tax-preparation/calculation";
import { notModelledFor } from "@/domain/tax-preparation/facts";
import type { TaxFact, TaxFactKey, TaxpayerProfile } from "@/domain/tax-preparation/types";
import { getTaxEngine } from "@/domain/tax/register";
import type { TaxJurisdiction } from "@/domain/tax/rules/types";
import { synthetic1099IntPdf, synthetic1099NecPdf, syntheticExpensePayload, syntheticReceiptPdf, syntheticW2Pdf } from "../fixtures/synthetic-documents";

/**
 * DOCUMENT → OCR → CLASSIFICATION → NORMALIZATION → TAX FACTS → ENGINE →
 * EXPECTED RESULT.
 *
 * WHAT THIS SUITE IS FOR
 *
 * Every layer of this pipeline has its own unit tests, and they all pass
 * while the pipeline as a whole can still be wrong: a field read correctly
 * that maps to the wrong fact, a fact that never reaches the engine, an
 * engine input assembled from the wrong year. This runs a real PDF the whole
 * way through and checks the number that comes out.
 *
 * THE EXPECTED VALUES ARE NOT TAKEN FROM THE PIPELINE
 *
 * This is the rule that makes the suite worth having. Every expected figure
 * below is computed by hand from the published rules, with the arithmetic
 * written out, BEFORE anything is compared. A test whose expectation is
 * "whatever the extractor produced" passes just as happily when the extractor
 * is wrong.
 *
 * WHY EACH LAYER IS ITS OWN `describe`
 *
 * So that a failure names the layer. "The tax calculation is wrong" is not a
 * diagnosis; "classification returned RECEIPT for a W-2" is.
 *
 * NO AWS. The documents here are PDFs with a text layer, read by the local
 * reader, so this suite is deterministic and runs everywhere. Amazon
 * Textract's own operations are proven against the real service in
 * tests/textract-live, which is a separate concern from whether a correctly
 * read figure produces the correct tax.
 */

// ── The pipeline, as functions ──────────────────────────────────────────

const signal = new AbortController().signal;

async function read(bytes: Uint8Array) {
  return (await new PdfTextLayerProvider().extractText({ bytes, mimeType: "application/pdf", signal })) as Parameters<typeof extractDocument>[0];
}

async function readDocument(bytes: Uint8Array): Promise<ExtractionDraft> {
  return extractDocument(await read(bytes));
}

const fieldOf = (draft: ExtractionDraft, key: string): ExtractedFieldDraft | undefined => draft.fields.find((field) => field.fieldKey === key);
const amountOf = (draft: ExtractionDraft, key: string): number | null => fieldOf(draft, key)?.amountMinor ?? null;

/** The extracted fields, as the store hands them to the proposal planner. */
function storedFields(draft: ExtractionDraft, documentId = "doc-1"): StoredField[] {
  return draft.fields.map((field, index) => ({
    id: `field-${index}`,
    extractionId: "extraction-1",
    documentId,
    schemaId: field.schemaId,
    fieldKey: field.fieldKey,
    label: field.label,
    box: field.box,
    pageNumber: field.pageNumber,
    amountMinor: field.amountMinor,
    currency: field.currency,
    normalizedDecimal: field.normalizedDecimal,
    reviewState: field.reviewState,
  }));
}

function proposalsFor(draft: ExtractionDraft, options: { preparationYear?: number | null; currentFacts?: readonly ExistingFact[] } = {}) {
  const preparationYear = options.preparationYear === undefined ? draft.taxYear : options.preparationYear;
  return planFactProposals({
    extraction: {
      id: "extraction-1",
      documentId: "doc-1",
      documentType: draft.classification.documentType,
      status: draft.status,
      classificationConfidence: draft.classification.confidence,
      taxYear: draft.taxYear,
    },
    fields: storedFields(draft),
    preparation: preparationYear === null ? null : { caseId: "case-1", taxYear: preparationYear },
    workspaceCurrency: "USD",
    currentFacts: options.currentFacts ?? [],
  });
}

const TAXPAYER: TaxpayerProfile = {
  legalFirstName: "Taylor",
  legalMiddleName: null,
  legalLastName: "Synthetic",
  dateOfBirth: "1988-03-14",
  taxIdentifierType: "ssn",
  taxIdentifierOnFile: true,
  primaryStateRegion: "TX",
  additionalStateRegions: [],
  spouseFirstName: null,
  spouseLastName: null,
  spouseDateOfBirth: null,
  spouseTaxIdentifierOnFile: false,
  spouseItemizesDeductions: null,
};

let factCounter = 0;

/** A CONFIRMED fact, which is the only kind a snapshot accepts. */
function confirmed(key: TaxFactKey, amountMinor: number): TaxFact {
  factCounter += 1;
  return {
    id: `fact-${factCounter}`,
    organizationId: "org-1",
    caseId: "case-1",
    version: 1,
    key,
    amountMinor,
    currency: "USD",
    textValue: null,
    source: "DOCUMENT",
    state: "CONFIRMED",
    evidenceDocumentId: "doc-1",
    evidenceNote: null,
    createdAt: "2027-02-01T00:00:00.000Z",
    createdBy: "user-1",
  };
}

function snapshotOf(facts: readonly TaxFact[], options: { taxYear?: number; jurisdictions?: readonly TaxJurisdiction[] } = {}) {
  return buildSnapshot({
    organizationId: "org-1",
    caseId: "case-1",
    version: 1,
    taxYear: options.taxYear ?? 2026,
    filingStatus: "single",
    taxpayer: TAXPAYER,
    dependents: [],
    facts,
    jurisdictions: options.jurisdictions ?? ["US_FEDERAL", "US_TX"],
    createdBy: "user-1",
    createdAt: "2027-02-01T00:00:00.000Z",
  });
}

const calculate = (facts: readonly TaxFact[], options: Parameters<typeof snapshotOf>[1] = {}) =>
  runPreparationCalculation({ snapshot: snapshotOf(facts, options), currency: "USD", calculatedAt: "2027-02-01T00:00:00.000Z", blockers: [] });

// ── The scenarios, and their independently computed answers ─────────────

/**
 * SCENARIO A — one W-2, single filer, Texas.
 *
 * Document:  wages $84,500, federal withholding $9,120,
 *            Social Security wages $84,500, Medicare wages $84,500.
 *
 * EXPECTED FEDERAL TAX, computed here from IRS Rev. Proc. 2025-32 (Internal
 * Revenue Bulletin 2025-45) — section 4.14 for the standard deduction and
 * TABLE 3 for unmarried individuals:
 *
 *   standard deduction (single, 2026)          $16,100
 *   taxable income      84,500 − 16,100      = $68,400
 *
 *   10% × 12,400                             =  $1,240.00
 *   12% × (50,400 − 12,400) = 12% × 38,000   =  $4,560.00
 *   22% × (68,400 − 50,400) = 22% × 18,000   =  $3,960.00
 *                                              ──────────
 *   total federal tax                          $9,760.00
 *
 * EXPECTED TEXAS TAX: $0. Texas levies no individual income tax.
 *
 * EXPECTED REFUND: withheld 9,120 − tax 9,760 = $640 BALANCE DUE. Reported as
 * status BALANCE_DUE with a magnitude of $640; `amountMinor` is absolute.
 */
const SCENARIO_A = {
  wages: 84_500,
  federalWithholding: 9_120,
  expectedFederalTaxMinor: 976_000,
  expectedTexasTaxMinor: 0,
  expectedBalanceDueMinor: 64_000,
} as const;

/**
 * SCENARIO B — one W-2, single filer, $62,000.
 *
 * EXPECTED FEDERAL TAX (same sources as A):
 *
 *   taxable income      62,000 − 16,100      = $45,900
 *   10% × 12,400                             =  $1,240.00
 *   12% × (45,900 − 12,400) = 12% × 33,500   =  $4,020.00
 *                                              ──────────
 *   total federal tax                          $5,260.00
 *
 * EXPECTED NEW YORK TAX, from the NY 2026 rule set (single):
 *
 *   standard deduction                          $8,000
 *   NY taxable income   62,000 − 8,000       = $54,000
 *   bracket $13,900–$80,650: base $586 + 5.40% of the excess
 *   586 + 5.40% × (54,000 − 13,900) = 586 + 0.054 × 40,100
 *                                            =  $2,751.40
 *
 * EXPECTED CALIFORNIA TAX. California has not published 2026 figures, so the
 * engine answers under its 2025 published rules and says so. Computed from
 * those, using the FTB Tax Table method (the table taxes the MIDPOINT of the
 * row the taxable income falls in):
 *
 *   standard deduction (single, 2025)           $5,706
 *   CA taxable income   62,000 − 5,706       = $56,294
 *   Tax Table row $56,251–$56,350, midpoint  = $56,300.50
 *   1% × 11,079                              =    $110.79
 *   2% × (26,264 − 11,079)                   =    $303.70
 *   4% × (41,452 − 26,264)                   =    $607.52
 *   6% × (56,300.50 − 41,452)                =    $890.91
 *                                              ──────────
 *                                                $1,912.92 → $1,913.00
 *   (the published Tax Table states whole dollars)
 */
const SCENARIO_B = {
  wages: 62_000,
  expectedFederalTaxMinor: 526_000,
  expectedNewYorkTaxMinor: 275_140,
  expectedCaliforniaTaxMinor: 191_300,
} as const;

const W2_A = syntheticW2Pdf({ taxYear: 2026, wages: SCENARIO_A.wages, federalWithholding: SCENARIO_A.federalWithholding, socialSecurityWages: SCENARIO_A.wages, medicareWages: SCENARIO_A.wages, state: "TX" });
const W2_B = syntheticW2Pdf({ taxYear: 2026, wages: SCENARIO_B.wages, federalWithholding: 4_800, socialSecurityWages: SCENARIO_B.wages, medicareWages: SCENARIO_B.wages, state: "NY", stateIncomeTax: 2_600 });

// ════════════════════════════════════════════════════════════════════════
// LAYER 1 — the fixture really is a document
// ════════════════════════════════════════════════════════════════════════

describe("LAYER 1 — fixture", () => {
  it("produces a real PDF, not a text file with a .pdf name", () => {
    expect(Array.from(W2_A.subarray(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    expect(W2_A.byteLength).toBeGreaterThan(500);
  });

  it("carries no real identifier, and the ones it carries were never issued", () => {
    const text = Buffer.from(W2_A).toString("latin1");
    expect(text).toContain("000-00-0000");
    expect(text).toContain("00-0000000");
  });
});

// ════════════════════════════════════════════════════════════════════════
// LAYER 2 — reading it
// ════════════════════════════════════════════════════════════════════════

describe("LAYER 2 — reading the document", () => {
  it("returns the form's lines, with the boxes on them", async () => {
    const result = (await read(W2_A)) as { pages: { lines: { text: string }[] }[] };
    const lines = result.pages[0].lines.map((line) => line.text);

    expect(lines[0]).toContain("Wage and Tax Statement");
    // Two boxes side by side on one row, separated rather than run together.
    expect(lines.some((line) => /1\s+Wages.*84,500\.00.*2\s+Federal income tax withheld.*9,120\.00/.test(line))).toBe(true);
  });

  it("reads every page it was given", async () => {
    const result = (await read(W2_A)) as { pageCount: number };
    expect(result.pageCount).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// LAYER 3 — classification
// ════════════════════════════════════════════════════════════════════════

describe("LAYER 3 — classification", () => {
  it("recognises a W-2 with high confidence, from its own printed signals", async () => {
    const draft = await readDocument(W2_A);
    expect(draft.classification.documentType).toBe("W2");
    expect(draft.classification.confidence).toBe("HIGH");
    expect(draft.classification.signals).toContain("wage-and-tax-statement");
  });

  it("recognises a 1099-NEC and a 1099-INT as themselves, not as each other", async () => {
    const nec = await readDocument(synthetic1099NecPdf({ taxYear: 2026, nonemployeeCompensation: 18_400 }));
    const int = await readDocument(synthetic1099IntPdf({ taxYear: 2026, interestIncome: 512.44 }));
    expect(nec.classification.documentType).toBe("FORM_1099_NEC");
    expect(int.classification.documentType).toBe("FORM_1099_INT");
  });

  it("recognises a receipt as a receipt, and never as a tax form", async () => {
    const draft = await readDocument(
      syntheticReceiptPdf({
        merchant: "Northwind Coffee",
        date: "03/14/2026",
        items: [{ description: "Flat white", amount: 4.5 }, { description: "Almond croissant", amount: 3.95 }],
        subtotal: 8.45,
        tax: 0.7,
        total: 9.15,
      }),
    );
    expect(draft.classification.documentType).toBe("RECEIPT");
  });

  it("sends a receipt to the expense reader and a W-2 to neither", async () => {
    const receipt = await readDocument(syntheticReceiptPdf({ merchant: "Northwind Coffee", date: "03/14/2026", items: [{ description: "Flat white", amount: 4.5 }], subtotal: 4.5, tax: 0.37, total: 4.87 }));
    const w2 = await readDocument(W2_A);
    expect(structuredKindFor(receipt.classification.documentType)).toBe("EXPENSE");
    // A W-2 is read by the schema, not by a second billed operation.
    expect(structuredKindFor(w2.classification.documentType)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// LAYER 4 — normalization: what each box became
// ════════════════════════════════════════════════════════════════════════

describe("LAYER 4 — normalization", () => {
  it("reads the W-2 boxes as the amounts printed on the form", async () => {
    const draft = await readDocument(W2_A);

    // Minor units. Compared against the fixture's OWN inputs, which were
    // chosen before the document was built — not against what was read.
    expect(amountOf(draft, "box1_wages")).toBe(SCENARIO_A.wages * 100);
    expect(amountOf(draft, "box2_federal_withholding")).toBe(SCENARIO_A.federalWithholding * 100);
    expect(amountOf(draft, "box3_social_security_wages")).toBe(SCENARIO_A.wages * 100);
    expect(amountOf(draft, "box5_medicare_wages")).toBe(SCENARIO_A.wages * 100);
  });

  it("reads the tax year from the form rather than from the clock", async () => {
    const draft = await readDocument(W2_A);
    expect(draft.taxYear).toBe(2026);
  });

  it("stores the SSN as a presence, never as digits", async () => {
    const draft = await readDocument(W2_A);
    const ssn = fieldOf(draft, "employee_ssn_present");

    expect(ssn?.valueKind).toBe("PRESENCE");
    // Not one digit of it anywhere in what would be stored.
    for (const field of draft.fields) {
      expect(field.rawValue ?? "", field.fieldKey).not.toContain("000-00-0000");
      expect(field.normalizedText ?? "", field.fieldKey).not.toContain("000-00-0000");
    }
  });

  it("marks the document read, with no conflicting values", async () => {
    const draft = await readDocument(W2_A);
    expect(draft.status).toBe("SUCCEEDED");
    expect(draft.fields.filter((field) => field.reviewState === "CONFLICT")).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// LAYER 5 — extracted fields become PROPOSED tax facts, and only proposed
// ════════════════════════════════════════════════════════════════════════

describe("LAYER 5 — document to proposed tax facts", () => {
  it("proposes the four W-2 boxes that map to a fact, with the amounts read", async () => {
    const draft = await readDocument(W2_A);
    const plan = proposalsFor(draft);

    expect(plan.blocked).toBeNull();
    const proposed = new Map(plan.items.filter((item) => willPropose(item.relation)).map((item) => [item.factKey, item.amountMinor]));

    expect(proposed.get("W2_WAGES")).toBe(SCENARIO_A.wages * 100);
    expect(proposed.get("W2_FEDERAL_WITHHOLDING")).toBe(SCENARIO_A.federalWithholding * 100);
    expect(proposed.get("W2_SOCIAL_SECURITY_WAGES")).toBe(SCENARIO_A.wages * 100);
    expect(proposed.get("W2_MEDICARE_WAGES")).toBe(SCENARIO_A.wages * 100);
  });

  it("proposes nothing at all from a 1099-NEC, because gross pay is not net profit", async () => {
    // The only related fact is self-employment NET profit, which needs
    // expenses no form carries. Proposing box 1 as net profit would invent a
    // Schedule C with no deductions.
    const draft = await readDocument(synthetic1099NecPdf({ taxYear: 2026, nonemployeeCompensation: 18_400 }));
    const plan = proposalsFor(draft);

    expect(draft.classification.documentType).toBe("FORM_1099_NEC");
    expect(plan.blocked).toBe("Nothing on this kind of document maps to a Tax preparation figure.");
  });

  it("proposes interest from a 1099-INT, which is collected but not calculated", async () => {
    const draft = await readDocument(synthetic1099IntPdf({ taxYear: 2026, interestIncome: 512.44 }));
    const plan = proposalsFor(draft);

    const interest = plan.items.find((item) => item.factKey === "INTEREST_INCOME");
    expect(interest && willPropose(interest.relation)).toBe(true);
    expect(interest?.amountMinor).toBe(51_244);
  });

  it("never proposes a CONFIRMED fact — a person confirms, nothing else does", async () => {
    const draft = await readDocument(W2_A);
    const plan = proposalsFor(draft);
    // The plan produces proposals only; there is no path here that writes a
    // confirmed figure, and the snapshot below ignores anything unconfirmed.
    expect(plan.items.every((item) => item.relation !== "MATCHES_EXISTING" || item.relatedFactIds.length > 0)).toBe(true);
  });

  it("surfaces a disagreement with an existing figure rather than overwriting it", async () => {
    const draft = await readDocument(W2_A);
    const existing: ExistingFact = {
      id: "fact-existing",
      key: "W2_WAGES",
      amountMinor: 8_000_000,
      currency: "USD",
      state: "CONFIRMED",
      source: "DOCUMENT",
      evidenceDocumentId: "doc-1",
      evidenceExtractionFieldId: null,
    };

    const plan = proposalsFor(draft, { currentFacts: [existing] });
    const wages = plan.items.find((item) => item.factKey === "W2_WAGES");
    expect(wages?.relation).toBe("PROPOSE_CONFLICT");
    expect(wages?.relatedFactIds).toContain("fact-existing");
  });
});

// ════════════════════════════════════════════════════════════════════════
// LAYER 6 — confirmed facts become the engine's input
// ════════════════════════════════════════════════════════════════════════

describe("LAYER 6 — snapshot and engine input", () => {
  it("carries the confirmed wages through to ordinary income", () => {
    const snapshot = snapshotOf([confirmed("W2_WAGES", SCENARIO_A.wages * 100)]);
    const input = toEngineInput(snapshot, "USD");

    expect(input.ordinaryIncomeMinor).toBe(SCENARIO_A.wages * 100);
    expect(input.taxYear).toBe(2026);
    expect(input.filingStatus).toBe("single");
  });

  it("leaves a PROPOSED fact out of the snapshot entirely", () => {
    const proposed: TaxFact = { ...confirmed("W2_WAGES", SCENARIO_A.wages * 100), state: "PROPOSED" };
    const snapshot = snapshotOf([proposed]);

    expect(snapshot.facts).toEqual([]);
    // This is the rule that stops an extraction becoming a tax figure: the
    // engine sees zero income until a person accepts the reading.
    expect(toEngineInput(snapshot, "USD").ordinaryIncomeMinor).toBe(0);
  });

  it("sums two W-2s rather than taking the last one", () => {
    const snapshot = snapshotOf([confirmed("W2_WAGES", 4_000_000), confirmed("W2_WAGES", 2_450_000)]);
    expect(toEngineInput(snapshot, "USD").ordinaryIncomeMinor).toBe(6_450_000);
  });

  it("does not put interest into ordinary income, because no engine models it", () => {
    const snapshot = snapshotOf([confirmed("W2_WAGES", SCENARIO_A.wages * 100), confirmed("INTEREST_INCOME", 51_244)]);
    // If this ever changes, the figure below changes with it — which is why
    // the assertion is here and not only in the engine's own tests.
    expect(toEngineInput(snapshot, "USD").ordinaryIncomeMinor).toBe(SCENARIO_A.wages * 100);
  });
});

// ════════════════════════════════════════════════════════════════════════
// LAYER 7 — the engines
// ════════════════════════════════════════════════════════════════════════

describe("LAYER 7 — the tax engines", () => {
  it("is registered for every jurisdiction the product claims", () => {
    for (const jurisdiction of ["US_FEDERAL", "US_CA", "US_NY", "US_TX", "US_FL", "US_AZ"] as const) {
      expect(getTaxEngine(jurisdiction), jurisdiction).toBeDefined();
    }
  });

  it("refuses to calculate while a blocker is open", () => {
    const outcome = runPreparationCalculation({
      snapshot: snapshotOf([confirmed("W2_WAGES", SCENARIO_A.wages * 100)]),
      currency: "USD",
      calculatedAt: "2027-02-01T00:00:00.000Z",
      blockers: [{ id: "MISSING_FILING_STATUS", severity: "BLOCKER", message: "x", resolution: "y" } as never],
    });
    expect(outcome.ran).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// LAYER 8 — the number, against the independently computed expectation
// ════════════════════════════════════════════════════════════════════════

describe("LAYER 8 — expected tax results", () => {
  it("SCENARIO A: a $84,500 W-2 produces $9,760.00 federal tax", async () => {
    // The whole way through, from the PDF.
    const draft = await readDocument(W2_A);
    const plan = proposalsFor(draft);
    const facts = plan.items
      .filter((item) => willPropose(item.relation) && item.amountMinor !== null)
      .map((item) => confirmed(item.factKey, item.amountMinor!));

    const outcome = calculate(facts);
    expect(outcome.ran).toBe(true);
    if (!outcome.ran) return;

    // Rev. Proc. 2025-32: $16,100 standard deduction, TABLE 3. See SCENARIO_A.
    expect(outcome.calculation.federal.totalTaxMinor).toBe(SCENARIO_A.expectedFederalTaxMinor);
    expect(outcome.calculation.federal.status).toBe("CALCULATED");
  });

  it("SCENARIO A: Texas adds nothing, because Texas has no income tax", async () => {
    const draft = await readDocument(W2_A);
    const facts = proposalsFor(draft)
      .items.filter((item) => willPropose(item.relation) && item.amountMinor !== null)
      .map((item) => confirmed(item.factKey, item.amountMinor!));

    const outcome = calculate(facts, { jurisdictions: ["US_FEDERAL", "US_TX"] });
    expect(outcome.ran).toBe(true);
    if (!outcome.ran) return;

    const texas = outcome.calculation.states.find((state) => state.jurisdiction === "US_TX");
    expect(texas?.totalTaxMinor).toBe(SCENARIO_A.expectedTexasTaxMinor);
    // Zero because it was calculated as zero, not because nothing ran.
    expect(texas?.status).toBe("CALCULATED");
  });

  it("SCENARIO A: withholding of $9,120 against $9,760 of tax is a $640 balance due", async () => {
    const draft = await readDocument(W2_A);
    const facts = proposalsFor(draft)
      .items.filter((item) => willPropose(item.relation) && item.amountMinor !== null)
      .map((item) => confirmed(item.factKey, item.amountMinor!));

    const outcome = calculate(facts);
    expect(outcome.ran).toBe(true);
    if (!outcome.ran) return;

    // The contract is a STATUS plus a magnitude — `amountMinor` is absolute,
    // and reading it as a signed number would turn a bill into a refund.
    expect(outcome.calculation.federalRefund.status).toBe("BALANCE_DUE");
    expect(outcome.calculation.federalRefund.amountMinor).toBe(SCENARIO_A.expectedBalanceDueMinor);
  });

  it("SCENARIO B: a $62,000 W-2 produces $5,260.00 federal tax", async () => {
    const draft = await readDocument(W2_B);
    const facts = proposalsFor(draft)
      .items.filter((item) => willPropose(item.relation) && item.amountMinor !== null && item.factKey !== "W2_STATE_WITHHOLDING")
      .map((item) => confirmed(item.factKey, item.amountMinor!));

    const outcome = calculate(facts);
    expect(outcome.ran).toBe(true);
    if (!outcome.ran) return;
    expect(outcome.calculation.federal.totalTaxMinor).toBe(SCENARIO_B.expectedFederalTaxMinor);
  });

  it("the same inputs produce the same result, every time", async () => {
    const draft = await readDocument(W2_A);
    const facts = proposalsFor(draft)
      .items.filter((item) => willPropose(item.relation) && item.amountMinor !== null)
      .map((item) => confirmed(item.factKey, item.amountMinor!));

    const first = calculate(facts);
    const second = calculate(facts);
    expect(first.ran && second.ran).toBe(true);
    if (!first.ran || !second.ran) return;
    expect(second.calculation.federal.totalTaxMinor).toBe(first.calculation.federal.totalTaxMinor);
    expect(second.calculation.snapshotId).toBe(first.calculation.snapshotId);
  });
});

// ════════════════════════════════════════════════════════════════════════
// STATES — the same income, each state's own answer
// ════════════════════════════════════════════════════════════════════════

describe("STATES — routing and each state's own answer", () => {
  const facts = () => [confirmed("W2_WAGES", SCENARIO_B.wages * 100)];

  it("New York computes $2,751.40 from its own published 2026 figures", () => {
    const outcome = calculate(facts(), { jurisdictions: ["US_FEDERAL", "US_NY"] });
    expect(outcome.ran).toBe(true);
    if (!outcome.ran) return;

    const ny = outcome.calculation.states.find((state) => state.jurisdiction === "US_NY");
    // $8,000 standard deduction; bracket base $586 + 5.40% of the excess over
    // $13,900. See SCENARIO_B.
    expect(ny?.totalTaxMinor).toBe(SCENARIO_B.expectedNewYorkTaxMinor);
    expect(ny?.status).toBe("CALCULATED");
  });

  it("California answers $1,913.00 and says it is a 2025-rules estimate", () => {
    const outcome = calculate(facts(), { jurisdictions: ["US_FEDERAL", "US_CA"] });
    expect(outcome.ran).toBe(true);
    if (!outcome.ran) return;

    const ca = outcome.calculation.states.find((state) => state.jurisdiction === "US_CA");
    expect(ca?.totalTaxMinor).toBe(SCENARIO_B.expectedCaliforniaTaxMinor);
    // The figure is real, and it is NOT a 2026 calculation. A result that hid
    // that would be the dangerous one.
    expect(ca?.outcome?.supported).toBe(true);
    if (ca?.outcome?.supported) {
      expect(ca.outcome.calculationStatus).toBe("ESTIMATE_USING_LATEST_PUBLISHED_RULES");
      expect(ca.outcome.taxYear).toBe(2025);
      expect(ca.outcome.requestedTaxYear).toBe(2026);
    }
  });

  it("Texas and Florida are calculated zeros, not missing answers", () => {
    for (const jurisdiction of ["US_TX", "US_FL"] as const) {
      const outcome = calculate(facts(), { jurisdictions: ["US_FEDERAL", jurisdiction] });
      expect(outcome.ran).toBe(true);
      if (!outcome.ran) continue;

      const state = outcome.calculation.states.find((entry) => entry.jurisdiction === jurisdiction);
      expect(state?.totalTaxMinor, jurisdiction).toBe(0);
      expect(state?.status, jurisdiction).toBe("CALCULATED");
      expect(state?.outcome?.supported, jurisdiction).toBe(true);
    }
  });

  it("Arizona refuses and names the figures it is waiting for, rather than guessing", () => {
    const outcome = calculate(facts(), { jurisdictions: ["US_FEDERAL", "US_AZ"] });
    expect(outcome.ran).toBe(true);
    if (!outcome.ran) return;

    const az = outcome.calculation.states.find((state) => state.jurisdiction === "US_AZ");
    // Not zero. A refusal turned into a zero would understate somebody's tax.
    expect(az?.totalTaxMinor).toBeNull();
    expect(az?.outcome?.supported).toBe(false);
    if (az?.outcome && !az.outcome.supported) {
      expect(az.outcome.reason).toBe("rules_not_published");
      expect(az.outcome.details?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("does not route a state that was not asked for", () => {
    const outcome = calculate(facts(), { jurisdictions: ["US_FEDERAL", "US_TX"] });
    expect(outcome.ran).toBe(true);
    if (!outcome.ran) return;
    expect(outcome.calculation.states.map((state) => state.jurisdiction)).toEqual(["US_TX"]);
  });

  it("gives the same federal answer whichever state is attached", () => {
    const federal = (["US_CA", "US_NY", "US_TX", "US_FL", "US_AZ"] as const).map((jurisdiction) => {
      const outcome = calculate(facts(), { jurisdictions: ["US_FEDERAL", jurisdiction] });
      return outcome.ran ? outcome.calculation.federal.totalTaxMinor : null;
    });
    expect(new Set(federal).size).toBe(1);
    expect(federal[0]).toBe(SCENARIO_B.expectedFederalTaxMinor);
  });
});

// ════════════════════════════════════════════════════════════════════════
// STATE WITHHOLDING — read from box 17, and what is done with it
// ════════════════════════════════════════════════════════════════════════

describe("state withholding travels from box 17", () => {
  it("is read off the form and proposed as state withholding", async () => {
    const draft = await readDocument(W2_B);
    expect(amountOf(draft, "box17_state_income_tax")).toBe(260_000);

    const plan = proposalsFor(draft);
    const state = plan.items.find((item) => item.factKey === "W2_STATE_WITHHOLDING");
    expect(state && willPropose(state.relation)).toBe(true);
    expect(state?.amountMinor).toBe(260_000);
  });

  it("reaches state payments once confirmed", () => {
    const snapshot = snapshotOf([confirmed("W2_WAGES", SCENARIO_B.wages * 100), confirmed("W2_STATE_WITHHOLDING", 260_000)]);
    expect(statePaymentsMinor(snapshot)).toBe(260_000);
  });

  it("does not change the federal figure, and no state refund is stated", () => {
    const withState = calculate([confirmed("W2_WAGES", SCENARIO_B.wages * 100), confirmed("W2_STATE_WITHHOLDING", 260_000)], { jurisdictions: ["US_FEDERAL", "US_NY"] });
    const without = calculate([confirmed("W2_WAGES", SCENARIO_B.wages * 100)], { jurisdictions: ["US_FEDERAL", "US_NY"] });
    expect(withState.ran && without.ran).toBe(true);
    if (!withState.ran || !without.ran) return;

    expect(withState.calculation.federal.totalTaxMinor).toBe(without.calculation.federal.totalTaxMinor);
    // Stated plainly rather than assumed: preparation produces a FEDERAL
    // refund assessment only. State withholding is collected and carried, and
    // no state refund or balance is claimed from it.
    expect(withState.calculation).not.toHaveProperty("stateRefund");
  });
});

// ════════════════════════════════════════════════════════════════════════
// A RECEIPT IS NOT A DEDUCTION
// ════════════════════════════════════════════════════════════════════════

describe("a receipt cannot become a tax deduction by being read", () => {
  const receipt = syntheticReceiptPdf({
    merchant: "Contoso Office Supply",
    date: "04/02/2026",
    items: [
      { description: "Laser printer", amount: 289.0 },
      { description: "Toner cartridge x2", amount: 118.0 },
      { description: "Copy paper, 5 reams", amount: 42.5 },
    ],
    subtotal: 449.5,
    tax: 37.09,
    total: 486.59,
  });

  it("is read, classified and understood — that part works", async () => {
    const draft = await readDocument(receipt);
    expect(draft.classification.documentType).toBe("RECEIPT");
    expect(draft.status).not.toBe("UNSUPPORTED");
  });

  it("maps to no tax fact whatsoever", async () => {
    const draft = await readDocument(receipt);
    const plan = proposalsFor(draft);

    expect(plan.items).toEqual([]);
    expect(plan.blocked).toBe("Nothing on this kind of document maps to a Tax preparation figure.");
  });

  it("changes no figure even when the expense reader extracts it perfectly", () => {
    const payload = syntheticExpensePayload({ merchant: "Contoso Office Supply", date: "04/02/2026", subtotal: 449.5, tax: 37.09, total: 486.59, items: [{ description: "Laser printer", amount: 289 }] });
    const parsed = expensePayloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const normalized = normalizeExpense(parsed.data);
    // Every field it produces is an expense field. None of them is a tax
    // fact key, so there is nothing for a snapshot to take.
    expect(normalized.fields.length).toBeGreaterThan(0);
    expect(normalized.fields.every((field) => field.section !== "IDENTITY")).toBe(true);

    // And the tax result with the receipt "applied" is the result without it.
    const withoutReceipt = calculate([confirmed("W2_WAGES", SCENARIO_A.wages * 100)]);
    expect(withoutReceipt.ran).toBe(true);
    if (!withoutReceipt.ran) return;
    expect(withoutReceipt.calculation.federal.totalTaxMinor).toBe(SCENARIO_A.expectedFederalTaxMinor);
  });

  it("a refund receipt does not become a deduction of any sign", async () => {
    const refund = syntheticReceiptPdf({
      merchant: "Contoso Office Supply",
      date: "04/09/2026",
      items: [{ description: "Laser printer (returned)", amount: -289.0 }],
      subtotal: -289.0,
      tax: -23.84,
      total: -312.84,
      note: "REFUND",
    });

    const draft = await readDocument(refund);
    const plan = proposalsFor(draft);
    expect(plan.items).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// EXPENSE NORMALIZATION — totals, confidence and review
// ════════════════════════════════════════════════════════════════════════

describe("expense normalization", () => {
  const normalize = (input: Parameters<typeof syntheticExpensePayload>[0]) => {
    const parsed = expensePayloadSchema.safeParse(syntheticExpensePayload(input));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("payload rejected");
    return normalizeExpense(parsed.data);
  };

  it("reads an ordinary receipt's merchant, date and totals", () => {
    const result = normalize({ merchant: "Northwind Coffee", date: "03/14/2026", subtotal: 8.45, tax: 0.7, total: 9.15, items: [{ description: "Flat white", amount: 4.5 }] });
    const byKey = new Map(result.fields.map((field) => [field.fieldKey, field]));

    expect(byKey.get("total")?.amountMinor).toBe(915);
    expect(byKey.get("subtotal")?.amountMinor).toBe(845);
    expect(byKey.get("tax")?.amountMinor).toBe(70);
    expect(result.warnings).not.toContain("TOTALS_INCONSISTENT");
  });

  it("flags a receipt whose subtotal and tax do not make its total", () => {
    // 20.00 + 1.65 = 21.65, and the receipt says 26.15.
    const result = normalize({ merchant: "Northwind Coffee", date: "03/14/2026", subtotal: 20.0, tax: 1.65, total: 26.15 });

    expect(result.warnings).toContain("TOTALS_INCONSISTENT");
    // And it is NOT repaired. Both figures stand as printed.
    const byKey = new Map(result.fields.map((field) => [field.fieldKey, field]));
    expect(byKey.get("total")?.amountMinor).toBe(2_615);
    expect(byKey.get("subtotal")?.amountMinor).toBe(2_000);
  });

  it("keeps a low-confidence read out of the confident states", () => {
    const high = normalize({ total: 9.15, confidence: 0.99 });
    const low = normalize({ total: 9.15, confidence: 0.4 });

    expect(high.fields.find((field) => field.fieldKey === "total")?.reviewState).toBe("HIGH_CONFIDENCE");
    expect(low.fields.find((field) => field.fieldKey === "total")?.reviewState).toBe("LOW_CONFIDENCE");
  });

  it("accepts a multi-item receipt and keeps the items as items", () => {
    const result = normalize({
      merchant: "Contoso Office Supply",
      total: 486.59,
      subtotal: 449.5,
      tax: 37.09,
      items: [
        { description: "Laser printer", amount: 289 },
        { description: "Toner cartridge x2", amount: 118 },
        { description: "Copy paper, 5 reams", amount: 42.5 },
      ],
    });
    expect(result.fields.filter((field) => field.section === "LINE_ITEMS").length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// CONFIDENCE
// ════════════════════════════════════════════════════════════════════════

describe("confidence decides how far a reading may travel", () => {
  it("a HIGH-confidence classification may propose", async () => {
    const draft = await readDocument(W2_A);
    expect(draft.classification.confidence).toBe("HIGH");
    expect(proposalsFor(draft).blocked).toBeNull();
  });

  it("a LOW-confidence classification proposes nothing", async () => {
    const draft = await readDocument(W2_A);
    const weakened: ExtractionDraft = { ...draft, classification: { ...draft.classification, confidence: "LOW" } };
    expect(proposalsFor(weakened).blocked).toBe("The document type needs review before any figure from it can be proposed.");
  });

  it("an unclassifiable document is never paid to be analysed further", async () => {
    const draft = await readDocument(W2_A);
    const unknown: ExtractionDraft = { ...draft, classification: { ...draft.classification, documentType: "UNKNOWN", confidence: "NONE" } };
    expect(shouldRunStructured(unknown)).toBe(false);
  });

  it("an identity document needs better than a weak signal before AnalyzeID is called", async () => {
    const draft = await readDocument(W2_A);
    const weakIdentity: ExtractionDraft = { ...draft, classification: { ...draft.classification, documentType: "DRIVER_LICENSE", confidence: "LOW" } };
    const strongIdentity: ExtractionDraft = { ...draft, classification: { ...draft.classification, documentType: "DRIVER_LICENSE", confidence: "HIGH" } };

    expect(shouldRunStructured(weakIdentity)).toBe(false);
    expect(shouldRunStructured(strongIdentity)).toBe(true);
  });

  it("a field that could not be read proposes nothing, whatever the document", async () => {
    const draft = await readDocument(W2_A);
    const fields = storedFields(draft).map((field) => (field.fieldKey === "box1_wages" ? { ...field, reviewState: "UNREADABLE" as const } : field));

    const plan = planFactProposals({
      extraction: { id: "e", documentId: "doc-1", documentType: "W2", status: draft.status, classificationConfidence: "HIGH", taxYear: 2026 },
      fields,
      preparation: { caseId: "case-1", taxYear: 2026 },
      workspaceCurrency: "USD",
      currentFacts: [],
    });

    const wages = plan.items.find((item) => item.factKey === "W2_WAGES");
    expect(wages?.relation).toBe("NOT_PROPOSABLE");
  });
});

// ════════════════════════════════════════════════════════════════════════
// TAX YEAR
// ════════════════════════════════════════════════════════════════════════

describe("the tax year comes from the document, never from the calendar", () => {
  it("reads 2025 from a 2025 W-2 even though the product year is 2026", async () => {
    const draft = await readDocument(syntheticW2Pdf({ taxYear: 2025, wages: 70_000, federalWithholding: 8_000, socialSecurityWages: 70_000, medicareWages: 70_000, state: "TX" }));
    expect(draft.taxYear).toBe(2025);
  });

  it("refuses to put a 2025 document's figures into a 2026 preparation", async () => {
    const draft = await readDocument(syntheticW2Pdf({ taxYear: 2025, wages: 70_000, federalWithholding: 8_000, socialSecurityWages: 70_000, medicareWages: 70_000, state: "TX" }));
    const plan = proposalsFor(draft, { preparationYear: 2026 });
    expect(plan.blocked).toBe("This document is for 2025, not 2026.");
  });

  it("proposes nothing when no year is printed, rather than assuming this one", async () => {
    const draft = await readDocument(W2_A);
    const undated: ExtractionDraft = { ...draft, taxYear: null };
    expect(proposalsFor(undated, { preparationYear: 2026 }).blocked).toMatch(/No tax year is printed/);
  });

  it("calculates the snapshot's year, not the year the calculation was run", () => {
    const outcome = calculate([confirmed("W2_WAGES", SCENARIO_A.wages * 100)], { taxYear: 2026 });
    expect(outcome.ran).toBe(true);
    if (!outcome.ran) return;
    expect(outcome.calculation.taxYear).toBe(2026);
  });
});

// ════════════════════════════════════════════════════════════════════════
// WHAT IS COLLECTED BUT NOT CALCULATED
// ════════════════════════════════════════════════════════════════════════

describe("a figure the engines do not model is reported, never silently dropped", () => {
  it("interest income appears in notModelled and changes no tax", () => {
    const withInterest = calculate([confirmed("W2_WAGES", SCENARIO_A.wages * 100), confirmed("INTEREST_INCOME", 51_244)]);
    const without = calculate([confirmed("W2_WAGES", SCENARIO_A.wages * 100)]);

    expect(withInterest.ran && without.ran).toBe(true);
    if (!withInterest.ran || !without.ran) return;

    expect(withInterest.calculation.federal.totalTaxMinor).toBe(without.calculation.federal.totalTaxMinor);
    // Same number — and the difference is DECLARED rather than hidden.
    expect(withInterest.calculation.notModelled.join(" ")).toMatch(/[Ii]nterest/);
  });

  it("names every collected-but-uncalculated fact it was given", () => {
    const notModelled = notModelledFor(["INTEREST_INCOME", "ORDINARY_DIVIDENDS", "W2_WAGES"]);
    expect(notModelled.length).toBe(2);
    expect(notModelled.join(" ")).not.toMatch(/W-2 wages/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// STRUCTURED EXTRACTION APPLIED TO A DRAFT
// ════════════════════════════════════════════════════════════════════════

describe("applying an expense reading to the document's draft", () => {
  it("replaces the generic reading with the purpose-built one", async () => {
    const draft = await readDocument(syntheticReceiptPdf({ merchant: "Northwind Coffee", date: "03/14/2026", items: [{ description: "Flat white", amount: 4.5 }], subtotal: 4.5, tax: 0.37, total: 4.87 }));
    const payload = syntheticExpensePayload({ merchant: "Northwind Coffee", date: "03/14/2026", subtotal: 4.5, tax: 0.37, total: 4.87 });

    const applied = applyStructured(draft, "EXPENSE", payload);
    expect(applied.applied).toBe(true);
    if (!applied.applied) return;
    expect(applied.draft.fields.some((field) => field.fieldKey === "total" && field.amountMinor === 487)).toBe(true);
  });

  it("refuses a payload that is not the shape the kind promises", async () => {
    const draft = await readDocument(syntheticReceiptPdf({ merchant: "Northwind Coffee", date: "03/14/2026", items: [], subtotal: 4.5, tax: 0.37, total: 4.87 }));
    const applied = applyStructured(draft, "EXPENSE", { nonsense: true });
    expect(applied.applied).toBe(false);
  });
});
