import { describe, expect, it } from "vitest";
import { runPreparationCalculation } from "./calculation";
import { assessCompleteness } from "./completeness";
import { buildPreparationPackage, readableFilingStatus, type BuildPackageInput } from "./preparation-package";
import { buildSnapshot } from "./snapshot";
import type { PreparationCase, PreparationDependent, TaxFact, TaxFactKey } from "./types";

/**
 * The preparation package.
 *
 * What a person — or later a professional — reads. Two kinds of property:
 * that it agrees with the data it was built from, and that it never claims
 * to be something it is not. Countorra does not file, does not guarantee, and
 * does not know that anything is final.
 */

const CASE: PreparationCase = {
  id: "case-1",
  organizationId: "org-1",
  taxYear: 2026,
  status: "COLLECTING",
  filingStatus: "single",
  taxpayer: {
    legalFirstName: "Dana",
    legalMiddleName: null,
    legalLastName: "Okafor",
    dateOfBirth: "1985-04-12",
    taxIdentifierType: "ssn",
    taxIdentifierOnFile: true,
    primaryStateRegion: "CA",
    additionalStateRegions: [],
    spouseFirstName: null,
    spouseLastName: null,
    spouseDateOfBirth: null,
    spouseTaxIdentifierOnFile: false,
    spouseItemizesDeductions: null,
  },
  currentVersion: 1,
  createdBy: "user-1",
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  completedAt: null,
};

let counter = 0;
function fact(key: TaxFactKey, amountMinor: number, overrides: Partial<TaxFact> = {}): TaxFact {
  counter += 1;
  return {
    id: `fact-${counter}`,
    organizationId: "org-1",
    caseId: "case-1",
    version: 1,
    key,
    amountMinor,
    currency: "USD",
    textValue: null,
    source: "USER_ENTERED",
    state: "CONFIRMED",
    evidenceDocumentId: null,
    evidenceNote: null,
    createdAt: "2026-02-01T00:00:00.000Z",
    createdBy: "user-1",
    ...overrides,
  };
}

function build(options: { preparationCase?: PreparationCase; facts?: TaxFact[]; dependents?: PreparationDependent[]; calculate?: boolean } = {}) {
  const preparationCase = options.preparationCase ?? CASE;
  const facts = options.facts ?? [fact("W2_WAGES", 8_500_000, { evidenceDocumentId: "doc-1" }), fact("W2_FEDERAL_WITHHOLDING", 900_000, { evidenceDocumentId: "doc-1" })];
  const dependents = options.dependents ?? [];

  const completeness = assessCompleteness({
    taxYear: preparationCase.taxYear,
    filingStatus: preparationCase.filingStatus,
    taxpayer: preparationCase.taxpayer,
    dependents,
    facts,
    countryCode: "US",
    entityType: "freelancer",
    declaredIncomeKinds: [],
  });

  let calculation: BuildPackageInput["calculation"] = null;
  let blockedReason: string | null = null;
  let snapshot: BuildPackageInput["snapshot"] = null;

  if (options.calculate !== false && preparationCase.filingStatus) {
    snapshot = buildSnapshot({
      organizationId: "org-1",
      caseId: preparationCase.id,
      version: preparationCase.currentVersion,
      taxYear: preparationCase.taxYear,
      filingStatus: preparationCase.filingStatus,
      taxpayer: preparationCase.taxpayer,
      dependents,
      facts,
      jurisdictions: completeness.jurisdictions,
      createdBy: "user-1",
      createdAt: "2026-03-01T00:00:00.000Z",
    });
    const outcome = runPreparationCalculation({ snapshot, currency: "USD", calculatedAt: "2026-03-01T00:00:00.000Z", blockers: completeness.blockers });
    if (outcome.ran) calculation = outcome.calculation;
    else blockedReason = outcome.message;
  }

  return buildPreparationPackage({ preparationCase, facts, dependents, completeness, snapshot, calculation, blockedReason, currency: "USD" });
}

