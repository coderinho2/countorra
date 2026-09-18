import { describe, expect, it } from "vitest";
import { validatePreparation } from "./validation";
import type { TaxFact, TaxpayerProfile } from "./types";

/**
 * S (Tax preparation half): two different figures for the same item from the
 * same document are a CONFLICT that nobody resolves automatically.
 */

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

let n = 0;
function fact(overrides: Partial<TaxFact> = {}): TaxFact {
  n += 1;
  return {
    id: `fact-${n}`,
    organizationId: "org",
    caseId: "case",
    version: 1,
    key: "W2_WAGES",
    amountMinor: 8_500_000,
    currency: "USD",
    textValue: null,
    source: "DOCUMENT",
    state: "CONFIRMED",
    evidenceDocumentId: "doc-1",
    evidenceNote: null,
    createdAt: "2026-09-14T00:00:00Z",
    createdBy: "user",
    ...overrides,
  };
}

const issues = (facts: TaxFact[]) => validatePreparation({ taxYear: 2026, filingStatus: "single", taxpayer: TAXPAYER, dependents: [], facts }).filter((issue) => issue.id === "DOCUMENT_FIGURES_DISAGREE");

describe("figures from the same document that disagree", () => {
  it("are a conflict, naming the item", () => {
    const found = issues([fact(), fact({ amountMinor: 8_350_000, state: "PROPOSED", createdBy: null })]);
    expect(found).toEqual([expect.objectContaining({ category: "CONFLICT", affects: "W2_WAGES", blocking: false })]);
    expect(found[0].resolution).toMatch(/doesn't choose between them/);
  });

  it("are not a conflict when they agree, or once the wrong one is rejected", () => {
    expect(issues([fact(), fact()])).toEqual([]);
    expect(issues([fact(), fact({ amountMinor: 8_350_000, state: "REJECTED" })])).toEqual([]);
  });

  it("are not a conflict when they come from different documents — two W-2s from two jobs", () => {
    expect(issues([fact(), fact({ amountMinor: 1_200_000, evidenceDocumentId: "doc-2" })])).toEqual([]);
  });

  it("do not include figures entered with no document", () => {
    expect(issues([fact({ evidenceDocumentId: null }), fact({ evidenceDocumentId: null, amountMinor: 1 })])).toEqual([]);
  });
});
