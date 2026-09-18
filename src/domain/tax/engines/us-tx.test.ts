import { describe, expect, it } from "vitest";
import { calculateTexasTax } from "./us-tx";
import { calculateFloridaTax } from "./us-fl";
import { calculateUsFederalTax } from "./us-federal";
import { US_TX_2026 } from "../rules/us-tx-2026";
import { US_FL_2026 } from "../rules/us-fl-2026";
import { US_NY_2026 } from "../rules/us-ny-2026";
import { texasFallbackPolicy, resolveTexasRuleSet } from "../rules/resolve-texas";
import { allRuleSets, findRuleSet, findRuleSetVersion, isSupported, supportedTaxYears } from "../rules/registry";
import type { FilingStatus, SupportedTaxCalculation, TaxCalculationInput } from "../tax-engine";

/**
 * Texas.
 *
 * Two confusions to make impossible, and one more than Florida had: that "$0"
 * means "not implemented"; that "$0 individual income tax" means "no Texas
 * tax"; and that Texas is Florida under another name. It is not — different
 * constitutional instrument, adopted in a different decade.
 */

const ORG = "66666666-6666-4666-8666-666666666666";
const dollars = (amount: number) => Math.round(amount * 100);

const ALL_STATUSES: readonly FilingStatus[] = [
  "single",
  "married_filing_jointly",
  "married_filing_separately",
  "head_of_household",
  "qualifying_surviving_spouse",
];