describe("what the package claims about itself", () => {
  it("says plainly that Countorra does not file", () => {
    expect(build().disclaimer).toMatch(/does not file tax returns/i);
  });

  it("makes none of the claims this product must never make", () => {
    const text = JSON.stringify(build()).toLowerCase();
    for (const forbidden of ["guarantee", "maximum refund", "your cpa", "files your taxes", "e-file", "submitted to the irs", "ready to file"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("never describes a result as final", () => {
    const pkg = build();
    const statuses = [pkg.status, pkg.calculation?.federal.status, ...(pkg.calculation?.states.map((state) => state.status) ?? [])];
    expect(statuses).not.toContain("FINAL");
  });

  it("states that credits are not modelled rather than leaving them out", () => {
    const pkg = build();
    expect(pkg.credits.modelled).toBe(false);
    expect(pkg.credits.note).toMatch(/before credits/i);
  });
});

describe("what the package never contains", () => {
  it("holds no tax identifier, only that one is on file", () => {
    const pkg = build();
    expect(pkg.taxpayer.taxIdentifierOnFile).toBe(true);
    expect(Object.keys(pkg.taxpayer)).not.toContain("ssn");
    expect(JSON.stringify(pkg)).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
  });

  it("gives progress as concrete counts, never a percentage", () => {
    // "87% complete" is a number nobody can check and nobody can act on.
    for (const section of build().progress) {
      expect(section.detail, section.key).not.toMatch(/%/);
    }
  });
});

describe("agreement with the data", () => {
  it("totals income from confirmed facts only", () => {
    const pkg = build({
      facts: [fact("W2_WAGES", 5_000_000), fact("W2_WAGES", 3_500_000), fact("W2_WAGES", 99_000_000, { state: "PROPOSED", source: "AI_PROPOSED" })],
    });
    const wages = pkg.income.find((line) => line.key === "W2_WAGES");
    expect(wages?.amountMinor).toBe(8_500_000);
    expect(wages?.entryCount).toBe(2);
  });

  it("files withholding under payments, not income", () => {
    const pkg = build();
    expect(pkg.payments.map((line) => line.key)).toContain("W2_FEDERAL_WITHHOLDING");
    expect(pkg.income.map((line) => line.key)).not.toContain("W2_FEDERAL_WITHHOLDING");
  });

  it("marks uncalculated income as uncalculated on its line", () => {
    const pkg = build({ facts: [fact("W2_WAGES", 8_500_000), fact("RENTAL_INCOME", 1_200_000)] });
    expect(pkg.income.find((line) => line.key === "RENTAL_INCOME")?.calculated).toBe(false);
    expect(pkg.income.find((line) => line.key === "W2_WAGES")?.calculated).toBe(true);
  });

  it("counts the evidence behind the figures", () => {
    const pkg = build({ facts: [fact("W2_WAGES", 8_500_000, { evidenceDocumentId: "doc-1" }), fact("INTEREST_INCOME", 5_000)] });
    expect(pkg.documents).toEqual({ linkedCount: 1, factsWithEvidence: 1, factsWithoutEvidence: 1 });
  });

  it("carries the calculation's figures unchanged", () => {
    const pkg = build();
    expect(pkg.calculation?.federal.totalTaxMinor).toBeGreaterThan(0);
    expect(pkg.lastCalculatedAt).toBe("2026-03-01T00:00:00.000Z");
  });

  it("shows the refund only because withholding was entered", () => {
    expect(build().calculation?.federalRefund.status).not.toBe("REFUND_STATUS_INCOMPLETE");
    expect(build({ facts: [fact("W2_WAGES", 8_500_000)] }).calculation?.federalRefund.status).toBe("REFUND_STATUS_INCOMPLETE");
  });
});

describe("a blocked case", () => {
  const blockedCase = { ...CASE, filingStatus: null };

  it("has no calculation and says why", () => {
    const pkg = build({ preparationCase: blockedCase });
    expect(pkg.calculation).toBeNull();
    expect(pkg.blockers.map((issue) => issue.id)).toContain("FILING_STATUS_MISSING");
  });

  it("shows the calculation section as blocked, with a count", () => {
    const section = build({ preparationCase: blockedCase }).progress.find((entry) => entry.key === "CALCULATION");
    expect(section?.state).toBe("BLOCKED");
    expect(section?.detail).toMatch(/Blocked by \d/);
  });

  it("refuses at the gate when only proposed values exist", () => {
    const pkg = build({ facts: [fact("W2_WAGES", 8_500_000, { state: "PROPOSED", source: "AI_PROPOSED" })] });
    expect(pkg.calculation).toBeNull();
    expect(pkg.blockedReason).toMatch(/blocked/i);
  });
});

describe("progress", () => {
  it("covers every section, once", () => {
    const keys = build().progress.map((section) => section.key);
    expect(keys).toEqual(["TAXPAYER", "FILING_STATUS", "DEPENDENTS", "INCOME", "DOCUMENTS", "DEDUCTIONS", "STATE", "CALCULATION"]);
  });

  it("counts suggestions awaiting review", () => {
    const pkg = build({ facts: [fact("W2_WAGES", 8_500_000), fact("INTEREST_INCOME", 5_000, { state: "PROPOSED" })] });
    expect(pkg.progress.find((section) => section.key === "INCOME")?.detail).toBe("1 confirmed, 1 awaiting review");
  });

  it("says the standard deduction applies when no deductions were entered", () => {
    expect(build().progress.find((section) => section.key === "DEDUCTIONS")?.detail).toMatch(/Standard deduction/);
  });

  it("does not pretend an entered itemized figure was applied", () => {
    const pkg = build({ facts: [fact("W2_WAGES", 8_500_000), fact("MORTGAGE_INTEREST", 1_500_000)] });
    expect(pkg.progress.find((section) => section.key === "DEDUCTIONS")?.detail).toMatch(/not applied/);
  });
});

describe("readable filing status", () => {
  it("names every status", () => {
    expect(readableFilingStatus("married_filing_jointly")).toBe("Married filing jointly");
    expect(readableFilingStatus("head_of_household")).toBe("Head of household");
  });
});
