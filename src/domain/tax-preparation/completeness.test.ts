import { describe, expect, it } from "vitest";
import { assessCompleteness, jurisdictionsFor, type CompletenessInput } from "./completeness";
import type { TaxFact, TaxFactKey, TaxpayerProfile } from "./types";

/**
 * Completeness — "is there enough to calculate, and what is missing?"
 *
 * The property that matters most here is restraint. A product that blocks on
 * every missing optional field teaches people to click past warnings, which
 * is how the real blockers get ignored too. So most of these tests are about
 * what does NOT block.
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
    id: overrides.id ?? `fact-${key}`,
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

function assess(overrides: Partial<CompletenessInput> = {}) {
  return assessCompleteness({
    taxYear: 2026,
    filingStatus: "single",
    taxpayer: TAXPAYER,
    dependents: [],
    facts: [fact("W2_WAGES", 8_500_000), fact("W2_FEDERAL_WITHHOLDING", 900_000, { id: "wh" })],
    countryCode: "US",
    entityType: "freelancer",
    declaredIncomeKinds: [],
    ...overrides,
  });
}

const ids = (issues: readonly { id: string }[]) => issues.map((issue) => issue.id);

describe("which jurisdictions get calculated", () => {
  it("always includes federal", () => {
    expect(jurisdictionsFor({ countryCode: "US", taxpayer: { ...TAXPAYER, primaryStateRegion: null } })).toEqual(["US_FEDERAL"]);
  });

  it("adds the primary state when it maps to an engine", () => {
    expect(jurisdictionsFor({ countryCode: "US", taxpayer: TAXPAYER })).toEqual(["US_FEDERAL", "US_CA"]);
  });

  it("adds nothing for a state with no engine", () => {
    expect(jurisdictionsFor({ countryCode: "US", taxpayer: { ...TAXPAYER, primaryStateRegion: "WA" } })).toEqual(["US_FEDERAL"]);
  });

  it("leaves out the additional states", () => {
    // Allocating income between states is not implemented. Running a second
    // state engine over the whole federal figure would produce a confident,
    // wrong number — so the second state is disclosed as unhandled instead.
    const result = assess({ taxpayer: { ...TAXPAYER, additionalStateRegions: ["NY"] } });
    expect(result.jurisdictions).toEqual(["US_FEDERAL", "US_CA"]);
    expect(ids(result.issues)).toContain("MULTI_STATE_REVIEW_REQUIRED");
  });

  it("ignores a state outside the US", () => {
    expect(jurisdictionsFor({ countryCode: "RO", taxpayer: TAXPAYER })).toEqual(["US_FEDERAL"]);
  });
});

describe("what blocks", () => {
  it("blocks when nothing has been confirmed", () => {
    const result = assess({ facts: [] });
    expect(ids(result.blockers)).toContain("NO_CONFIRMED_FACTS");
    expect(result.readyForCalculation).toBe(false);
  });

  it("blocks when only proposed values exist", () => {
    // A model's reading of a document is not a confirmed figure, and
    // calculating from one would defeat the entire review step.
    const result = assess({ facts: [fact("W2_WAGES", 8_500_000, { state: "PROPOSED", source: "AI_PROPOSED" })] });
    expect(ids(result.blockers)).toContain("NO_CONFIRMED_FACTS");
  });

  it("blocks when income was reported but never entered", () => {
    const result = assess({ declaredIncomeKinds: ["SELF_EMPLOYMENT_NET_PROFIT"] });
    // The person already told us this income exists. Calculating without it
    // understates the tax on a return that looks finished.
    expect(ids(result.blockers)).toContain("DECLARED_INCOME_MISSING_VALUE:SELF_EMPLOYMENT_NET_PROFIT");
  });

  it("stops blocking once the reported income is entered", () => {
    const result = assess({
      declaredIncomeKinds: ["SELF_EMPLOYMENT_NET_PROFIT"],
      facts: [fact("W2_WAGES", 8_500_000), fact("SELF_EMPLOYMENT_NET_PROFIT", 2_000_000, { id: "se" })],
    });
    expect(ids(result.blockers)).not.toContain("DECLARED_INCOME_MISSING_VALUE:SELF_EMPLOYMENT_NET_PROFIT");
  });

  it("blocks an unusable tax year", () => {
    expect(ids(assess({ taxYear: 0 }).blockers)).toContain("TAX_YEAR_INVALID");
  });

  it("blocks a year federal does not implement", () => {
    const result = assess({ taxYear: 2019 });
    expect(ids(result.blockers)).toContain("FEDERAL_YEAR_UNSUPPORTED");
    expect(result.readyForCalculation).toBe(false);
  });

  it("blocks a missing filing status, via validation", () => {
    expect(ids(assess({ filingStatus: null }).blockers)).toContain("FILING_STATUS_MISSING");
  });

  it("is ready when nothing blocks", () => {
    const result = assess();
    expect(result.blockers).toEqual([]);
    expect(result.readyForCalculation).toBe(true);
  });
});

describe("what does not block", () => {
  it("does not block a business workspace, but says what is not covered", () => {
    const result = assess({ entityType: "business" });
    const issue = result.issues.find((entry) => entry.id === "ENTITY_RETURN_NOT_SUPPORTED");
    // A business owner still has a personal return, and that is what this
    // prepares. Refusing outright would help nobody.
    expect(issue?.blocking).toBe(false);
    expect(issue?.message).toMatch(/does not prepare a corporate or partnership return/i);
    expect(result.readyForCalculation).toBe(true);
  });

  it("mentions unreviewed suggestions without blocking on them", () => {
    const result = assess({
      facts: [fact("W2_WAGES", 8_500_000), fact("INTEREST_INCOME", 5_000, { id: "p", state: "PROPOSED", source: "AI_PROPOSED", createdBy: null })],
    });
    const issue = result.issues.find((entry) => entry.id === "PROPOSED_FACTS_PENDING");
    expect(issue?.severity).toBe("WARNING");
    expect(issue?.message).toMatch(/will not be used in the calculation/i);
    expect(result.readyForCalculation).toBe(true);
  });

  it("counts the unreviewed suggestions", () => {
    const result = assess({
      facts: [
        fact("W2_WAGES", 8_500_000),
        fact("INTEREST_INCOME", 5_000, { id: "p1", state: "PROPOSED" }),
        fact("ORDINARY_DIVIDENDS", 6_000, { id: "p2", state: "PROPOSED" }),
      ],
    });
    expect(result.issues.find((entry) => entry.id === "PROPOSED_FACTS_PENDING")?.message).toContain("2 suggested");
  });

  it("notes a missing document as information only", () => {
    const result = assess({ facts: [fact("W2_WAGES", 8_500_000)] });
    const issue = result.issues.find((entry) => entry.id === "DOCUMENT_POSSIBLY_REQUIRED:W2_WAGES");
    // Not everyone receives every form, and a product that insists on a
    // 1099-INT for $3 of interest is one people learn to ignore.
    expect(issue?.severity).toBe("INFO");
    expect(issue?.blocking).toBe(false);
  });

  it("says nothing about documents once one is attached", () => {
    const result = assess({ facts: [fact("W2_WAGES", 8_500_000, { evidenceDocumentId: "doc-1" })] });
    expect(ids(result.issues)).not.toContain("DOCUMENT_POSSIBLY_REQUIRED:W2_WAGES");
  });
});

describe("what each state will actually do", () => {
  it("tells a Californian the 2026 figure will be an estimate", () => {
    const result = assess({ taxpayer: { ...TAXPAYER, primaryStateRegion: "CA" } });
    const issue = result.issues.find((entry) => entry.id === "JURISDICTION_ESTIMATE_FROM_PUBLISHED_RULES:US_CA");
    // California 2026 IS answered — under 2025's published rules, disclosed.
    // Telling this person their state is "unavailable" would be false.
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/2025/);
    expect(issue?.blocking).toBe(false);
    expect(ids(result.issues)).not.toContain("JURISDICTION_RULES_PENDING:US_CA");
  });

  it("tells an Arizonan the state is unavailable, and exactly what is missing", () => {
    const result = assess({ taxpayer: { ...TAXPAYER, primaryStateRegion: "AZ" } });
    const issue = result.issues.find((entry) => entry.id === "JURISDICTION_RULES_PENDING:US_AZ");
    // Arizona has no sanctioned fallback, so there is no figure — and the
    // reason names the unpublished input rather than saying "unsupported".
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/not yet published/i);
    expect(issue?.message.length).toBeGreaterThan(80);
    expect(ids(result.issues)).not.toContain("JURISDICTION_ESTIMATE_FROM_PUBLISHED_RULES:US_AZ");
  });

  it("does not let a pending state block the federal figure", () => {
    const result = assess({ taxpayer: { ...TAXPAYER, primaryStateRegion: "AZ" } });
    expect(result.blockers).toEqual([]);
    expect(result.readyForCalculation).toBe(true);
  });

  it("says nothing special about New York, whose 2026 rules are published", () => {
    const result = assess({ taxpayer: { ...TAXPAYER, primaryStateRegion: "NY" } });
    expect(ids(result.issues).filter((id) => id.startsWith("JURISDICTION_"))).toEqual([]);
  });

  it("says nothing special about Florida or Texas", () => {
    for (const state of ["FL", "TX"]) {
      const result = assess({ taxpayer: { ...TAXPAYER, primaryStateRegion: state } });
      expect(ids(result.issues).filter((id) => id.startsWith("JURISDICTION_")), state).toEqual([]);
    }
  });
});

describe("payments", () => {
  it("says no refund can be stated when no payments are recorded", () => {
    const result = assess({ facts: [fact("W2_WAGES", 8_500_000)] });
    const issue = result.issues.find((entry) => entry.id === "FEDERAL_PAYMENTS_UNKNOWN");
    // A liability figure alone never implies a refund, and the absence of
    // withholding data is not the same as zero withholding.
    expect(issue?.severity).toBe("INFO");
    expect(issue?.message).toMatch(/no refund or balance due can be stated/i);
  });

  it("stops saying it once withholding is entered", () => {
    expect(ids(assess().issues)).not.toContain("FEDERAL_PAYMENTS_UNKNOWN");
  });

  it("accepts estimated payments in place of withholding", () => {
    const result = assess({ facts: [fact("W2_WAGES", 8_500_000), fact("FEDERAL_ESTIMATED_PAYMENTS", 400_000, { id: "est" })] });
    expect(ids(result.issues)).not.toContain("FEDERAL_PAYMENTS_UNKNOWN");
  });
});

describe("every issue is actionable", () => {
  it("carries a resolution and a readable message", () => {
    const result = assess({
      taxYear: 2026,
      entityType: "business",
      declaredIncomeKinds: ["RENTAL_INCOME"],
      taxpayer: { ...TAXPAYER, primaryStateRegion: "AZ", additionalStateRegions: ["NY"] },
      facts: [fact("W2_WAGES", 8_500_000), fact("INTEREST_INCOME", 1, { id: "p", state: "PROPOSED" })],
    });
    expect(result.issues.length).toBeGreaterThan(4);
    for (const issue of result.issues) {
      expect(issue.resolution.length, issue.id).toBeGreaterThan(10);
      expect(issue.message.length, issue.id).toBeGreaterThan(10);
      expect(issue.blocking, issue.id).toBe(issue.severity === "BLOCKER");
    }
  });

  it("never reports a blocker that is absent from the issue list", () => {
    const result = assess({ facts: [] });
    for (const blocker of result.blockers) {
      expect(result.issues).toContain(blocker);
    }
  });
});