function run(overrides: Partial<TaxCalculationInput> = {}) {
  return calculateTexasTax({
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
  it("is Texas, 2026, versioned", () => {
    expect(US_TX_2026.jurisdiction).toBe("US_TX");
    expect(US_TX_2026.taxYear).toBe(2026);
    expect(US_TX_2026.version).toBe("2026.1");
    expect(US_TX_2026.currency).toBe("USD");
    expect(US_TX_2026.effectiveFrom).toBe("2026-01-01");
    expect(US_TX_2026.effectiveTo).toBe("2026-12-31");
  });

  it("states positively that Texas levies no individual income tax", () => {
    expect(US_TX_2026.noIndividualIncomeTax).toBeDefined();
    expect(US_TX_2026.noIndividualIncomeTax!.basis).toContain("no individual personal income tax");
  });

  it("cites Texas's own constitutional instrument, Article VIII Section 24-a", () => {
    // NOT Florida's Article VII, Section 5. Different constitution, different
    // article, different section, different decade.
    const basis = US_TX_2026.noIndividualIncomeTax!.basis;
    expect(basis).toContain("Article VIII, Section 24-a");
    expect(basis).not.toContain("Article VII, Section 5");
    expect(basis).toContain("net incomes of individuals");
  });

  it("records that there is no Texas individual income tax return to file", () => {
    expect(US_TX_2026.noIndividualIncomeTax!.basis).toContain("no Texas individual income tax return to file");
  });

  it("names the 2019 amendment that created the prohibition", () => {
    // The prohibition is recent. Before Proposition 4 the former Section 24
    // permitted an individual income tax subject to a referendum — which is
    // why this rule set dates its basis instead of treating it as timeless.
    const citation = US_TX_2026.sources.find((s) => s.authority.includes("Constitution"))!.citation;
    expect(citation).toContain("Proposition 4");
    expect(citation).toContain("2019");
    expect(citation).toContain("repealed the former Section 24");
  });

  it("cites the Texas Comptroller and the Texas Constitution, and nobody else", () => {
    expect(US_TX_2026.sources.map((s) => s.authority).sort()).toEqual(
      ["Constitution of the State of Texas", "Texas Comptroller of Public Accounts"].sort(),
    );
    for (const source of US_TX_2026.sources) {
      expect(new URL(source.url).host).toMatch(/texas\.gov$/);
    }
  });

  it("marks both Texas sources UNVERIFIED, with no retrieval date and a stated reason", () => {
    // Every texas.gov domain fails DNS resolution from this environment. The
    // rule is implemented; the citation is not confirmed, and says so.
    for (const source of US_TX_2026.sources) {
      expect(source.verification, source.url).toBe("SOURCE_UNVERIFIED_ENVIRONMENT");
      expect(source.retrievedOn, `${source.url} must not claim a retrieval date`).toBeUndefined();
      expect(source.verificationNote, source.url).toContain("does not resolve");
    }
  });

  it("carries NO brackets, deductions, exemptions or table", () => {
    expect(Object.keys(US_TX_2026.filingStatuses)).toHaveLength(0);
    expect(US_TX_2026.taxTable ?? null).toBeNull();
    expect(US_TX_2026.highIncome ?? null).toBeNull();
    expect(US_TX_2026.selfEmployment).toBeNull();
    expect(US_TX_2026.surtaxes ?? []).toHaveLength(0);
    expect(US_TX_2026.dependentExemptionMinor).toBeUndefined();
  });

  it("contains no rate of any kind, not even a zero one", () => {
    expect(JSON.stringify(US_TX_2026)).not.toContain("rateBasisPoints");
  });

  it("warns that $0 individual income tax is not $0 Texas tax", () => {
    const joined = US_TX_2026.notModelled.join(" ");
    expect(joined).toContain("franchise tax");
    expect(joined).toContain("sales and use tax");
    expect(joined).toContain("property tax");
    expect(joined).toContain("does not mean no Texas tax is owed");
  });

  it("states no rate for any of those other Texas taxes, because none was verified", () => {
    // Naming a tax is a fact. Quoting its rate would be an unverified value.
    expect(US_TX_2026.notModelled.join(" ")).not.toMatch(/\d+(\.\d+)?\s*%/);
  });
});

describe("Texas is not Florida", () => {
  it("is a separate rule set object with its own jurisdiction", () => {
    expect(US_TX_2026).not.toBe(US_FL_2026);
    expect(US_TX_2026.jurisdiction).not.toBe(US_FL_2026.jurisdiction);
  });

  it("borrows no Florida source, URL or basis text", () => {
    const texas = JSON.stringify(US_TX_2026);
    for (const floridaMarker of ["floridarevenue", "leg.state.fl.us", "Florida", "Article VII, Section 5"]) {
      expect(texas, `Texas must not reference ${floridaMarker}`).not.toContain(floridaMarker);
    }
  });

  it("borrows no Texas source into Florida either", () => {
    const florida = JSON.stringify(US_FL_2026);
    for (const texasMarker of ["texas.gov", "Texas", "Section 24-a"]) {
      expect(florida, `Florida must not reference ${texasMarker}`).not.toContain(texasMarker);
    }
  });

  it("reaches the same number by a different route, and stamps a different jurisdiction", () => {
    const texas = ok(run({ ordinaryIncomeMinor: dollars(500_000) }));
    const florida = calculateFloridaTax({ organizationId: ORG, taxYear: 2026, filingStatus: "single", ordinaryIncomeMinor: dollars(500_000), currency: "USD" });
    if (!florida.supported) throw new Error("Florida 2026 should be supported");

    expect(texas.totals.totalTax.amountMinor).toBe(florida.totals.totalTax.amountMinor);
    expect(texas.jurisdiction).toBe("US_TX");
    expect(florida.jurisdiction).toBe("US_FL");
    expect(texas.steps[0].explanation).not.toBe(florida.steps[0].explanation);
  });
});

describe("the resolver", () => {
  it("resolves 2026 to Texas's own 2026 rule set", () => {
    const resolution = resolveTexasRuleSet(2026);
    expect(resolution.resolved).toBe(true);
    if (!resolution.resolved) return;
    expect(resolution.ruleSet).toBe(US_TX_2026);
    expect(resolution.status).toBe("PUBLISHED_RULES");
    expect(resolution.fallback).toBeNull();
  });

  it("makes no substitutions at all", () => {
    expect([...texasFallbackPolicy().entries()]).toEqual([]);
  });

  it.each([2024, 2025, 2027, 2030, 2099])("refuses %s rather than routing it to 2026", (year) => {
    // The answer would be $0 in those years too. It would still be a claim
    // about a year nobody checked — and Texas's prohibition only dates from
    // 2019, so the constitution demonstrably does change.
    const resolution = resolveTexasRuleSet(year);
    expect(resolution.resolved).toBe(false);
    if (!resolution.resolved) expect(resolution.message).toContain("Texas");
  });

  it("never resolves to another jurisdiction's rule set", () => {
    for (const year of [2025, 2026, 2027]) {
      const resolution = resolveTexasRuleSet(year);
      if (!resolution.resolved) continue;
      expect(resolution.ruleSet.jurisdiction).toBe("US_TX");
      expect(resolution.ruleSet).not.toBe(US_FL_2026);
      expect(resolution.ruleSet).not.toBe(US_NY_2026);
    }
  });

  it("is registered under its own jurisdiction and year", () => {
    expect(isSupported("US_TX", 2026)).toBe(true);
    expect(supportedTaxYears("US_TX")).toEqual([2026]);
    expect(findRuleSet("US_TX", 2025)).toBeNull();
    expect(findRuleSetVersion("US_TX", 2026, "2026.1")).toBe(US_TX_2026);
    const keys = allRuleSets().map((r) => `${r.jurisdiction}:${r.taxYear}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the calculation is $0 for everyone", () => {
  it.each(ALL_STATUSES)("%s owes nothing", (filingStatus) => {
    expect(ok(run({ filingStatus })).totals.totalTax.amountMinor).toBe(0);
  });

  it.each([0, 100_000, 1_000_000, 500_000_000])("owes nothing on $%s of income", (income) => {
    const result = ok(run({ ordinaryIncomeMinor: dollars(income), federalAdjustedGrossIncomeMinor: dollars(income) }));
    expect(result.totals.totalTax.amountMinor).toBe(0);
    expect(result.totals.incomeTax.amountMinor).toBe(0);
  });

  it("owes nothing on a loss", () => {
    expect(ok(run({ selfEmploymentNetProfitMinor: dollars(-250_000), federalAdjustedGrossIncomeMinor: dollars(-250_000) })).totals.totalTax.amountMinor).toBe(0);
  });

  it("reports every total as zero, so nothing reads as a partial calculation", () => {
    const totals = ok(run({ ordinaryIncomeMinor: dollars(750_000), federalAdjustedGrossIncomeMinor: dollars(750_000) })).totals;
    for (const [name, amount] of Object.entries(totals)) expect(amount.amountMinor, name).toBe(0);
  });

  it("does not echo the income it was handed", () => {
    const result = ok(run({ ordinaryIncomeMinor: dollars(400_000), selfEmploymentNetProfitMinor: dollars(90_000) }));
    expect(result.inputs.ordinaryIncome.amountMinor).toBe(0);
    expect(result.inputs.selfEmploymentNetProfit.amountMinor).toBe(0);
  });

  it("gives a result that does not depend on any supplied figure", () => {
    // The strongest statement of the property: vary everything a caller can
    // vary, and the totals are byte-identical every time.
    const baseline = JSON.stringify(ok(run()).totals);
    for (const extra of [
      { ordinaryIncomeMinor: dollars(9_000_000) },
      { federalAdjustedGrossIncomeMinor: dollars(9_000_000) },
      { dependentCount: 9 },
      { claimedAsDependent: true },
      { stateAdditionsMinor: dollars(80_000) },
      { stateSubtractionsMinor: dollars(80_000) },
      { w2SocialSecurityWagesMinor: dollars(184_500) },
      { w2MedicareWagesMinor: dollars(400_000) },
    ]) {
      expect(JSON.stringify(ok(run(extra)).totals)).toBe(baseline);
    }
  });
});

describe("the method says why it is zero", () => {
  it("reports NO_INDIVIDUAL_INCOME_TAX", () => {
    expect(ok(run()).calculationMethod).toBe("NO_INDIVIDUAL_INCOME_TAX");
  });

  it("never reports a bracket, schedule or table method", () => {
    const method = ok(run({ ordinaryIncomeMinor: dollars(5_000_000) })).calculationMethod;
    for (const wrong of ["FEDERAL_RATE_SCHEDULE", "CA_RATE_SCHEDULE", "CA_TAX_TABLE", "NY_RATE_SCHEDULE", "NY_TAX_COMPUTATION_WORKSHEET"]) {
      expect(method).not.toBe(wrong);
    }
  });

  it("reports a zero marginal rate and no effective rate", () => {
    const result = ok(run({ ordinaryIncomeMinor: dollars(400_000) }));
    expect(result.rates.marginalRateBasisPoints).toBe(0);
    expect(result.rates.effectiveRateBasisPoints).toBeNull();
  });

  it("is published rules, not an estimate under another year's", () => {
    const result = ok(run());
    expect(result.calculationStatus).toBe("PUBLISHED_RULES");
    expect(result.fallback).toBeNull();
    expect(result.requestedTaxYear).toBe(2026);
    expect(result.taxYear).toBe(2026);
  });
});

describe("the trace", () => {
  const result = ok(run({ ordinaryIncomeMinor: dollars(300_000) }));

  it("names the jurisdiction, year and rule set", () => {
    expect(result.jurisdiction).toBe("US_TX");
    expect(result.ruleSet.jurisdiction).toBe("US_TX");
    expect(result.ruleSet.taxYear).toBe(2026);
    expect(result.ruleSetVersion).toBe("2026.1");
  });

  it("says Texas imposes no individual personal income tax, first", () => {
    expect(result.steps[0].key).toBe("tx_no_individual_income_tax");
    expect(result.steps[0].label).toContain("no individual personal income tax");
    expect(result.steps[0].explanation).toContain("Article VIII, Section 24-a");
  });

  it("distinguishes the three ways a figure can be zero", () => {
    const step = result.steps.find((s) => s.key === "tx_income_tax")!;
    expect(step.amount.amountMinor).toBe(0);
    expect(step.explanation).toContain("not because a calculation was skipped");
    expect(step.explanation).toContain("not because taxable income came out at zero");
  });

  it("scopes itself to individual income tax explicitly", () => {
    const step = result.steps.find((s) => s.key === "tx_income_tax")!;
    expect(step.explanation).toContain("INDIVIDUAL INCOME tax only");
    expect(step.explanation).toContain("franchise tax");
  });

  it("says filing status and income were not used", () => {
    expect(result.steps[0].explanation).toContain("Filing status and income make no difference");
  });

  it("stays short — two steps, no restatement", () => {
    expect(result.steps).toHaveLength(2);
  });

  it("carries the source metadata", () => {
    expect(result.ruleSet.sources).toHaveLength(2);
    for (const source of result.ruleSet.sources) {
      expect(source.verification).toBe("SOURCE_UNVERIFIED_ENVIRONMENT");
      expect(source.citation.length).toBeGreaterThan(60);
    }
  });

  it("does not claim all Texas taxes are zero", () => {
    expect(result.disclaimer).toContain("not the same as owing no Texas tax");
    expect(result.disclaimer).toContain("franchise tax");
    expect(result.disclaimer).toContain("does not prepare or file any Texas return");
    expect(result.notModelled.join(" ")).toContain("franchise tax");
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
    expect(outcome.jurisdiction).toBe("US_TX");
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

describe("Texas never borrows another jurisdiction's figures", () => {
  it("does not consult the federal engine", () => {
    const federal = calculateUsFederalTax({ organizationId: ORG, taxYear: 2026, filingStatus: "single", ordinaryIncomeMinor: dollars(200_000), currency: "USD" });
    if (!federal.supported) throw new Error("federal 2026 should be supported");
    expect(federal.totals.totalTax.amountMinor).toBeGreaterThan(0);
    expect(ok(run({ ordinaryIncomeMinor: dollars(200_000) })).totals.totalTax.amountMinor).toBe(0);
  });

  it("cites only Texas authorities", () => {
    for (const source of ok(run()).ruleSet.sources) {
      expect(source.authority).toContain("Texas");
      expect(source.authority).not.toContain("IRS");
    }
  });
});

describe("determinism and tamper-resistance", () => {
  const input: TaxCalculationInput = {
    organizationId: ORG,
    taxYear: 2026,
    filingStatus: "married_filing_jointly",
    ordinaryIncomeMinor: dollars(880_000),
    currency: "USD",
  };

  it("returns byte-identical output for identical input", () => {
    expect(JSON.stringify(calculateTexasTax(input))).toBe(JSON.stringify(calculateTexasTax(input)));
  });

  it("cannot be given a liability, a rate, a bracket, a method or a version", () => {
    const tampered = calculateTexasTax({
      ...input,
      ...({
        totalTax: 750_000,
        incomeTax: 750_000,
        rateBasisPoints: 700,
        brackets: [{ fromMinor: 0, upToMinor: null, rateBasisPoints: 700 }],
        standardDeductionMinor: 0,
        dependentExemptionMinor: 999_999,
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

  it("cannot be switched to another jurisdiction", () => {
    const tampered = ok(calculateTexasTax({ ...input, ...({ jurisdiction: "US_NY", state: "NY", stateRegion: "NY" } as unknown as object) }));
    expect(tampered.jurisdiction).toBe("US_TX");
    expect(tampered.ruleSet.jurisdiction).toBe("US_TX");
  });

  it("cannot be steered by mutating a previous result", () => {
    const first = ok(calculateTexasTax(input)) as unknown as Record<string, unknown>;
    first.calculationMethod = "CA_TAX_TABLE";
    (first.totals as Record<string, { amountMinor: number }>).totalTax.amountMinor = 54_321;

    const second = ok(calculateTexasTax(input));
    expect(second.calculationMethod).toBe("NO_INDIVIDUAL_INCOME_TAX");
    expect(second.totals.totalTax.amountMinor).toBe(0);
  });

  it("keeps the rule set immutable across runs", () => {
    const before = JSON.stringify(US_TX_2026);
    calculateTexasTax(input);
    expect(JSON.stringify(US_TX_2026)).toBe(before);
  });
});
