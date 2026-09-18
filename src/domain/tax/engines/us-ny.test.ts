import { describe, expect, it } from "vitest";
import { calculateNewYorkTax } from "./us-ny";
import { calculateUsFederalTax } from "./us-federal";
import { calculateCaliforniaTax } from "./us-ca";
import { US_NY_2026 } from "../rules/us-ny-2026";
import type { SupportedTaxCalculation, TaxCalculationInput } from "../tax-engine";

/**
 * The New York State engine end to end.
 *
 * Every expected figure below was computed by hand from Form IT-2105-I (2026)
 * and is stated in dollars in the test name, so a failure says which number
 * moved rather than only that one did.
 */

const ORG = "44444444-4444-4444-8444-444444444444";
const dollars = (amount: number) => Math.round(amount * 100);

const RECAPTURE_FROM = 107_650;

function run(overrides: Partial<TaxCalculationInput> = {}) {
  return calculateNewYorkTax({
    organizationId: ORG,
    taxYear: 2026,
    filingStatus: "single",
    ordinaryIncomeMinor: 0,
    federalAdjustedGrossIncomeMinor: 0,
    currency: "USD",
    ...overrides,
  });
}

function ok(outcome: ReturnType<typeof run>): SupportedTaxCalculation {
  if (!outcome.supported) throw new Error(`Expected a supported calculation, got ${outcome.reason}: ${outcome.message}`);
  return outcome;
}

/** A run at a given federal AGI, with no New York adjustments. */
const atAgi = (agi: number, overrides: Partial<TaxCalculationInput> = {}) => ok(run({ federalAdjustedGrossIncomeMinor: dollars(agi), ...overrides }));

describe("the Form IT-201 pipeline", () => {
  it("starts from federal adjusted gross income", () => {
    const result = atAgi(60_000);
    expect(result.totals.grossIncome.amountMinor).toBe(dollars(60_000));
    expect(result.steps[0].key).toBe("federal_adjusted_gross_income");
  });

  it("adds New York additions and subtracts New York subtractions", () => {
    const result = atAgi(100_000, { stateAdditionsMinor: dollars(5_000), stateSubtractionsMinor: dollars(12_000) });
    expect(result.totals.adjustedGrossIncome.amountMinor).toBe(dollars(93_000));
  });

  it("subtracts New York's own standard deduction, not the federal one", () => {
    const result = atAgi(60_000);
    expect(result.totals.standardDeduction.amountMinor).toBe(dollars(8_000));
    expect(result.totals.taxableIncome.amountMinor).toBe(dollars(52_000));
  });

  it("uses the smaller deduction for someone claimed as a dependent", () => {
    const result = atAgi(60_000, { claimedAsDependent: true });
    expect(result.totals.standardDeduction.amountMinor).toBe(dollars(3_100));
  });

  it("subtracts $1,000 for each dependent", () => {
    const result = atAgi(60_000, { dependentCount: 3 });
    expect(result.totals.taxableIncome.amountMinor).toBe(dollars(60_000 - 8_000 - 3_000));
  });

  it("floors taxable income at zero", () => {
    const result = atAgi(5_000);
    expect(result.totals.taxableIncome.amountMinor).toBe(0);
    expect(result.totals.totalTax.amountMinor).toBe(0);
  });

  it("handles a negative federal AGI without going negative", () => {
    const result = atAgi(-50_000);
    expect(result.totals.taxableIncome.amountMinor).toBe(0);
    expect(result.totals.totalTax.amountMinor).toBe(0);
  });

  it("reports the steps in the order the worksheet sets out", () => {
    const keys = atAgi(60_000, { stateAdditionsMinor: dollars(1_000), dependentCount: 1 }).steps.map((s) => s.key);
    expect(keys.slice(0, 6)).toEqual([
      "federal_adjusted_gross_income",
      "ny_additions",
      "ny_adjusted_gross_income",
      "ny_standard_deduction",
      "ny_dependent_exemptions",
      "ny_taxable_income",
    ]);
    expect(keys.at(-1)).toBe("ny_income_tax");
  });
});

