import { describe, expect, it } from "vitest";
import { calculateFloridaTax } from "./us-fl";
import { calculateUsFederalTax } from "./us-federal";
import { US_FL_2026 } from "../rules/us-fl-2026";
import { US_NY_2026 } from "../rules/us-ny-2026";
import { US_CA_2025 } from "../rules/us-ca-2025";
import { floridaFallbackPolicy, resolveFloridaRuleSet } from "../rules/resolve-florida";
import { allRuleSets, findRuleSet, findRuleSetVersion, isSupported, supportedTaxYears } from "../rules/registry";
import type { FilingStatus, SupportedTaxCalculation, TaxCalculationInput } from "../tax-engine";

/**
 * Florida.
 *
 * The whole risk here is a single confusion: reading "$0" as "not
 * implemented", or as "no Florida tax at all". Nearly every test below exists
 * to make one of those two readings impossible.
 */

const ORG = "55555555-5555-4555-8555-555555555555";
const dollars = (amount: number) => Math.round(amount * 100);

const ALL_STATUSES: readonly FilingStatus[] = [
  "single",
  "married_filing_jointly",
  "married_filing_separately",
  "head_of_household",
  "qualifying_surviving_spouse",
];

function run(overrides: Partial<TaxCalculationInput> = {}) {
  return calculateFloridaTax({
    organizationId: ORG,
    taxYear: 2026,
    filingStatus: "single",
    ordinaryIncomeMinor: 0,
    currency: "USD",
    ...overrides,
  });
}

function ok(outcome: ReturnType<typeof run>): SupportedTaxCalculation {
  if (!outcome.supported) throw new Error(`Expected a supported calculation, got ${outcome.reason}: ${outcome.message}`);
  return outcome;
}

describe("the rule data", () => {
  it("is Florida, 2026, versioned", () => {
    expect(US_FL_2026.jurisdiction).toBe("US_FL");
    expect(US_FL_2026.taxYear).toBe(2026);
    expect(US_FL_2026.version).toBe("2026.1");
    expect(US_FL_2026.currency).toBe("USD");
  });

  it("states positively that Florida levies no individual income tax", () => {
    // A rule, not an absence. This field is what turns $0 from a gap into an
    // answer, and the engine refuses to report $0 without it.
    expect(US_FL_2026.noIndividualIncomeTax).toBeDefined();
    expect(US_FL_2026.noIndividualIncomeTax!.basis).toContain("no individual personal income tax");
  });

  it("cites the constitutional basis and the Department of Revenue", () => {
    expect(US_FL_2026.noIndividualIncomeTax!.basis).toContain("Article VII, Section 5");
    expect(US_FL_2026.sources.map((s) => s.authority)).toEqual(
      expect.arrayContaining(["Florida Department of Revenue", "Constitution of the State of Florida"]),
    );
    for (const source of US_FL_2026.sources) {
      expect(source.citation.length).toBeGreaterThan(20);
    }
  });

  it("marks both Florida sources UNVERIFIED, with no retrieval date and a stated reason", () => {
    // The source audit found a `retrievedOn` date on documents nobody had
    // opened. Florida's government sites are unreachable from this
    // environment, so the honest record is: cited, explained, not confirmed.
    for (const source of US_FL_2026.sources) {
      expect(source.verification, source.url).toBe("SOURCE_UNVERIFIED_ENVIRONMENT");
      expect(source.retrievedOn, `${source.url} must not claim a retrieval date`).toBeUndefined();
      expect(source.verificationNote, source.url).toBeTruthy();
    }
  });

  it("still implements the rule, because the rule is established independently of the citation", () => {
    // Unverified CITATION is not the same as unsupported RULE. The engine
    // computes $0 from the rule; the sources say how far they were checked.
    expect(US_FL_2026.noIndividualIncomeTax).toBeDefined();
  });

  it("carries NO brackets, deductions or filing-status table", () => {
    // The alternative implementation — a single 0% bracket — would be a
    // fabricated rate schedule. There is no published schedule to transcribe.
    expect(Object.keys(US_FL_2026.filingStatuses)).toHaveLength(0);
    expect(US_FL_2026.taxTable ?? null).toBeNull();
    expect(US_FL_2026.highIncome ?? null).toBeNull();
    expect(US_FL_2026.selfEmployment).toBeNull();
    expect(US_FL_2026.surtaxes ?? []).toHaveLength(0);
    expect(US_FL_2026.dependentExemptionMinor).toBeUndefined();
  });

  it("contains no rate of any kind, not even a zero one", () => {
    expect(JSON.stringify(US_FL_2026)).not.toContain("rateBasisPoints");
  });

  it("borrows nothing from another state's rule set", () => {
    const serialised = JSON.stringify(US_FL_2026);
    for (const stale of ["tax.ny.gov", "ftb.ca.gov", "irs.gov"]) expect(serialised).not.toContain(stale);
  });

  it("warns that $0 individual income tax is not $0 Florida tax", () => {
    const joined = US_FL_2026.notModelled.join(" ");
    expect(joined).toContain("corporate income");
    expect(joined).toContain("sales and use tax");
    expect(joined).toContain("documentary stamp");
    expect(joined).toContain("reemployment tax");
    expect(joined).toContain("does not mean no Florida tax is owed");
  });
});

