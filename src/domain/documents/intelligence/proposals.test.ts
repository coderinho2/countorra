import { describe, expect, it } from "vitest";
import { detectCrossDocumentConflicts, planFactProposals, willPropose, type ExistingFact, type ProposalPlanInput, type StoredField } from "./proposals";

/** S, T, U, V: proposals, conflicts, and figures that already exist. */

const DOC = "doc-w2";

function field(overrides: Partial<StoredField> = {}): StoredField {
  return {
    id: "field-box1",
    extractionId: "ext-1",
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
  };
}

function fact(overrides: Partial<ExistingFact> = {}): ExistingFact {
  return { id: "fact-1", key: "W2_WAGES", amountMinor: 8_500_000, currency: "USD", state: "CONFIRMED", source: "USER_ENTERED", evidenceDocumentId: null, evidenceExtractionFieldId: null, ...overrides };
}

function input(overrides: Partial<ProposalPlanInput> = {}): ProposalPlanInput {
  return {
    extraction: { id: "ext-1", documentId: DOC, documentType: "W2", status: "SUCCEEDED", classificationConfidence: "HIGH", taxYear: 2026 },
    fields: [field()],
    preparation: { caseId: "case-1", taxYear: 2026 },
    workspaceCurrency: "USD",
    currentFacts: [],
    ...overrides,
  };
}

const only = (plan: ReturnType<typeof planFactProposals>) => plan.items[0];

describe("what can be proposed at all", () => {
  it("proposes a readable, mapped figure into the open case for the printed year", () => {
    const plan = planFactProposals(input());
    expect(plan.blocked).toBeNull();
    expect(only(plan)).toMatchObject({ factKey: "W2_WAGES", amountMinor: 8_500_000, currency: "USD", relation: "PROPOSE" });
    expect(willPropose(only(plan).relation)).toBe(true);
  });

  it("proposes nothing when no tax year is printed — no year is assumed", () => {
    const plan = planFactProposals(input({ extraction: { ...input().extraction, taxYear: null } }));
    expect(plan.blocked).toMatch(/No tax year is printed/);
    expect(plan.items).toEqual([]);
  });

  it("proposes nothing when no preparation is open for that year", () => {
    expect(planFactProposals(input({ preparation: null })).blocked).toMatch(/No tax preparation is open for 2026/);
  });

  it("proposes nothing when the document type still needs review", () => {
    expect(planFactProposals(input({ extraction: { ...input().extraction, classificationConfidence: "LOW" } })).blocked).toMatch(/type needs review/);
  });

  it("proposes nothing from an unsupported reading", () => {
    expect(planFactProposals(input({ extraction: { ...input().extraction, status: "UNSUPPORTED" } })).blocked).toMatch(/Nothing was read/);
  });

  it("proposes nothing from a document with no mapped fields — a 1099-NEC's gross compensation is not net profit", () => {
    const plan = planFactProposals(input({ extraction: { ...input().extraction, documentType: "FORM_1099_NEC" }, fields: [field({ schemaId: "1099nec.2026.1", fieldKey: "box1_nonemployee_compensation" })] }));
    expect(plan.blocked).toMatch(/Nothing on this kind of document maps/);
  });
});

describe("field by field", () => {
  it.each(["UNREADABLE", "MISSING", "CONFLICT"] as const)("never proposes a %s field", (reviewState) => {
    expect(only(planFactProposals(input({ fields: [field({ reviewState, amountMinor: null, normalizedDecimal: null })] }))).relation).toBe("NOT_PROPOSABLE");
  });

  it("proposes a low-confidence value — a person still reviews it — but never confirms anything", () => {
    expect(only(planFactProposals(input({ fields: [field({ reviewState: "LOW_CONFIDENCE" })] }))).relation).toBe("PROPOSE");
  });

  it("does not convert a currency", () => {
    const item = only(planFactProposals(input({ fields: [field({ currency: "EUR" })] })));
    expect(item.relation).toBe("NOT_PROPOSABLE");
    expect(item.reason).toMatch(/Nothing is converted/);
  });

  it("does not propose an amount with no currency", () => {
    expect(only(planFactProposals(input({ fields: [field({ currency: null, amountMinor: null })] }))).relation).toBe("NOT_PROPOSABLE");
  });

  it("does not propose a negative amount for a fact that can't be negative", () => {
    expect(only(planFactProposals(input({ fields: [field({ amountMinor: -100, normalizedDecimal: "-1.00" })] }))).relation).toBe("NOT_PROPOSABLE");
  });
});