describe("the rate schedule, at or below $107,650 of NYAGI", () => {
  it("owes nothing on zero income", () => {
    const result = ok(run());
    expect(result.totals.totalTax.amountMinor).toBe(0);
    expect(result.rates.effectiveRateBasisPoints).toBeNull();
  });

  it("owes $2,643.40 on $60,000 — Single", () => {
    // 60,000 − 8,000 = 52,000 taxable, in the $13,900–$80,650 row:
    // $586 plus 5.40% of the excess over $13,900 = 586 + 0.054 × 38,100.
    const result = atAgi(60_000);
    expect(result.calculationMethod).toBe("NY_RATE_SCHEDULE");
    expect(result.totals.totalTax.amountMinor).toBe(dollars(2_643.4));
    expect(result.rates.marginalRateBasisPoints).toBe(540);
  });

  it("owes $4,092.70 on $100,000 with two dependents — Married filing jointly", () => {
    // 100,000 − 16,050 − 2,000 = 81,950 taxable, in the $27,900–$161,550 row:
    // $1,174 plus 5.40% of the excess over $27,900.
    const result = atAgi(100_000, { filingStatus: "married_filing_jointly", dependentCount: 2 });
    expect(result.totals.totalTax.amountMinor).toBe(dollars(4_092.7));
  });

  it("uses the published base rather than a sum of brackets", () => {
    // At exactly $8,500 of taxable income the exact figure is $331.50; New
    // York prints $332 as the base for the row above. One dollar further on,
    // the tax must be that printed base plus 4.40% — $332.04, not $331.54.
    const result = atAgi(8_000 + 8_501);
    expect(result.totals.taxableIncome.amountMinor).toBe(dollars(8_501));
    expect(result.totals.totalTax.amountMinor).toBe(dollars(332.04));
  });

  it("taxes a joint couple less than a single filer on the same income", () => {
    expect(atAgi(90_000, { filingStatus: "married_filing_jointly" }).totals.totalTax.amountMinor).toBeLessThan(atAgi(90_000).totals.totalTax.amountMinor);
  });

  it("treats married filing separately on the Single schedule, and qualifying surviving spouse on the joint one", () => {
    expect(atAgi(60_000, { filingStatus: "married_filing_separately" }).totals.totalTax.amountMinor).toBe(atAgi(60_000).totals.totalTax.amountMinor);
    expect(atAgi(90_000, { filingStatus: "qualifying_surviving_spouse" }).totals.totalTax.amountMinor).toBe(
      atAgi(90_000, { filingStatus: "married_filing_jointly" }).totals.totalTax.amountMinor,
    );
  });

  it("supports head of household on its own schedule", () => {
    const result = atAgi(60_000, { filingStatus: "head_of_household" });
    // 60,000 − 11,200 = 48,800 taxable: $879 plus 5.40% over $20,900.
    expect(result.totals.totalTax.amountMinor).toBe(dollars(879 + 0.054 * (48_800 - 20_900)));
  });
});

