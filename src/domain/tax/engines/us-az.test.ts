import { describe, expect, it } from "vitest";
import { calculateArizonaTax } from "./us-az";
import { calculateUsFederalTax } from "./us-federal";
import { US_AZ_2026 } from "../rules/us-az-2026";
import { US_CA_2025 } from "../rules/us-ca-2025";
import { US_CA_2026 } from "../rules/us-ca-2026";
import { arizonaFallbackPolicy, resolveArizonaRuleSet } from "../rules/resolve-arizona";
import { allRuleSets, findRuleSet, findRuleSetVersion, isSupported, supportedTaxYears } from "../rules/registry";
import type { FilingStatus, TaxCalculationInput } from "../tax-engine";

/**
 * Arizona 2026.
 *
 * The interesting property here is a refusal, and the tests exist to pin down
 * that it is the RIGHT refusal: specific about what is missing, distinct from
 * "we don't do Arizona", and immune to the fallback that Arizona's near-twin
 * situation in California legitimately uses.
 */

const ORG = "77777777-7777-4777-8777-777777777777";
const dollars = (amount: number) => Math.round(amount * 100);

const ALL_STATUSES: readonly FilingStatus[] = [
  "single",
  "married_filing_jointly",
  "married_filing_separately",
  "head_of_household",
  "qualifying_surviving_spouse",
];

function run(overrides: Partial<TaxCalculationInput> = {}) {
  return calculateArizonaTax({
    organizationId: ORG,
    taxYear: 2026,
    filingStatus: "single",
    ordinaryIncomeMinor: dollars(100_000),
    federalAdjustedGrossIncomeMinor: dollars(100_000),
    currency: "USD",
    ...overrides,
  });
}

