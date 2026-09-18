import { describe, expect, it } from "vitest";
import { isPlausibleDate, validatePreparation, type ValidationInput } from "./validation";
import type { FactSource, FactState, PreparationDependent, TaxFact, TaxFactKey, TaxpayerProfile } from "./types";

/**
 * Deterministic validation.
 *
 * Two properties are being pinned here, and the second matters more than the
 * first:
 *
 *   IT CATCHES what a computer can see — arithmetic, shape, contradiction,
 *   duplication.
 *
 *   IT DECIDES NOTHING ELSE. No rule below concludes that someone qualifies
 *   as head of household, or that a dependent earns a credit. Those need a
 *   human, and a rule that guessed would be confidently wrong in exactly the
 *   cases where being wrong costs the most.
 */

const TAXPAYER: TaxpayerProfile = {
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
};

function fact(key: TaxFactKey, amountMinor: number | null, overrides: Partial<TaxFact> = {}): TaxFact {
  return {
    id: overrides.id ?? `fact-${key}-${amountMinor}`,
    organizationId: "org-1",
    caseId: "case-1",
    version: 1,
    key,
    amountMinor,
    currency: "USD",
    textValue: null,
    source: "USER_ENTERED" as FactSource,
    state: "CONFIRMED" as FactState,
    evidenceDocumentId: null,
    evidenceNote: null,
    createdAt: "2026-02-01T00:00:00.000Z",
    createdBy: "user-1",
    ...overrides,
  };
}