describe("existing figures are never overwritten", () => {
  it("does not propose the same field twice", () => {
    const plan = planFactProposals(input({ currentFacts: [fact({ id: "p1", state: "PROPOSED", source: "DOCUMENT", evidenceDocumentId: DOC, evidenceExtractionFieldId: "field-box1" })] }));
    expect(only(plan)).toMatchObject({ relation: "ALREADY_PROPOSED", relatedFactIds: ["p1"] });
  });

  it("does not duplicate a confirmed figure from the same document with the same amount", () => {
    const plan = planFactProposals(input({ currentFacts: [fact({ id: "c1", source: "DOCUMENT", evidenceDocumentId: DOC })] }));
    expect(only(plan)).toMatchObject({ relation: "MATCHES_EXISTING", relatedFactIds: ["c1"] });
  });

  it("surfaces a conflict — and keeps both — when a confirmed figure from the same document differs", () => {
    const plan = planFactProposals(input({ currentFacts: [fact({ id: "c1", amountMinor: 8_350_000, source: "USER_ENTERED", evidenceDocumentId: DOC })] }));
    expect(only(plan)).toMatchObject({ relation: "PROPOSE_CONFLICT", relatedFactIds: ["c1"] });
    expect(only(plan).reason).toMatch(/neither is chosen/);
  });

  it("treats a confirmed figure entered without a document, with the same amount, as the same figure", () => {
    expect(only(planFactProposals(input({ currentFacts: [fact({ id: "manual" })] })))).toMatchObject({ relation: "MATCHES_EXISTING", relatedFactIds: ["manual"] });
  });

  it("proposes alongside a different figure entered without a document — two jobs are normal — and says so", () => {
    const item = only(planFactProposals(input({ currentFacts: [fact({ id: "other-job", amountMinor: 1_200_000 })] })));
    expect(item).toMatchObject({ relation: "PROPOSE_ALONGSIDE", relatedFactIds: ["other-job"] });
  });

  it("ignores rejected figures", () => {
    expect(only(planFactProposals(input({ currentFacts: [fact({ state: "REJECTED", evidenceDocumentId: DOC })] }))).relation).toBe("PROPOSE");
  });
});

describe("conflicts between documents", () => {
  const w2 = { documentId: "w2", documentType: "W2" as const, taxYear: 2026, fields: [{ fieldKey: "box1_wages", normalizedDecimal: "85000.00", reviewState: "MEDIUM_CONFIDENCE" as const }] };
  const stub = (payDate: string, ytd: string) => ({
    documentId: `stub-${payDate}`,
    documentType: "PAY_STUB" as const,
    taxYear: null,
    fields: [
      { fieldKey: "pay_date", normalizedDecimal: null, reviewState: "MEDIUM_CONFIDENCE" as const, normalizedDate: payDate },
      { fieldKey: "gross_pay_ytd", normalizedDecimal: ytd, reviewState: "LOW_CONFIDENCE" as const },
    ],
  });

  it("surfaces a W-2 that disagrees with the December pay stub, and chooses neither", () => {
    const conflicts = detectCrossDocumentConflicts([w2, stub("2026-12-31", "83500.00")]);
    expect(conflicts).toEqual([expect.objectContaining({ kind: "W2_WAGES_VS_PAY_STUB_YEAR_TO_DATE", documentIds: ["w2", "stub-2026-12-31"], values: ["85000.00", "83500.00"] })]);
    expect(conflicts[0].message).toMatch(/neither figure is chosen/);
  });

  it("does not compare against a mid-year pay stub, or one that agrees", () => {
    expect(detectCrossDocumentConflicts([w2, stub("2026-06-30", "42500.00")])).toEqual([]);
    expect(detectCrossDocumentConflicts([w2, stub("2026-12-31", "85000.00")])).toEqual([]);
  });

  it("flags two documents of the same type and year with identical figures as a possible duplicate", () => {
    const fields = [
      { fieldKey: "box1_wages", normalizedDecimal: "85000.00", reviewState: "MEDIUM_CONFIDENCE" as const },
      { fieldKey: "box2_federal_withholding", normalizedDecimal: "11000.00", reviewState: "MEDIUM_CONFIDENCE" as const },
    ];
    const conflicts = detectCrossDocumentConflicts([
      { documentId: "a", documentType: "W2", taxYear: 2026, fields },
      { documentId: "b", documentType: "W2", taxYear: 2026, fields },
    ]);
    expect(conflicts.map((conflict) => conflict.kind)).toEqual(["POSSIBLE_DUPLICATE_DOCUMENT"]);
  });
});