describe("the resolver", () => {
  it("resolves 2026 to Florida's own 2026 rule set", () => {
    const resolution = resolveFloridaRuleSet(2026);
    expect(resolution.resolved).toBe(true);
    if (!resolution.resolved) return;
    expect(resolution.ruleSet).toBe(US_FL_2026);
    expect(resolution.status).toBe("PUBLISHED_RULES");
    expect(resolution.fallback).toBeNull();
  });

  it("makes no substitutions at all", () => {
    expect([...floridaFallbackPolicy().entries()]).toEqual([]);
  });

  it.each([2024, 2025, 2027, 2030, 2099])("refuses %s rather than routing it to 2026", (year) => {
    // Tempting here above all: Florida's answer would be the same in any
    // year, so a lenient resolver costs nothing — until the law changes and
    // the codebase keeps answering.
    const resolution = resolveFloridaRuleSet(year);
    expect(resolution.resolved).toBe(false);
    if (!resolution.resolved) expect(resolution.message).toContain("Florida");
  });

  it("never resolves to another jurisdiction's rule set", () => {
    for (const year of [2025, 2026, 2027]) {
      const resolution = resolveFloridaRuleSet(year);
      if (!resolution.resolved) continue;
      expect(resolution.ruleSet.jurisdiction).toBe("US_FL");
      expect(resolution.ruleSet).not.toBe(US_NY_2026);
      expect(resolution.ruleSet).not.toBe(US_CA_2025);
    }
  });

  it("is registered under its own jurisdiction and year", () => {
    expect(isSupported("US_FL", 2026)).toBe(true);
    expect(supportedTaxYears("US_FL")).toEqual([2026]);
    expect(findRuleSet("US_FL", 2025)).toBeNull();
    expect(findRuleSetVersion("US_FL", 2026, "2026.1")).toBe(US_FL_2026);
    const keys = allRuleSets().map((r) => `${r.jurisdiction}:${r.taxYear}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the calculation is $0 for everyone", () => {
  it.each(ALL_STATUSES)("%s owes nothing", (filingStatus) => {
    expect(ok(run({ filingStatus })).totals.totalTax.amountMinor).toBe(0);
  });

  it.each([0, 1, 50_000, 1_000_000, 250_000_000])("owes nothing on $%s of income", (income) => {
    const result = ok(run({ ordinaryIncomeMinor: dollars(income), federalAdjustedGrossIncomeMinor: dollars(income) }));
    expect(result.totals.totalTax.amountMinor).toBe(0);
    expect(result.totals.incomeTax.amountMinor).toBe(0);
  });

  it("owes nothing on a loss", () => {
    const result = ok(run({ ordinaryIncomeMinor: 0, selfEmploymentNetProfitMinor: dollars(-80_000), federalAdjustedGrossIncomeMinor: dollars(-80_000) }));
    expect(result.totals.totalTax.amountMinor).toBe(0);
  });

  it("reports every total as zero, so nothing reads as a partial calculation", () => {
    const totals = ok(run({ ordinaryIncomeMinor: dollars(400_000), federalAdjustedGrossIncomeMinor: dollars(400_000) })).totals;
    for (const [name, amount] of Object.entries(totals)) expect(amount.amountMinor, name).toBe(0);
  });

  it("does not echo the income it was handed", () => {
    // Reflecting the figures back would suggest they fed the result. They
    // did not — nothing about Florida depends on them.
    const result = ok(run({ ordinaryIncomeMinor: dollars(400_000), selfEmploymentNetProfitMinor: dollars(90_000) }));
    expect(result.inputs.ordinaryIncome.amountMinor).toBe(0);
    expect(result.inputs.selfEmploymentNetProfit.amountMinor).toBe(0);
  });

  it("gives the same answer whatever else is supplied", () => {
    const baseline = JSON.stringify(ok(run()).totals);
    for (const extra of [
      { ordinaryIncomeMinor: dollars(10_000_000) },
      { dependentCount: 7 },
      { claimedAsDependent: true },
      { stateAdditionsMinor: dollars(50_000) },
      { stateSubtractionsMinor: dollars(50_000) },
      { w2SocialSecurityWagesMinor: dollars(184_500) },
    ]) {
      expect(JSON.stringify(ok(run(extra)).totals)).toBe(baseline);
    }
  });
});

describe("the method says why it is zero", () => {
  it("reports NO_INDIVIDUAL_INCOME_TAX", () => {
    expect(ok(run()).calculationMethod).toBe("NO_INDIVIDUAL_INCOME_TAX");
  });

  it("never reports a bracket or table method", () => {
    const method = ok(run({ ordinaryIncomeMinor: dollars(5_000_000) })).calculationMethod;
    expect(method).not.toBe("FEDERAL_RATE_SCHEDULE");
    expect(method).not.toBe("CA_RATE_SCHEDULE");
    expect(method).not.toBe("CA_TAX_TABLE");
    expect(method).not.toBe("NY_RATE_SCHEDULE");
    expect(method).not.toBe("NY_TAX_COMPUTATION_WORKSHEET");
  });

  it("reports a zero marginal rate and no effective rate", () => {
    const result = ok(run({ ordinaryIncomeMinor: dollars(400_000) }));
    expect(result.rates.marginalRateBasisPoints).toBe(0);
    // Null, not zero: an effective rate needs taxable income to divide by.
    expect(result.rates.effectiveRateBasisPoints).toBeNull();
  });

  it("is published rules, not an estimate under someone else's", () => {
    const result = ok(run());
    expect(result.calculationStatus).toBe("PUBLISHED_RULES");
    expect(result.fallback).toBeNull();
    expect(result.requestedTaxYear).toBe(2026);
    expect(result.taxYear).toBe(2026);
  });
});

describe("the trace", () => {
  const result = ok(run({ ordinaryIncomeMinor: dollars(250_000) }));

  it("names the jurisdiction, year and rule set on the result", () => {
    expect(result.jurisdiction).toBe("US_FL");
    expect(result.ruleSet.jurisdiction).toBe("US_FL");
    expect(result.ruleSet.taxYear).toBe(2026);
    expect(result.ruleSetVersion).toBe("2026.1");
  });

  it("says Florida imposes no individual personal income tax, first", () => {
    expect(result.steps[0].key).toBe("fl_no_individual_income_tax");
    expect(result.steps[0].label).toContain("no individual personal income tax");
    expect(result.steps[0].explanation).toContain("Article VII, Section 5");
  });

  it("reports the $0 liability as a consequence of the law", () => {
    const step = result.steps.find((s) => s.key === "fl_income_tax")!;
    expect(step.amount.amountMinor).toBe(0);
    expect(step.explanation).toContain("not because a calculation was skipped");
  });

  it("says filing status and income were not used", () => {
    expect(result.steps[0].explanation).toContain("Filing status and income make no difference");
  });

  it("stays short — two steps, no restatement", () => {
    expect(result.steps).toHaveLength(2);
  });

  it("distinguishes individual income tax from Florida's other taxes", () => {
    expect(result.disclaimer).toContain("not the same as owing no Florida tax");
    expect(result.disclaimer).toContain("does not prepare or file");
    expect(result.notModelled.join(" ")).toContain("corporate income");
  });

  it("reports amounts in USD", () => {
    expect(result.currency).toBe("USD");
    for (const step of result.steps) expect(step.amount.currency).toBe("USD");
  });
});

describe("refusals", () => {
  it.each([2024, 2025, 2027])("refuses tax year %s", (taxYear) => {
    const outcome = run({ taxYear });
    expect(outcome.supported).toBe(false);
    if (outcome.supported) return;
    expect(outcome.reason).toBe("unsupported_tax_year");
    expect(outcome.jurisdiction).toBe("US_FL");
  });

  it("refuses a currency mismatch rather than returning a mislabelled zero", () => {
    const outcome = run({ currency: "EUR" });
    expect(outcome.supported).toBe(false);
    if (!outcome.supported) expect(outcome.reason).toBe("currency_mismatch");
  });

  it("never returns a partial result alongside a refusal", () => {
    const outcome = run({ taxYear: 2027 });
    expect(outcome).not.toHaveProperty("totals");
    expect(outcome).not.toHaveProperty("steps");
  });
});

describe("Florida is never answered with another jurisdiction's figures", () => {
  it("does not consult the federal engine", () => {
    // Same income through both. Federal is non-zero; Florida is zero, and not
    // because it subtracted anything.
    const federal = calculateUsFederalTax({ organizationId: ORG, taxYear: 2026, filingStatus: "single", ordinaryIncomeMinor: dollars(200_000), currency: "USD" });
    if (!federal.supported) throw new Error("federal 2026 should be supported");
    expect(federal.totals.totalTax.amountMinor).toBeGreaterThan(0);
    expect(ok(run({ ordinaryIncomeMinor: dollars(200_000) })).totals.totalTax.amountMinor).toBe(0);
  });

  it("cites only Florida authorities", () => {
    for (const source of ok(run()).ruleSet.sources) {
      expect(source.authority).toContain("Florida");
      expect(source.authority).not.toContain("IRS");
    }
  });
});

describe("determinism and tamper-resistance", () => {
  const input: TaxCalculationInput = {
    organizationId: ORG,
    taxYear: 2026,
    filingStatus: "head_of_household",
    ordinaryIncomeMinor: dollars(750_000),
    currency: "USD",
  };

  it("returns byte-identical output for identical input", () => {
    expect(JSON.stringify(calculateFloridaTax(input))).toBe(JSON.stringify(calculateFloridaTax(input)));
  });

  it("cannot be given a tax liability, a rate, a method or a version", () => {
    const tampered = calculateFloridaTax({
      ...input,
      ...({
        totalTax: 500_000,
        incomeTax: 500_000,
        rateBasisPoints: 500,
        brackets: [{ fromMinor: 0, upToMinor: null, rateBasisPoints: 500 }],
        calculationMethod: "NY_RATE_SCHEDULE",
        ruleSetVersion: "9999.9",
        noIndividualIncomeTax: null,
      } as unknown as object),
    });
    const result = ok(tampered);
    expect(result.totals.totalTax.amountMinor).toBe(0);
    expect(result.calculationMethod).toBe("NO_INDIVIDUAL_INCOME_TAX");
    expect(result.ruleSetVersion).toBe("2026.1");
  });

  it("cannot be steered by mutating a previous result", () => {
    const first = ok(calculateFloridaTax(input)) as unknown as Record<string, unknown>;
    first.calculationMethod = "CA_TAX_TABLE";
    (first.totals as Record<string, { amountMinor: number }>).totalTax.amountMinor = 12_345;

    const second = ok(calculateFloridaTax(input));
    expect(second.calculationMethod).toBe("NO_INDIVIDUAL_INCOME_TAX");
    expect(second.totals.totalTax.amountMinor).toBe(0);
  });

  it("keeps the rule set immutable across runs", () => {
    const before = JSON.stringify(US_FL_2026);
    calculateFloridaTax(input);
    expect(JSON.stringify(US_FL_2026)).toBe(before);
  });
});