function dependent(overrides: Partial<PreparationDependent> = {}): PreparationDependent {
  return {
    id: "dep-1",
    organizationId: "org-1",
    caseId: "case-1",
    firstName: "Sam",
    lastName: "Okafor",
    relationship: "child",
    dateOfBirth: "2015-06-01",
    monthsLivedWithTaxpayer: 12,
    isStudent: false,
    isDisabled: false,
    hasTaxIdentifier: true,
    claimedByAnother: false,
    status: "VERIFIED",
    createdAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

function validate(overrides: Partial<ValidationInput> = {}) {
  return validatePreparation({
    taxYear: 2026,
    filingStatus: "single",
    taxpayer: TAXPAYER,
    dependents: [],
    facts: [fact("W2_WAGES", 8_500_000)],
    ...overrides,
  });
}

const ids = (issues: readonly { id: string }[]) => issues.map((issue) => issue.id);

describe("filing status", () => {
  it("blocks when none is chosen", () => {
    const issues = validate({ filingStatus: null });
    expect(ids(issues)).toContain("FILING_STATUS_MISSING");
    expect(issues.find((issue) => issue.id === "FILING_STATUS_MISSING")?.blocking).toBe(true);
  });

  it("blocks an invented status", () => {
    const issues = validate({ filingStatus: "married_filing_jointly_but_separately" as never });
    expect(ids(issues)).toContain("FILING_STATUS_INVALID");
  });

  it("notices a married status with no spouse recorded", () => {
    const issues = validate({ filingStatus: "married_filing_jointly" });
    expect(ids(issues)).toContain("SPOUSE_DETAILS_MISSING");
    // Not blocking: the spouse fields may simply be next on the list.
    expect(issues.find((issue) => issue.id === "SPOUSE_DETAILS_MISSING")?.blocking).toBe(false);
  });

  it("notices spouse details under an unmarried status", () => {
    const issues = validate({ taxpayer: { ...TAXPAYER, spouseFirstName: "Alex" } });
    expect(ids(issues)).toContain("SPOUSE_DETAILS_UNEXPECTED");
  });

  it("flags head of household for review without refusing it", () => {
    const issues = validate({ filingStatus: "head_of_household" });
    const review = issues.find((issue) => issue.id === "FILING_STATUS_REVIEW_REQUIRED");
    // The honest position: the calculation proceeds, and the qualification
    // test is named as something a person must check.
    expect(review?.blocking).toBe(false);
    expect(review?.message).toMatch(/does not decide/i);
  });

  it("flags qualifying surviving spouse for review too", () => {
    expect(ids(validate({ filingStatus: "qualifying_surviving_spouse" }))).toContain("FILING_STATUS_REVIEW_REQUIRED");
  });

  it("says nothing about review for a plain single filer", () => {
    expect(ids(validate())).not.toContain("FILING_STATUS_REVIEW_REQUIRED");
  });
});

describe("taxpayer", () => {
  it("asks for a missing name without blocking", () => {
    const issues = validate({ taxpayer: { ...TAXPAYER, legalLastName: null } });
    expect(ids(issues)).toContain("TAXPAYER_NAME_MISSING");
    expect(issues.find((issue) => issue.id === "TAXPAYER_NAME_MISSING")?.blocking).toBe(false);
  });

  it("rejects an impossible date of birth", () => {
    expect(ids(validate({ taxpayer: { ...TAXPAYER, dateOfBirth: "2026-02-30" } }))).toContain("TAXPAYER_DOB_IMPLAUSIBLE");
  });

  it("notes a missing identifier as information, not an error", () => {
    const issues = validate({ taxpayer: { ...TAXPAYER, taxIdentifierOnFile: false } });
    const issue = issues.find((entry) => entry.id === "TAXPAYER_IDENTIFIER_NOT_ON_FILE");
    // Preparation is not filing. A person can organise everything else first.
    expect(issue?.severity).toBe("INFO");
    expect(issue?.blocking).toBe(false);
  });

  it("says plainly that the number itself is never stored", () => {
    const issues = validate({ taxpayer: { ...TAXPAYER, taxIdentifierOnFile: false } });
    expect(issues.find((entry) => entry.id === "TAXPAYER_IDENTIFIER_NOT_ON_FILE")?.resolution).toMatch(/never the number itself/i);
  });
});

describe("fact amounts", () => {
  it("asks for a missing amount", () => {
    expect(ids(validate({ facts: [fact("W2_WAGES", null)] }))).toContain("FACT_AMOUNT_MISSING");
  });

  it("rejects a fractional amount", () => {
    // Amounts are whole cents. A float would silently lose money on the way
    // to the engine.
    expect(ids(validate({ facts: [fact("W2_WAGES", 100.5)] }))).toContain("FACT_AMOUNT_NOT_INTEGER");
  });

  it("rejects negative wages", () => {
    expect(ids(validate({ facts: [fact("W2_WAGES", -100)] }))).toContain("FACT_AMOUNT_NEGATIVE");
  });

  it("permits a capital loss", () => {
    expect(ids(validate({ facts: [fact("CAPITAL_GAIN_OR_LOSS", -250_000)] }))).not.toContain("FACT_AMOUNT_NEGATIVE");
  });

  it("ignores a rejected fact entirely", () => {
    // A rejected value is kept for the audit trail. Validating it would
    // produce errors about a figure nobody is using.
    expect(ids(validate({ facts: [fact("W2_WAGES", -100, { state: "REJECTED" }), fact("W2_WAGES", 100)] }))).not.toContain("FACT_AMOUNT_NEGATIVE");
  });

  it("wants the document when a fact claims to come from one", () => {
    expect(ids(validate({ facts: [fact("W2_WAGES", 100, { source: "DOCUMENT", evidenceDocumentId: null })] }))).toContain("FACT_DOCUMENT_EVIDENCE_MISSING");
  });
});

describe("an AI value confirmed by nobody", () => {
  it("is a blocker", () => {
    const issues = validate({
      facts: [fact("W2_WAGES", 8_500_000, { source: "AI_PROPOSED", state: "CONFIRMED", createdBy: null })],
    });
    const issue = issues.find((entry) => entry.id === "FACT_AI_CONFIRMED_WITHOUT_REVIEWER");
    // This is the failure the whole preparation layer exists to prevent: a
    // model's reading of a document becoming a tax figure with no person
    // between it and the engine.
    expect(issue?.severity).toBe("BLOCKER");
    expect(issue?.blocking).toBe(true);
  });

  it("is not raised when a person accepted it", () => {
    const issues = validate({
      facts: [fact("W2_WAGES", 8_500_000, { source: "AI_PROPOSED", state: "CONFIRMED", createdBy: "user-1" })],
    });
    expect(ids(issues)).not.toContain("FACT_AI_CONFIRMED_WITHOUT_REVIEWER");
  });

  it("is not raised while the value is still merely proposed", () => {
    const issues = validate({
      facts: [fact("W2_WAGES", 8_500_000, { source: "AI_PROPOSED", state: "PROPOSED", createdBy: null })],
    });
    expect(ids(issues)).not.toContain("FACT_AI_CONFIRMED_WITHOUT_REVIEWER");
  });
});

describe("W-2 box consistency", () => {
  it("catches boxes 3 and 5 entered the wrong way round", () => {
    const issues = validate({
      facts: [fact("W2_SOCIAL_SECURITY_WAGES", 9_000_000, { id: "a" }), fact("W2_MEDICARE_WAGES", 8_000_000, { id: "b" })],
    });
    // Box 5 includes everything box 3 does and more, so box 5 below box 3 is
    // arithmetically impossible.
    expect(ids(issues)).toContain("W2_MEDICARE_BELOW_SOCIAL_SECURITY");
  });

  it("accepts box 5 above box 3", () => {
    const issues = validate({
      facts: [fact("W2_SOCIAL_SECURITY_WAGES", 8_000_000, { id: "a" }), fact("W2_MEDICARE_WAGES", 9_000_000, { id: "b" })],
    });
    expect(ids(issues)).not.toContain("W2_MEDICARE_BELOW_SOCIAL_SECURITY");
  });

  it("says nothing when only one of the two boxes is present", () => {
    expect(ids(validate({ facts: [fact("W2_SOCIAL_SECURITY_WAGES", 9_000_000)] }))).not.toContain("W2_MEDICARE_BELOW_SOCIAL_SECURITY");
  });
});

describe("duplicates", () => {
  it("flags the same document producing the same fact twice", () => {
    const issues = validate({
      facts: [
        fact("W2_WAGES", 8_500_000, { id: "a", evidenceDocumentId: "doc-1" }),
        fact("W2_WAGES", 8_500_000, { id: "b", evidenceDocumentId: "doc-1" }),
      ],
    });
    const issue = issues.find((entry) => entry.id === "DUPLICATE_FACT_FROM_DOCUMENT");
    expect(issue).toBeDefined();
    // Never merged or deleted: removing one of someone's income records on a
    // guess is worse than asking.
    expect(issue?.resolution).toMatch(/Nothing is removed automatically/i);
  });

  it("does not flag two W-2s from two employers", () => {
    const issues = validate({
      facts: [
        fact("W2_WAGES", 5_000_000, { id: "a", evidenceDocumentId: "doc-1" }),
        fact("W2_WAGES", 3_500_000, { id: "b", evidenceDocumentId: "doc-2" }),
      ],
    });
    // Two jobs is ordinary.
    expect(ids(issues)).not.toContain("DUPLICATE_FACT_FROM_DOCUMENT");
  });

  it("does not flag two manually entered figures with no document", () => {
    const issues = validate({
      facts: [fact("W2_WAGES", 5_000_000, { id: "a" }), fact("W2_WAGES", 3_500_000, { id: "b" })],
    });
    expect(ids(issues)).not.toContain("DUPLICATE_FACT_FROM_DOCUMENT");
  });
});

describe("dependents", () => {
  it("rejects an impossible date of birth", () => {
    expect(ids(validate({ dependents: [dependent({ dateOfBirth: "2015-13-01" })] }))).toContain("DEPENDENT_DOB_IMPLAUSIBLE");
  });

  it("rejects a months-lived figure outside the year", () => {
    expect(ids(validate({ dependents: [dependent({ monthsLivedWithTaxpayer: 13 })] }))).toContain("DEPENDENT_MONTHS_OUT_OF_RANGE");
  });

  it("flags a dependent claimed by someone else for review", () => {
    const issues = validate({ dependents: [dependent({ claimedByAnother: true })] });
    const issue = issues.find((entry) => entry.id === "DEPENDENT_CLAIMED_ELSEWHERE");
    expect(issue?.severity).toBe("WARNING");
    // Flagged, not adjudicated — nothing here decides who may claim whom.
    expect(issue?.blocking).toBe(false);
  });

  it("flags two dependents with the same name", () => {
    expect(ids(validate({ dependents: [dependent({ id: "a" }), dependent({ id: "b" })] }))).toContain("DUPLICATE_DEPENDENT");
  });

  it("accepts a complete dependent without comment", () => {
    const issues = validate({ dependents: [dependent()] });
    expect(ids(issues).filter((id) => id.startsWith("DEPENDENT_"))).toEqual([]);
  });
});

describe("states", () => {
  it("flags multi-state income as needing review", () => {
    const issues = validate({ taxpayer: { ...TAXPAYER, additionalStateRegions: ["NY"] } });
    const issue = issues.find((entry) => entry.id === "MULTI_STATE_REVIEW_REQUIRED");
    // Allocation between states is genuinely not implemented, and a figure
    // that ignored it would be wrong rather than approximate.
    expect(issue).toBeDefined();
    expect(issue?.resolution).toMatch(/Only the primary state is calculated/i);
  });

  it("notices the primary state listed twice", () => {
    expect(ids(validate({ taxpayer: { ...TAXPAYER, additionalStateRegions: ["CA"] } }))).toContain("STATE_LISTED_TWICE");
  });

  it("says nothing for a single-state case", () => {
    expect(ids(validate()).filter((id) => id.includes("STATE"))).toEqual([]);
  });
});

describe("a clean case", () => {
  it("raises nothing blocking", () => {
    expect(validate().filter((issue) => issue.blocking)).toEqual([]);
  });

  it("gives every issue a resolution a person can act on", () => {
    const issues = validate({ filingStatus: null, taxpayer: { ...TAXPAYER, legalFirstName: null, taxIdentifierOnFile: false }, facts: [fact("W2_WAGES", null)] });
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.resolution.length, issue.id).toBeGreaterThan(10);
      expect(issue.message.length, issue.id).toBeGreaterThan(10);
    }
  });
});