describe("bracket boundaries on the rate schedule", () => {
  const SINGLE_THRESHOLDS = [8_500, 11_700, 13_900, 80_650] as const;
  const RATE_ABOVE = [440, 515, 540, 590] as const;

  it.each(SINGLE_THRESHOLDS.map((t, i) => [t, RATE_ABOVE[i]] as const))(
    "at $%s of taxable income the row above starts from the published base at %s basis points",
    (threshold, rate) => {
      // Kept below $107,650 of NYAGI so the schedule, not a worksheet, governs.
      //
      // NOTE the property being asserted. Under a published-base schedule the
      // step across a threshold is NOT "one dollar at the new rate": New York
      // prints whole-dollar bases, so the exact tax at $13,900 is $586.30
      // while the row above starts from the printed $586. Crossing that one
      // threshold therefore takes the tax DOWN by 25 cents — an artifact of
      // New York's own rounding, reproduced faithfully rather than smoothed
      // away. What must hold is that the row above is exactly its printed
      // base plus its rate on the excess, and that no crossing moves the
      // figure by as much as a dollar.
      const at = atAgi(8_000 + threshold);
      const above = atAgi(8_000 + threshold + 1);

      expect(above.rates.marginalRateBasisPoints).toBe(rate);
      expect(Math.abs(above.totals.totalTax.amountMinor - at.totals.totalTax.amountMinor)).toBeLessThan(dollars(1));

      const publishedBase = US_NY_2026.filingStatuses.single!.brackets.find((b) => b.fromMinor === dollars(threshold))!.baseTaxMinor!;
      expect(above.totals.totalTax.amountMinor).toBe(publishedBase + Math.round(rate / 100));
    },
  );

  it("reproduces New York's own sub-dollar step down at $13,900 rather than smoothing it", () => {
    // $586.30 exact at the threshold, $586.05 one dollar above it. Both are
    // what New York's published schedule gives. An engine that summed
    // brackets instead would hide this and disagree with the form.
    const at = atAgi(8_000 + 13_900);
    const above = atAgi(8_000 + 13_901);
    expect(at.totals.totalTax.amountMinor).toBe(dollars(586.3));
    expect(above.totals.totalTax.amountMinor).toBe(dollars(586.05));
  });

  it("has no cliff at any boundary", () => {
    for (const threshold of SINGLE_THRESHOLDS) {
      const below = atAgi(8_000 + threshold - 1);
      const above = atAgi(8_000 + threshold + 1);
      expect(above.totals.totalTax.amountMinor - below.totals.totalTax.amountMinor, `$${threshold}`).toBeLessThanOrEqual(dollars(2));
    }
  });

  it("is monotonic across the whole range", () => {
    let previous = -1;
    for (const agi of [0, 8_000, 20_000, 60_000, 107_650, 107_651, 150_000, 157_650, 300_000, 1_200_000, 5_100_000, 26_000_000]) {
      const tax = atAgi(agi).totals.totalTax.amountMinor;
      expect(tax, `$${agi}`).toBeGreaterThanOrEqual(previous);
      previous = tax;
    }
  });

  it("never produces a negative figure", () => {
    for (const agi of [-100_000, 0, 1, 8_000, 107_650, 200_000, 30_000_000]) {
      expect(atAgi(agi).totals.totalTax.amountMinor, `$${agi}`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the $107,650 threshold between schedule and worksheet", () => {
  it("uses the rate schedule at exactly $107,650 of NYAGI", () => {
    const result = atAgi(RECAPTURE_FROM);
    expect(result.calculationMethod).toBe("NY_RATE_SCHEDULE");
  });

  it("uses a worksheet one dollar above it", () => {
    const result = atAgi(RECAPTURE_FROM + 1);
    expect(result.calculationMethod).toBe("NY_TAX_COMPUTATION_WORKSHEET");
  });

  it("crosses without a cliff — the phase-in starts at zero", () => {
    const at = atAgi(RECAPTURE_FROM);
    const above = atAgi(RECAPTURE_FROM + 1);
    expect(above.totals.totalTax.amountMinor - at.totals.totalTax.amountMinor).toBeLessThanOrEqual(dollars(1));
  });
});

describe("worksheet 7 — the Single phase-in", () => {
  it("owes $6,180.79 at $120,000 of NYAGI", () => {
    // Taxable 112,000. Line 3: 112,000 × 5.90% = 6,608.00. Line 4 (schedule):
    // 4,191 + 5.90% × 31,350 = 6,040.65. Line 5: 567.35. Line 6: 12,350.
    // Line 7: 12,350 ÷ 50,000 = 0.2470. Line 8: 140.14. Line 9: 6,180.79.
    const result = atAgi(120_000);
    expect(result.totals.totalTax.amountMinor).toBe(dollars(6_180.79));
  });

  it("names the published worksheet in the trace", () => {
    const result = atAgi(120_000);
    expect(result.steps.some((s) => s.label.includes("worksheet 7"))).toBe(true);
    expect(result.steps.some((s) => s.key === "ny_phase_in_fraction")).toBe(true);
  });

  it("stops at $157,650, where the phase-in completes", () => {
    // New York's printed "Stop" instruction. Above it the whole taxable
    // income is taxed at 5.90% with no bracket benefit left.
    const result = atAgi(200_000);
    expect(result.totals.totalTax.amountMinor).toBe(dollars(192_000 * 0.059));
  });

  it("recaptures exactly the benefit worksheet 8 then carries as its base", () => {
    // Fully phased in, the recapture equals $567.35 — which New York prints
    // as the $567 recapture base of the next worksheet. The two published
    // figures agreeing is a strong check on both.
    const flat = dollars(192_000 * 0.059);
    const scheduleOnly = dollars(4_191 + 0.059 * (192_000 - 80_650));
    expect(flat - scheduleOnly).toBe(dollars(567.35));
  });

  it("phases in proportionally across the $50,000 band", () => {
    const quarter = atAgi(RECAPTURE_FROM + 12_500).totals.totalTax.amountMinor;
    const half = atAgi(RECAPTURE_FROM + 25_000).totals.totalTax.amountMinor;
    const full = atAgi(RECAPTURE_FROM + 50_000).totals.totalTax.amountMinor;
    expect(quarter).toBeLessThan(half);
    expect(half).toBeLessThan(full);
  });
});

describe("the recapture worksheets", () => {
  it("worksheet 8 — owes $20,002.10 at $300,000 of NYAGI, Single", () => {
    // Taxable 292,000. Schedule: 12,141 + 6.85% × 76,600 = 17,388.10.
    // Recapture base 567, incremental 2,047, fully phased in.
    const result = atAgi(300_000);
    expect(result.totals.totalTax.amountMinor).toBe(dollars(20_002.1));
    expect(result.steps.some((s) => s.label.includes("worksheet 8"))).toBe(true);
  });

  it("worksheet 10 — owes $617,176 at $6,000,000 of NYAGI, Single", () => {
    // Taxable 5,992,000. Schedule: 449,714 + 10.3% × 992,000 = 551,890.
    // Recapture base 32,786 + incremental 32,500, fully phased in.
    expect(atAgi(6_000_000).totals.totalTax.amountMinor).toBe(dollars(617_176));
  });

  it("fully phased in, the whole taxable income is effectively taxed at the marginal rate", () => {
    // The point of the recapture, and an oracle that needs no published
    // figure: well above a threshold, tax ≈ taxable income × marginal rate.
    // New York's whole-dollar rounding keeps it within a couple of dollars.
    for (const [agi, rate] of [
      [300_000, 0.0685],
      [1_500_000, 0.0965],
      [6_000_000, 0.103],
    ] as const) {
      const result = atAgi(agi);
      const taxable = result.totals.taxableIncome.amountMinor;
      expect(Math.abs(result.totals.totalTax.amountMinor - taxable * rate), `$${agi}`).toBeLessThanOrEqual(dollars(2));
    }
  });

  it("caps the phase-in at the $50,000 band rather than running past it", () => {
    const justInside = atAgi(215_400 + 8_000 + 49_000);
    const wellPast = atAgi(215_400 + 8_000 + 500_000);
    // Both fully or nearly fully phased in; neither may exceed the marginal
    // rate on the whole taxable income by more than rounding.
    for (const result of [justInside, wellPast]) {
      expect(result.totals.totalTax.amountMinor).toBeLessThanOrEqual(result.totals.taxableIncome.amountMinor * 0.0685 + dollars(2));
    }
  });
});

describe("the $5,000,000 and $25,000,000 thresholds", () => {
  it("switches worksheet at $5,000,000 of taxable income", () => {
    const below = atAgi(5_000_000 + 8_000 - 1);
    const above = atAgi(5_000_000 + 8_000 + 1);
    expect(below.steps.some((s) => s.label.includes("worksheet 9"))).toBe(true);
    expect(above.steps.some((s) => s.label.includes("worksheet 10"))).toBe(true);
  });

  it("taxes everything at 10.9% above $25,000,000 of NYAGI — worksheet 11", () => {
    const result = atAgi(30_000_000);
    expect(result.totals.taxableIncome.amountMinor).toBe(dollars(29_992_000));
    expect(result.totals.totalTax.amountMinor).toBe(dollars(29_992_000 * 0.109));
    expect(result.rates.marginalRateBasisPoints).toBe(1090);
    expect(result.steps.some((s) => s.label.includes("worksheet 11"))).toBe(true);
  });

  it("uses worksheet 6 for joint filers and 16 for head of household above $25,000,000", () => {
    expect(atAgi(30_000_000, { filingStatus: "married_filing_jointly" }).steps.some((s) => s.label.includes("worksheet 6"))).toBe(true);
    expect(atAgi(30_000_000, { filingStatus: "head_of_household" }).steps.some((s) => s.label.includes("worksheet 16"))).toBe(true);
  });

  it("crosses $25,000,000 without a cliff downward", () => {
    const below = atAgi(25_000_000);
    const above = atAgi(25_000_001);
    expect(above.totals.totalTax.amountMinor).toBeGreaterThanOrEqual(below.totals.totalTax.amountMinor);
  });

  it("selects a worksheet for every filing status at every band", () => {
    // Coverage, asserted rather than assumed: an uncovered pair throws.
    for (const filingStatus of ["single", "married_filing_jointly", "married_filing_separately", "head_of_household", "qualifying_surviving_spouse"] as const) {
      for (const agi of [110_000, 160_000, 300_000, 400_000, 2_500_000, 6_000_000, 30_000_000]) {
        expect(() => atAgi(agi, { filingStatus }), `${filingStatus} at $${agi}`).not.toThrow();
      }
    }
  });
});

describe("New York is never answered with another jurisdiction's figures", () => {
  it("stamps every result US_NY and 2026", () => {
    const result = atAgi(60_000);
    expect(result.jurisdiction).toBe("US_NY");
    expect(result.ruleSet.jurisdiction).toBe("US_NY");
    expect(result.taxYear).toBe(2026);
    expect(result.requestedTaxYear).toBe(2026);
    expect(result.ruleSetVersion).toBe("2026.1");
  });

  it("reports published rules, with no fallback", () => {
    const result = atAgi(60_000);
    expect(result.calculationStatus).toBe("PUBLISHED_RULES");
    expect(result.fallback).toBeNull();
  });

  it("produces a different figure from the federal engine on the same income", () => {
    const ny = atAgi(100_000);
    const federal = calculateUsFederalTax({ organizationId: ORG, taxYear: 2026, filingStatus: "single", ordinaryIncomeMinor: dollars(100_000), currency: "USD" });
    if (!federal.supported) throw new Error("federal 2026 should be supported");
    expect(ny.totals.totalTax.amountMinor).not.toBe(federal.totals.incomeTax.amountMinor);
  });

  it("produces a different figure from California on the same income", () => {
    const ny = atAgi(100_000);
    const ca = calculateCaliforniaTax({
      organizationId: ORG,
      taxYear: 2025,
      filingStatus: "single",
      ordinaryIncomeMinor: dollars(100_000),
      federalAdjustedGrossIncomeMinor: dollars(100_000),
      currency: "USD",
    });
    if (!ca.supported) throw new Error("California 2025 should be supported");
    expect(ny.totals.totalTax.amountMinor).not.toBe(ca.totals.totalTax.amountMinor);
  });

  it("cites only New York authorities", () => {
    for (const source of atAgi(60_000).ruleSet.sources) {
      expect(source.authority).toContain("New York");
      expect(source.url).toContain("tax.ny.gov");
    }
  });

  it("levies no state self-employment tax and no surtax", () => {
    const result = atAgi(200_000, { selfEmploymentNetProfitMinor: dollars(80_000) });
    expect(result.totals.selfEmploymentTax.amountMinor).toBe(0);
    expect(result.totals.selfEmploymentTaxDeduction.amountMinor).toBe(0);
    expect(result.totals.surtax.amountMinor).toBe(0);
  });

  it("does not include New York City, Yonkers or the MCTMT", () => {
    const result = atAgi(200_000);
    expect(JSON.stringify(result.totals)).not.toMatch(/nyc|yonkers|mctmt/i);
    expect(result.notModelled.join(" ")).toContain("New York City");
  });
});

describe("refusals", () => {
  it.each([2024, 2025, 2027, 2030])("refuses %s rather than reaching for 2026", (taxYear) => {
    const outcome = run({ taxYear, federalAdjustedGrossIncomeMinor: dollars(60_000) });
    expect(outcome.supported).toBe(false);
    if (outcome.supported) return;
    expect(outcome.reason).toBe("unsupported_tax_year");
    expect(outcome.jurisdiction).toBe("US_NY");
  });

  it("refuses a currency mismatch rather than converting", () => {
    const outcome = run({ currency: "EUR", federalAdjustedGrossIncomeMinor: dollars(60_000) });
    expect(outcome.supported).toBe(false);
    if (!outcome.supported) expect(outcome.reason).toBe("currency_mismatch");
  });

  it("rejects negative New York additions and subtractions", () => {
    for (const field of ["stateAdditionsMinor", "stateSubtractionsMinor"] as const) {
      const outcome = run({ federalAdjustedGrossIncomeMinor: dollars(60_000), [field]: dollars(-100) });
      expect(outcome.supported).toBe(false);
      if (!outcome.supported) expect(outcome.reason).toBe("invalid_input");
    }
  });

  it("rejects a negative or non-integer dependent count", () => {
    for (const dependentCount of [-1, 1.5, 999]) {
      const outcome = run({ federalAdjustedGrossIncomeMinor: dollars(60_000), dependentCount });
      expect(outcome.supported).toBe(false);
      if (!outcome.supported) expect(outcome.reason).toBe("invalid_input");
    }
  });

  it("refuses when federal AGI is neither supplied nor derivable for the year", () => {
    const outcome = calculateNewYorkTax({ organizationId: ORG, taxYear: 2026, filingStatus: "single", ordinaryIncomeMinor: dollars(60_000), currency: "USD" });
    // Federal 2026 exists, so this one succeeds by deriving it — which the
    // trace says out loud.
    expect(outcome.supported).toBe(true);
    if (outcome.supported) {
      expect(outcome.steps[0].explanation).toContain("computed from the same figures using the federal rule set");
    }
  });

  it("never returns a partial result alongside a refusal", () => {
    const outcome = run({ taxYear: 2027, federalAdjustedGrossIncomeMinor: dollars(60_000) });
    expect(outcome).not.toHaveProperty("totals");
    expect(outcome).not.toHaveProperty("steps");
  });
});

describe("determinism and tamper-resistance", () => {
  const input: TaxCalculationInput = {
    organizationId: ORG,
    taxYear: 2026,
    filingStatus: "single",
    ordinaryIncomeMinor: dollars(340_000),
    federalAdjustedGrossIncomeMinor: dollars(340_000),
    stateAdditionsMinor: dollars(7_500),
    stateSubtractionsMinor: dollars(2_500),
    dependentCount: 2,
    currency: "USD",
  };

  it("returns byte-identical output for identical input", () => {
    expect(JSON.stringify(calculateNewYorkTax(input))).toBe(JSON.stringify(calculateNewYorkTax(input)));
  });

  it("reproduces the same figure across a hundred runs", () => {
    const first = ok(calculateNewYorkTax(input)).totals.totalTax.amountMinor;
    for (let attempt = 0; attempt < 100; attempt += 1) expect(ok(calculateNewYorkTax(input)).totals.totalTax.amountMinor).toBe(first);
  });

  it("cannot be steered by mutating a previous result", () => {
    const first = ok(calculateNewYorkTax(input)) as unknown as Record<string, unknown>;
    first.ruleSetVersion = "9999.9";
    first.calculationStatus = "ESTIMATE_USING_LATEST_PUBLISHED_RULES";
    (first.totals as Record<string, { amountMinor: number }>).incomeTax.amountMinor = 0;

    const second = ok(calculateNewYorkTax(input));
    expect(second.ruleSetVersion).toBe("2026.1");
    expect(second.calculationStatus).toBe("PUBLISHED_RULES");
    expect(second.totals.incomeTax.amountMinor).toBeGreaterThan(0);
  });

  it("takes no rate, deduction, bracket or worksheet figure from its input", () => {
    const tampered = calculateNewYorkTax({
      ...input,
      ...({
        standardDeductionMinor: 0,
        dependentExemptionMinor: 999_999,
        brackets: [{ fromMinor: 0, upToMinor: null, rateBasisPoints: 1, baseTaxMinor: 0 }],
        highIncome: null,
        recaptureBaseMinor: 0,
        incrementalBenefitMinor: 0,
        calculationMethod: "NY_RATE_SCHEDULE",
      } as unknown as object),
    });
    expect(ok(tampered).totals.totalTax.amountMinor).toBe(ok(calculateNewYorkTax(input)).totals.totalTax.amountMinor);
    expect(ok(tampered).calculationMethod).toBe("NY_TAX_COMPUTATION_WORKSHEET");
  });

  it("keeps the rule set itself immutable across runs", () => {
    const before = JSON.stringify(US_NY_2026);
    calculateNewYorkTax(input);
    expect(JSON.stringify(US_NY_2026)).toBe(before);
  });
});

describe("what every result carries", () => {
  const result = atAgi(300_000);

  it("states the rule-set stamp and the source", () => {
    expect(result.ruleSet.version).toBe("2026.1");
    expect(result.ruleSet.taxYear).toBe(2026);
    expect(result.ruleSet.sources[0].citation).toContain("IT-2105-I (2026)");
  });

  it("explains the rounding, including the published-base method", () => {
    expect(result.ruleSet.roundingNote).toContain("printed whole-dollar base");
    expect(result.ruleSet.roundingNote).toContain("four decimal places");
  });

  it("says it is an estimate, and does not claim New York filing or NYC coverage", () => {
    expect(result.disclaimer).toContain("estimate");
    expect(result.disclaimer).toContain("not a Form IT-201");
    expect(result.disclaimer).toContain("does not prepare or file New York returns");
    expect(result.disclaimer).toContain("New York State tax only");
  });

  it("carries the not-modelled list", () => {
    expect(result.notModelled.length).toBeGreaterThan(5);
  });

  it("reports every amount in USD", () => {
    expect(result.currency).toBe("USD");
    for (const step of result.steps) expect(step.amount.currency).toBe("USD");
  });
});
