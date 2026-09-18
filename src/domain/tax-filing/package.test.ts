import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";
import { CASE_ID, ORG, dependent, fact, scenario, w2Facts, type ScenarioOptions } from "./fixtures.test-helpers";
import { buildFilingPackage, FILING_PACKAGE_DISCLAIMER } from "./package";
import { assessFilingReadiness } from "./readiness";
import type { FilingScope } from "./types";

/**
 * The Countorra Filing Package: deterministic, built only from frozen data,
 * and incapable of claiming to be a filing.
 */

const FILING_CASE = "55555555-5555-4555-8555-555555555555";
const GENERATED_AT = "2026-09-13T12:00:00.000Z";

function build(options: ScenarioOptions = {}, scope?: FilingScope) {
  const input = scenario(options);
  const readiness = assessFilingReadiness(input);
  return buildFilingPackage({
    organizationId: ORG,
    currency: "USD",
    filingCaseId: FILING_CASE,
    filingVersion: 1,
    preparationCaseId: CASE_ID,
    preparation: input.latest!,
    readiness,
    scope: scope ?? readiness.finalizableScope ?? "FULL",
    generatedAt: GENERATED_AT,
  });
}

describe("determinism", () => {
  it("builds byte-identical packages from identical frozen inputs", () => {
    const options = { state: "NY", dependents: [dependent()] };
    expect(canonicalJson(build(options))).toBe(canonicalJson(build(options)));
  });

  it("does not change when fact rows arrive in a different order", () => {
    const facts = w2Facts();
    expect(canonicalJson(build({ facts }))).toBe(canonicalJson(build({ facts: [...facts].reverse() })));
  });
});

describe("it never claims to be a filing", () => {
  const pkg = build();
  const serialized = JSON.stringify(pkg);

  it("says so in its own data", () => {
    expect(pkg).toMatchObject({ filed: false, submitted: false, governmentForm: false, electronicFilingAvailable: false });
    expect(pkg.format.name).toBe("Countorra Filing Package");
    expect(pkg.disclaimer).toBe(FILING_PACKAGE_DISCLAIMER);
    expect(pkg.disclaimer).toMatch(/not an IRS or state tax form/);
  });

  it("carries no submission, confirmation or acceptance field of any kind", () => {
    expect(serialized).not.toMatch(/confirmation(Number|Id)|submission(Id|Status)|acceptedAt|accepted"|"efile|transmission|acknowledg(e)?mentId|irsReceipt/i);
  });

  it("maps no form lines and copies no earlier year's form", () => {
    expect(pkg.formMapping.status).toBe("PENDING");
    expect(serialized).not.toMatch(/\bline\s*\d+[a-z]?\b/i);
    expect(serialized).not.toMatch(/Form 1040 \(2025\)/);
  });

  it("holds no identifier, date of birth or evidence note", () => {
    const withNote = JSON.stringify(build({ facts: [...w2Facts().slice(0, 3), fact("W2_FEDERAL_WITHHOLDING", 1_100_000, { evidenceNote: "W-2 box 2, Acme Synthetic Corp" })] }));
    expect(withNote).not.toContain("Acme Synthetic Corp");
    expect(serialized).not.toMatch(/dateOfBirth|1988-03-14|\b\d{3}-\d{2}-\d{4}\b/);
    expect(pkg.taxpayer).toMatchObject({ taxIdentifierOnFile: true, taxIdentifierType: "ssn" });
    expect(Object.keys(pkg.taxpayer)).not.toContain("taxIdentifier");
  });
});

describe("contents come from the frozen calculation", () => {
  it("records the rule-set metadata the engines actually used", () => {
    const pkg = build({ state: "NY" });
    expect(pkg.federal.ruleSet).toMatchObject({ taxYear: 2026, requestedTaxYear: 2026, calculationStatus: "PUBLISHED_RULES" });
    expect(pkg.states[0].ruleSet).toMatchObject({ taxYear: 2026, calculationStatus: "PUBLISHED_RULES" });
    expect(pkg.metadata).toMatchObject({ taxYear: 2026, filingCaseId: FILING_CASE, preparationCaseId: CASE_ID, generatedAt: GENERATED_AT });
    expect(pkg.sources.length).toBeGreaterThan(0);
    for (const source of pkg.sources) expect(source.url, source.url).toMatch(/^https:\/\//);
  });

  it("uses the engine's totals verbatim", () => {
    const input = scenario();
    const pkg = build();
    const federal = input.latest!.calculation!.federal;
    expect(pkg.federal.totals?.totalTaxMinor).toBe(federal.totalTaxMinor);
  });

  it("states payments as recorded and a refund only when payments exist", () => {
    const pkg = build({ facts: [fact("W2_WAGES", 8_500_000), fact("W2_SOCIAL_SECURITY_WAGES", 8_500_000), fact("W2_MEDICARE_WAGES", 8_500_000)] });
    expect(pkg.payments).toEqual({ federalWithholdingMinor: null, federalEstimatedPaymentsMinor: null, stateWithholdingMinor: null, stateEstimatedPaymentsMinor: null });
    expect(pkg.refund.federal).toMatchObject({ status: "NOT_DETERMINABLE", amountMinor: null });
    expect(pkg.refund.state.status).toBe("NOT_DETERMINABLE");
  });

  it("lists evidence by document id only", () => {
    const pkg = build({ facts: [fact("W2_WAGES", 8_500_000, { evidenceDocumentId: "doc-b" }), ...w2Facts().slice(1), fact("W2_WAGES", 100_000, { evidenceDocumentId: "doc-a" })] });
    expect(pkg.evidence.documentIds).toEqual(["doc-a", "doc-b"]);
  });
});

describe("state roles", () => {
  it("Arizona in a federal-only package is EXCLUDED, with its reason and no figure", () => {
    const pkg = build({ state: "AZ" });
    expect(pkg.metadata.scope).toBe("FEDERAL_ONLY");
    expect(pkg.states[0]).toMatchObject({ jurisdiction: "US_AZ", role: "EXCLUDED", totals: null });
    expect(pkg.states[0].exclusionReason).toBeTruthy();
  });

  it("California is EXCLUDED and its estimate is labelled as one", () => {
    const pkg = build({ state: "CA" });
    expect(pkg.states[0]).toMatchObject({ jurisdiction: "US_CA", role: "EXCLUDED", resultStatus: "ESTIMATE" });
    expect(pkg.states[0].fallbackNotice).toMatch(/not a 2026 filed-return calculation/);
  });

  it.each(["FL", "TX"])("%s has no individual income-tax return, never an included state return", (code) => {
    const pkg = build({ state: code });
    expect(pkg.states[0].role).toBe("NO_INDIVIDUAL_INCOME_TAX_RETURN");
    expect(pkg.states[0].totals?.totalTaxMinor).toBe(0);
    expect(pkg.states[0].calculationMethod).toBe("NO_INDIVIDUAL_INCOME_TAX");
  });
});