describe("date plausibility", () => {
  it("accepts a real date", () => {
    expect(isPlausibleDate("1985-04-12")).toBe(true);
  });

  it("rejects a day that does not exist", () => {
    // Date parsing that rolls 31 February forward to 3 March would accept a
    // typo as a birthday.
    expect(isPlausibleDate("2026-02-30")).toBe(false);
  });

  it("rejects a malformed string", () => {
    expect(isPlausibleDate("12/04/1985")).toBe(false);
    expect(isPlausibleDate("not-a-date")).toBe(false);
  });
});

describe("married filing separately and the standard deduction (IRS Topic 551)", () => {
  const SPOUSE = { ...TAXPAYER, spouseFirstName: "Alex", spouseLastName: "Okafor" };

  it("asks whether the spouse itemizes when it hasn't been answered, without blocking", () => {
    const issues = validate({ filingStatus: "married_filing_separately", taxpayer: SPOUSE });
    const issue = issues.find((entry) => entry.id === "MFS_SPOUSE_ITEMIZING_UNKNOWN");
    expect(issue).toMatchObject({ severity: "WARNING", blocking: false, affects: "taxpayer.spouseItemizesDeductions" });
  });

  it("blocks calculation when the spouse itemizes, because only the standard deduction is modelled", () => {
    const issues = validate({ filingStatus: "married_filing_separately", taxpayer: { ...SPOUSE, spouseItemizesDeductions: true } });
    const issue = issues.find((entry) => entry.id === "MFS_STANDARD_DEDUCTION_NOT_ALLOWED");
    expect(issue).toMatchObject({ severity: "BLOCKER", blocking: true });
    expect(ids(issues)).not.toContain("MFS_SPOUSE_ITEMIZING_UNKNOWN");
  });

  it("raises nothing when the spouse does not itemize", () => {
    const issues = validate({ filingStatus: "married_filing_separately", taxpayer: { ...SPOUSE, spouseItemizesDeductions: false } });
    expect(ids(issues)).not.toContain("MFS_SPOUSE_ITEMIZING_UNKNOWN");
    expect(ids(issues)).not.toContain("MFS_STANDARD_DEDUCTION_NOT_ALLOWED");
  });

  it.each(["single", "married_filing_jointly", "head_of_household", "qualifying_surviving_spouse"] as const)("ignores the answer under %s", (filingStatus) => {
    for (const spouseItemizesDeductions of [true, false, null]) {
      const found = ids(validate({ filingStatus, taxpayer: { ...SPOUSE, spouseItemizesDeductions } }));
      expect(found).not.toContain("MFS_SPOUSE_ITEMIZING_UNKNOWN");
      expect(found).not.toContain("MFS_STANDARD_DEDUCTION_NOT_ALLOWED");
    }
  });

  it("never marks head of household or surviving spouse as qualified, whatever else is recorded", () => {
    for (const filingStatus of ["head_of_household", "qualifying_surviving_spouse"] as const) {
      const issues = validate({ filingStatus, dependents: [dependent()], taxpayer: { ...SPOUSE, spouseItemizesDeductions: false } });
      expect(ids(issues), filingStatus).toContain("FILING_STATUS_REVIEW_REQUIRED");
    }
  });
});