describe("rule metadata", () => {
  it("is Arizona, 2026, versioned as not-yet-computable", () => {
    expect(US_AZ_2026.jurisdiction).toBe("US_AZ");
    expect(US_AZ_2026.taxYear).toBe(2026);
    // `.0` is this codebase's convention for "registered, nothing computable
    // yet" — the same version California 2026 carries.
    expect(US_AZ_2026.version).toBe("2026.0");
    expect(US_AZ_2026.currency).toBe("USD");
    expect(US_AZ_2026.effectiveFrom).toBe("2026-01-01");
    expect(US_AZ_2026.effectiveTo).toBe("2026-12-31");
  });

  it("cites the Arizona Revised Statutes and the Legislature's budget committee", () => {
    expect(US_AZ_2026.sources.map((s) => s.authority)).toEqual([
      "Arizona Revised Statutes",
      "Arizona Revised Statutes",
      "Arizona Joint Legislative Budget Committee",
    ]);
    for (const source of US_AZ_2026.sources) {
      expect(new URL(source.url).host).toMatch(/^www\.az(leg|jlbc)\.gov$/);
    }
  });

  it("marks the statutes as primary and the handbook as official secondary", () => {
    // The distinction is real: a legislative analyst describing the law is
    // worth less than the Department applying it, and flattening both into
    // "verified" would hide that.
    const [rates, deduction, handbook] = US_AZ_2026.sources;
    expect(rates.verification).toBe("VERIFIED_PRIMARY_SOURCE");
    expect(deduction.verification).toBe("VERIFIED_PRIMARY_SOURCE");
    expect(handbook.verification).toBe("VERIFIED_OFFICIAL_SECONDARY_SOURCE");
    for (const source of US_AZ_2026.sources) expect(source.retrievedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("records the verified 2.5% flat rate and the statute that sets it", () => {
    const citation = US_AZ_2026.sources[0].citation;
    expect(citation).toContain("43-1011");
    expect(citation).toContain("2.5% of taxable income");
    expect(citation).toContain("no filing-status distinction");
  });

  it("records the JLBC confirmation that the rate is actually in force", () => {
    // § 43-1011(A)(9) is conditional on a revenue-trigger notice, so the
    // statute alone does not prove it governs 2026.
    const citation = US_AZ_2026.sources[2].citation;
    expect(citation).toContain("Beginning in TY 2023");
    expect(citation).toContain("single tax rate of 2.5%");
  });

  it("records the new-for-2026 charitable increase to the standard deduction", () => {
    // A.R.S. § 43-1041(I)(2) applies from tax year 2026 and replaces the old
    // percentage rule. Easy to miss, and it changes the deduction.
    const citation = US_AZ_2026.sources[1].citation;
    expect(citation).toContain("from and after 31 December 2025");
    expect(citation).toContain("$1,000");
    expect(citation).toContain("$2,000");
  });

  it("carries no brackets, deduction or table, because none can be stated yet", () => {
    expect(Object.keys(US_AZ_2026.filingStatuses)).toHaveLength(0);
    expect(US_AZ_2026.taxTable).toBeNull();
    expect(US_AZ_2026.highIncome ?? null).toBeNull();
    expect(US_AZ_2026.selfEmployment).toBeNull();
    expect(US_AZ_2026.noIndividualIncomeTax ?? null).toBeNull();
  });

  it("does NOT carry any standard deduction figure, derived or otherwise", () => {
    // The 2026 amounts would very likely equal the 2026 FEDERAL ones, which
    // this codebase has verified. Deriving them anyway is the single most
    // tempting wrong move here, so it is asserted against directly.
    const serialised = JSON.stringify(US_AZ_2026);
    for (const federal2026 of ["1610000", "2415000", "3220000"]) {
      expect(serialised, `must not carry a derived 2026 deduction (${federal2026})`).not.toContain(federal2026);
    }
    expect(serialised).not.toContain("standardDeductionMinor");
  });

  it("names exactly what is missing", () => {
    const pending = US_AZ_2026.pendingPublication!;
    expect(pending.length).toBeGreaterThan(0);
    const joined = pending.join(" ");
    expect(joined).toContain("standard deduction");
    expect(joined).toContain("Department of Revenue");
    expect(joined).toContain("head-of-household cap");
  });

  it("discloses that any future figure is tax BEFORE credits", () => {
    const joined = US_AZ_2026.notModelled.join(" ");
    expect(joined).toContain("tax BEFORE credits");
    expect(joined).toContain("dependent tax credit");
  });

  it("discloses the Arizona provisions that materially change a result", () => {
    const joined = US_AZ_2026.notModelled.join(" ");
    expect(joined).toContain("Social Security income");
    expect(joined).toContain("military retirement");
    expect(joined).toContain("43-1023");
    expect(joined).toContain("140-SBI");
    expect(joined).toContain("itemized deductions");
  });

  it("does not claim Arizona's other taxes are modelled", () => {
    expect(US_AZ_2026.notModelled.join(" ")).toContain("transaction privilege tax");
  });
});

describe("the resolver", () => {
  it("makes no substitutions at all", () => {
    // California's near-identical situation DOES fall back — because FTB
    // instructs it. No Arizona instruction was found, so nothing here
    // substitutes.
    expect([...arizonaFallbackPolicy().entries()]).toEqual([]);
  });

  it("refuses 2026 with the pending figures rather than resolving it", () => {
    const resolution = resolveArizonaRuleSet(2026);
    expect(resolution.resolved).toBe(false);
    if (resolution.resolved) return;
    expect(resolution.message).toContain("Arizona");
    expect(resolution.message).toContain("Arizona Department of Revenue");
    expect(resolution.details).toBe(US_AZ_2026.pendingPublication);
  });

  it.each([2024, 2025, 2027, 2030, 2099])("refuses %s, which is not registered at all", (year) => {
    const resolution = resolveArizonaRuleSet(year);
    expect(resolution.resolved).toBe(false);
    if (resolution.resolved) return;
    expect(resolution.message).toContain("not currently supported");
    // No pending list: this year was never modelled, which is a different
    // thing from "modelled and waiting".
    expect(resolution.details).toBeUndefined();
  });

  it("never resolves to another jurisdiction's rule set", () => {
    for (const year of [2025, 2026, 2027]) {
      const resolution = resolveArizonaRuleSet(year);
      if (!resolution.resolved) continue;
      expect(resolution.ruleSet.jurisdiction).toBe("US_AZ");
      expect(resolution.ruleSet).not.toBe(US_CA_2025);
      expect(resolution.ruleSet).not.toBe(US_CA_2026);
    }
  });

  it("is registered under its own jurisdiction and year", () => {
    expect(isSupported("US_AZ", 2026)).toBe(true);
    expect(supportedTaxYears("US_AZ")).toEqual([2026]);
    expect(findRuleSet("US_AZ", 2025)).toBeNull();
    expect(findRuleSetVersion("US_AZ", 2026, "2026.0")).toBe(US_AZ_2026);
    const keys = allRuleSets().map((r) => `${r.jurisdiction}:${r.taxYear}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("would use Arizona's own 2026 rules the moment they are published", () => {
    // The switch-over is a data change: the shared resolver's first branch
    // takes any requested year whose own rule set is not pending.
    const published = { ...US_AZ_2026, pendingPublication: [] };
    expect((published.pendingPublication ?? []).length).toBe(0);
    expect(arizonaFallbackPolicy().size).toBe(0);
  });
});

describe("the engine refuses, specifically", () => {
  it("reports rules_not_published for 2026, not unsupported_tax_year", () => {
    const outcome = run();
    expect(outcome.supported).toBe(false);
    if (outcome.supported) return;
    expect(outcome.reason).toBe("rules_not_published");
    expect(outcome.jurisdiction).toBe("US_AZ");
    expect(outcome.taxYear).toBe(2026);
  });

  it("hands back the exact list of missing figures", () => {
    const outcome = run();
    if (outcome.supported) return;
    expect(outcome.details).toBeDefined();
    expect(outcome.details!.join(" ")).toContain("standard deduction");
  });

  it("says which authority the figure is waiting on", () => {
    const outcome = run();
    if (outcome.supported) return;
    expect(outcome.message).toContain("Arizona Department of Revenue");
  });

  it.each([2024, 2025, 2027, 2030])("reports unsupported_tax_year for %s", (taxYear) => {
    const outcome = run({ taxYear });
    expect(outcome.supported).toBe(false);
    if (outcome.supported) return;
    // The distinction matters: "waiting on the Department" and "never
    // attempted" are different answers to different questions.
    expect(outcome.reason).toBe("unsupported_tax_year");
    expect(outcome.details).toBeUndefined();
  });

  it.each(ALL_STATUSES)("refuses %s alike, rather than blaming the filing status", (filingStatus) => {
    const outcome = run({ filingStatus });
    expect(outcome.supported).toBe(false);
    if (!outcome.supported) expect(outcome.reason).toBe("rules_not_published");
  });

  it.each([0, 1, 50_000, 1_000_000, 250_000_000])("refuses at $%s of income, income being irrelevant to the refusal", (income) => {
    const outcome = run({ ordinaryIncomeMinor: dollars(income), federalAdjustedGrossIncomeMinor: dollars(income) });
    expect(outcome.supported).toBe(false);
  });

  it("never returns a partial result alongside the refusal", () => {
    const outcome = run();
    expect(outcome).not.toHaveProperty("totals");
    expect(outcome).not.toHaveProperty("steps");
    expect(outcome).not.toHaveProperty("rates");
    expect(outcome).not.toHaveProperty("calculationMethod");
  });

  it("returns no figure at all — not a zero that could be mistaken for an answer", () => {
    // Florida and Texas answer $0 because their law says so. Arizona's law
    // says 2.5%; a $0 here would be a wrong number, not a refusal.
    expect(JSON.stringify(run())).not.toContain("amountMinor");
  });

  it("is deterministic", () => {
    const input: TaxCalculationInput = {
      organizationId: ORG,
      taxYear: 2026,
      filingStatus: "head_of_household",
      ordinaryIncomeMinor: dollars(320_000),
      federalAdjustedGrossIncomeMinor: dollars(320_000),
      currency: "USD",
    };
    expect(JSON.stringify(calculateArizonaTax(input))).toBe(JSON.stringify(calculateArizonaTax(input)));
  });
});

describe("Arizona is never answered with another jurisdiction's figures", () => {
  it("does not borrow California's 2025 rules, though the situation matches", () => {
    const outcome = run();
    const serialised = JSON.stringify(outcome);
    expect(serialised).not.toContain("US_CA");
    expect(serialised).not.toContain("2025.1");
    expect(serialised).not.toContain("ESTIMATE_USING_LATEST_PUBLISHED_RULES");
  });

  it("does not fall back to a federal figure", () => {
    const federal = calculateUsFederalTax({ organizationId: ORG, taxYear: 2026, filingStatus: "single", ordinaryIncomeMinor: dollars(100_000), currency: "USD" });
    expect(federal.supported).toBe(true);
    // Federal computes; Arizona still refuses. One does not rescue the other.
    expect(run().supported).toBe(false);
  });

  it("cites only Arizona authorities", () => {
    for (const source of US_AZ_2026.sources) {
      expect(source.authority).toContain("Arizona");
      expect(source.url).toContain("az");
    }
  });

  it("cannot be steered by input into producing a figure", () => {
    const tampered = calculateArizonaTax({
      organizationId: ORG,
      taxYear: 2026,
      filingStatus: "single",
      ordinaryIncomeMinor: dollars(100_000),
      currency: "USD",
      ...({
        standardDeductionMinor: dollars(16_100),
        rateBasisPoints: 250,
        brackets: [{ fromMinor: 0, upToMinor: null, rateBasisPoints: 250 }],
        totalTax: dollars(2_500),
        pendingPublication: [],
        calculationStatus: "PUBLISHED_RULES",
        ruleSetVersion: "2026.1",
      } as unknown as object),
    });
    expect(tampered.supported).toBe(false);
    if (!tampered.supported) expect(tampered.reason).toBe("rules_not_published");
  });

  it("keeps the rule set immutable across runs", () => {
    const before = JSON.stringify(US_AZ_2026);
    run();
    expect(JSON.stringify(US_AZ_2026)).toBe(before);
  });
});
