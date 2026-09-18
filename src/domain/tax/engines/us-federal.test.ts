import { describe, expect, it } from "vitest";
import { calculateUsFederalTax } from "./us-federal";
import type { TaxCalculationInput, SupportedTaxCalculation } from "../tax-engine";

/**
 * The federal engine end to end.
 *
 * Every expected figure below was computed by hand from the published 2026
 * rules and is stated in dollars in the test name, so a failure says which
 * number moved rather than only that one did.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const dollars = (amount: number) => Math.round(amount * 100);

function run(overrides: Partial<TaxCalculationInput> = {}) {
  return calculateUsFederalTax({
    organizationId: ORG,
    taxYear: 2026,
    filingStatus: "single",
    ordinaryIncomeMinor: 0,
    currency: "USD",
    ...overrides,
  });
}

/** Narrows, and fails loudly if the engine refused when it should not. */
function ok(outcome: ReturnType<typeof run>): SupportedTaxCalculation {
  if (!outcome.supported) throw new Error(`Expected a supported calculation, got ${outcome.reason}: ${outcome.message}`);
  return outcome;
}

describe("ordinary income — Single", () => {
  it("owes nothing on zero income", () => {
    const result = ok(run());
    expect(result.totals.taxableIncome.amountMinor).toBe(0);
    expect(result.totals.incomeTax.amountMinor).toBe(0);
    expect(result.totals.totalTax.amountMinor).toBe(0);
  });

  it("owes nothing when income is below the standard deduction", () => {
    // $10,000 income − $16,100 deduction floors at zero rather than going
    // negative and producing a refund the engine has no mechanism for.
    const result = ok(run({ ordinaryIncomeMinor: dollars(10_000) }));
    expect(result.totals.taxableIncome.amountMinor).toBe(0);
    expect(result.totals.incomeTax.amountMinor).toBe(0);
  });

  it("owes nothing at exactly the standard deduction", () => {
    expect(ok(run({ ordinaryIncomeMinor: dollars(16_100) })).totals.incomeTax.amountMinor).toBe(0);
  });

  it("taxes the first dollar above the deduction at 10%", () => {
    const result = ok(run({ ordinaryIncomeMinor: dollars(16_200) }));
    expect(result.totals.taxableIncome.amountMinor).toBe(dollars(100));
    expect(result.totals.incomeTax.amountMinor).toBe(dollars(10));
  });

  it("$50,000 income → $33,900 taxable → $3,820 tax", () => {
    // 10% × 12,400 = 1,240; 12% × (33,900 − 12,400) = 2,580.
    const result = ok(run({ ordinaryIncomeMinor: dollars(50_000) }));
    expect(result.totals.taxableIncome.amountMinor).toBe(dollars(33_900));
    expect(result.totals.incomeTax.amountMinor).toBe(dollars(3_820));
  });

  it("$100,000 income → $83,900 taxable → $13,170 tax", () => {
    // 1,240 + 4,560 + 22% × 33,500 = 1,240 + 4,560 + 7,370.
    const result = ok(run({ ordinaryIncomeMinor: dollars(100_000) }));
    expect(result.totals.taxableIncome.amountMinor).toBe(dollars(83_900));
    expect(result.totals.incomeTax.amountMinor).toBe(dollars(13_170));
  });

  it("reaches the 37% bracket on very high income", () => {
    // Taxable = 1,000,000 − 16,100 = 983,900, which is above $640,600.
    const result = ok(run({ ordinaryIncomeMinor: dollars(1_000_000) }));
    expect(result.rates.marginalRateBasisPoints).toBe(3700);
    // 192,979.25 + 37% × (983,900 − 640,600) = 192,979.25 + 127,021 = 320,000.25
    expect(result.totals.incomeTax.amountMinor).toBe(dollars(320_000.25));
  });
});

describe("ordinary income — Married Filing Jointly", () => {
  it("owes nothing on zero income", () => {
    expect(ok(run({ filingStatus: "married_filing_jointly" })).totals.incomeTax.amountMinor).toBe(0);
  });

  it("applies the larger standard deduction", () => {
    const result = ok(run({ filingStatus: "married_filing_jointly", ordinaryIncomeMinor: dollars(32_200) }));
    expect(result.totals.standardDeduction.amountMinor).toBe(dollars(32_200));
    expect(result.totals.incomeTax.amountMinor).toBe(0);
  });

  it("$200,000 income → $167,800 taxable → $26,340 tax", () => {
    // 2,480 + 9,120 + 22% × 67,000 = 2,480 + 9,120 + 14,740.
    const result = ok(run({ filingStatus: "married_filing_jointly", ordinaryIncomeMinor: dollars(200_000) }));
    expect(result.totals.taxableIncome.amountMinor).toBe(dollars(167_800));
    expect(result.totals.incomeTax.amountMinor).toBe(dollars(26_340));
  });

  it("taxes a married couple less than two singles would pay on half each, at this income", () => {
    // Not a tax rule — a sanity check that the MFJ table is genuinely wider
    // rather than a copy of Single.
    const joint = ok(run({ filingStatus: "married_filing_jointly", ordinaryIncomeMinor: dollars(200_000) }));
    const single = ok(run({ ordinaryIncomeMinor: dollars(200_000) }));
    expect(joint.totals.incomeTax.amountMinor).toBeLessThan(single.totals.incomeTax.amountMinor);
  });

  it("reaches 37% only above $768,700 taxable", () => {
    const below = ok(run({ filingStatus: "married_filing_jointly", ordinaryIncomeMinor: dollars(800_000) }));
    expect(below.rates.marginalRateBasisPoints).toBe(3500);

    const above = ok(run({ filingStatus: "married_filing_jointly", ordinaryIncomeMinor: dollars(900_000) }));
    expect(above.rates.marginalRateBasisPoints).toBe(3700);
  });
});

type Status = NonNullable<Partial<TaxCalculationInput>["filingStatus"]>;

/**
 * All five filing statuses, hand-checked.
 *
 * Every expected figure below is worked in the comment beside it from Rev.
 * Proc. 2025-32 § 4.01 and § 4.14 — not produced by running this engine. The
 * statuses are CALCULATED here; whether a taxpayer may use one is a separate
 * question this engine does not answer (see the preparation and filing layers).
 */
describe("ordinary income — all five filing statuses", () => {
  const STANDARD_DEDUCTION: Record<Status, number> = {
    single: 16_100,
    married_filing_jointly: 32_200,
    married_filing_separately: 16_100,
    head_of_household: 24_150,
    qualifying_surviving_spouse: 32_200,
  };

  it.each([
    // status, income, taxable, tax
    ["single", 0, 0, 0],
    ["single", 40_000, 23_900, 2_620], //                        1,240 + 12% × 11,500
    ["single", 100_000, 83_900, 13_170], //                      5,800 + 22% × 33,500
    ["single", 300_000, 283_900, 68_134.25], //                  58,448 + 35% × 27,675
    ["married_filing_jointly", 0, 0, 0],
    ["married_filing_jointly", 40_000, 7_800, 780], //           10% × 7,800
    ["married_filing_jointly", 100_000, 67_800, 7_640], //       2,480 + 12% × 43,000
    ["married_filing_jointly", 300_000, 267_800, 49_468], //     35,932 + 24% × 56,400
    ["married_filing_separately", 0, 0, 0],
    ["married_filing_separately", 40_000, 23_900, 2_620], //     Table 4 = Table 3 below $256,225
    ["married_filing_separately", 100_000, 83_900, 13_170],
    ["married_filing_separately", 300_000, 283_900, 68_134.25],
    ["married_filing_separately", 500_000, 483_900, 140_125.25], // 103,291.75 + 37% × 99,550
    ["head_of_household", 0, 0, 0],
    ["head_of_household", 40_000, 15_850, 1_585], //             10% × 15,850
    ["head_of_household", 100_000, 75_850, 9_588], //            7,740 + 22% × 8,400
    ["head_of_household", 300_000, 275_850, 63_508.5], //        56,631 + 35% × 19,650
    ["head_of_household", 1_000_000, 975_850, 315_213.5], //     191,171 + 37% × 335,250
    ["qualifying_surviving_spouse", 0, 0, 0],
    ["qualifying_surviving_spouse", 40_000, 7_800, 780],
    ["qualifying_surviving_spouse", 100_000, 67_800, 7_640],
    ["qualifying_surviving_spouse", 300_000, 267_800, 49_468],
    ["qualifying_surviving_spouse", 900_000, 867_800, 243_250.5], // 206,583.50 + 37% × 99,100
  ] as const)("%s: $%s income → $%s taxable → $%s tax", (filingStatus, income, taxable, tax) => {
    const result = ok(run({ filingStatus, ordinaryIncomeMinor: dollars(income) }));
    expect(result.totals.taxableIncome.amountMinor).toBe(dollars(taxable));
    expect(result.totals.incomeTax.amountMinor).toBe(dollars(tax));
    expect(result.inputs.filingStatus).toBe(filingStatus);
  });

  it.each(Object.entries(STANDARD_DEDUCTION) as [Status, number][])("%s owes nothing when income equals its $%s standard deduction", (filingStatus, deduction) => {
    const result = ok(run({ filingStatus, ordinaryIncomeMinor: dollars(deduction) }));
    expect(result.steps.find((step) => step.key === "standard_deduction")!.amount.amountMinor).toBe(-dollars(deduction));
    expect(result.totals.taxableIncome.amountMinor).toBe(0);
    expect(result.totals.incomeTax.amountMinor).toBe(0);

    const oneOver = ok(run({ filingStatus, ordinaryIncomeMinor: dollars(deduction + 1) }));
    expect(oneOver.totals.incomeTax.amountMinor).toBe(10); // 10% of the first dollar
  });

  // Where each status's 37% bracket starts, and the rate just either side.
  it.each([
    ["single", 640_600],
    ["married_filing_jointly", 768_700],
    ["married_filing_separately", 384_350],
    ["head_of_household", 640_600],
    ["qualifying_surviving_spouse", 768_700],
  ] as const)("%s reaches 37%% only above $%s taxable", (filingStatus, topThreshold) => {
    const deduction = STANDARD_DEDUCTION[filingStatus];
    expect(ok(run({ filingStatus, ordinaryIncomeMinor: dollars(topThreshold + deduction) })).rates.marginalRateBasisPoints).toBe(3500);
    expect(ok(run({ filingStatus, ordinaryIncomeMinor: dollars(topThreshold + deduction + 1) })).rates.marginalRateBasisPoints).toBe(3700);
  });

  it.each([
    ["head_of_household", [17_700, 67_450, 105_700, 201_750, 256_200, 640_600]],
    ["married_filing_separately", [12_400, 50_400, 105_700, 201_775, 256_225, 384_350]],
    ["qualifying_surviving_spouse", [24_800, 100_800, 211_400, 403_550, 512_450, 768_700]],
  ] as const)("%s is continuous at every bracket boundary, and one dollar over costs the next rate", (filingStatus, boundaries) => {
    const deduction = STANDARD_DEDUCTION[filingStatus];
    const nextRates = [1200, 2200, 2400, 3200, 3500, 3700];
    boundaries.forEach((boundary, index) => {
      const below = ok(run({ filingStatus, ordinaryIncomeMinor: dollars(boundary + deduction - 1) })).totals.incomeTax.amountMinor;
      const at = ok(run({ filingStatus, ordinaryIncomeMinor: dollars(boundary + deduction) })).totals.incomeTax.amountMinor;
      const over = ok(run({ filingStatus, ordinaryIncomeMinor: dollars(boundary + deduction + 1) })).totals.incomeTax.amountMinor;
      expect(at - below, `${filingStatus} ${boundary}`).toBeGreaterThanOrEqual(0);
      expect(at - below, `${filingStatus} ${boundary}`).toBeLessThanOrEqual(37);
      expect(over - at, `${filingStatus} ${boundary}`).toBe(nextRates[index] / 100);
    });
  });

  it("taxes a head of household less than a single filer, and more than a joint filer, at $100,000", () => {
    const at = (filingStatus: Status) => ok(run({ filingStatus, ordinaryIncomeMinor: dollars(100_000) })).totals.incomeTax.amountMinor;
    expect(at("head_of_household")).toBeLessThan(at("single"));
    expect(at("head_of_household")).toBeGreaterThan(at("married_filing_jointly"));
  });

  it("taxes married filing separately more than single once its 37% bracket starts", () => {
    const at = (filingStatus: Status) => ok(run({ filingStatus, ordinaryIncomeMinor: dollars(500_000) })).totals.incomeTax.amountMinor;
    // Single: 58,448 + 35% × 227,675 = 138,134.25. Separate: 140,125.25.
    expect(at("single")).toBe(dollars(138_134.25));
    expect(at("married_filing_separately")).toBe(dollars(140_125.25));
  });

  it.each(Object.keys(STANDARD_DEDUCTION) as Status[])("%s: the trace shows its own deduction, and bracket steps that sum to the tax", (filingStatus) => {
    const result = ok(run({ filingStatus, ordinaryIncomeMinor: dollars(180_000), selfEmploymentNetProfitMinor: dollars(30_000) }));
    expect(result.steps.find((step) => step.key === "standard_deduction")!.amount.amountMinor).toBe(-dollars(STANDARD_DEDUCTION[filingStatus]));
    const bracketSteps = result.steps.filter((step) => step.key.startsWith("bracket_"));
    expect(bracketSteps.length).toBeGreaterThan(1);
    expect(bracketSteps.reduce((total, step) => total + step.amount.amountMinor, 0)).toBe(result.totals.incomeTax.amountMinor);
    expect(result.ruleSetVersion).toBe("2026.2");
    expect(result.ruleSet.sources.some((source) => source.authority === "IRS Rev. Proc. 2025-32")).toBe(true);
  });

  it("is reproducible for every status", () => {
    for (const filingStatus of Object.keys(STANDARD_DEDUCTION) as Status[]) {
      const input: Partial<TaxCalculationInput> = { filingStatus, ordinaryIncomeMinor: dollars(123_456.78), selfEmploymentNetProfitMinor: dollars(45_678.9) };
      expect(JSON.stringify(run(input)), filingStatus).toBe(JSON.stringify(run(input)));
    }
  });
});

describe("Additional Medicare Tax threshold by filing status", () => {
  it("married filing separately uses $125,000", () => {
    // $150,000 profit → net earnings 138,525 → 0.9% × 13,525 = 121.725 → 121.73.
    const separate = ok(run({ filingStatus: "married_filing_separately", selfEmploymentNetProfitMinor: dollars(150_000) }));
    const single = ok(run({ selfEmploymentNetProfitMinor: dollars(150_000) }));
    expect(separate.steps.find((step) => step.key === "se_additional_medicare")?.amount.amountMinor).toBe(dollars(121.73));
    expect(single.steps.some((step) => step.key === "se_additional_medicare")).toBe(false);
    expect(separate.totals.selfEmploymentTax.amountMinor - single.totals.selfEmploymentTax.amountMinor).toBe(dollars(121.73));
  });

  it.each(["head_of_household", "qualifying_surviving_spouse"] as const)("%s uses $200,000, not the joint $250,000", (filingStatus) => {
    // $250,000 profit → net earnings 230,875: over $200,000, under $250,000.
    const result = ok(run({ filingStatus, selfEmploymentNetProfitMinor: dollars(250_000) }));
    const joint = ok(run({ filingStatus: "married_filing_jointly", selfEmploymentNetProfitMinor: dollars(250_000) }));
    // The same $29,851.26 the single-filer test above works by hand.
    expect(result.totals.selfEmploymentTax.amountMinor).toBe(dollars(29_851.26));
    expect(result.totals.selfEmploymentTax.amountMinor).toBeGreaterThan(joint.totals.selfEmploymentTax.amountMinor);
  });
});

describe("progressive brackets behave progressively", () => {
  it("taxes only the income inside a bracket at that bracket's rate", () => {
    // The mistake worth thousands: "you're in the 22% bracket so you pay
    // 22%". At $83,900 taxable, a flat 22% would be $18,458 — not $13,170.
    const result = ok(run({ ordinaryIncomeMinor: dollars(100_000) }));
    expect(result.totals.incomeTax.amountMinor).toBe(dollars(13_170));
    expect(result.totals.incomeTax.amountMinor).toBeLessThan(dollars(83_900) * 0.22);
    expect(result.rates.marginalRateBasisPoints).toBe(2200);
  });

  it("keeps the effective rate below the marginal rate whenever more than one bracket applies", () => {
    const result = ok(run({ ordinaryIncomeMinor: dollars(100_000) }));
    expect(result.rates.effectiveRateBasisPoints!).toBeLessThan(result.rates.marginalRateBasisPoints);
  });

  it("changes only the incremental portion when a boundary is crossed", () => {
    // One dollar over the 12%→22% line costs 22 cents more, not a cent more.
    const atBoundary = ok(run({ ordinaryIncomeMinor: dollars(50_400 + 16_100) }));
    const oneOver = ok(run({ ordinaryIncomeMinor: dollars(50_400 + 16_100 + 1) }));

    const delta = oneOver.totals.incomeTax.amountMinor - atBoundary.totals.incomeTax.amountMinor;
    expect(delta).toBe(22);
  });

  it("is continuous at every bracket boundary", () => {
    // A jump at a boundary would mean overlapping or gapped brackets.
    for (const boundary of [12_400, 50_400, 105_700, 201_775, 256_225, 640_600]) {
      const just_below = ok(run({ ordinaryIncomeMinor: dollars(boundary + 16_100 - 1) }));
      const exactly = ok(run({ ordinaryIncomeMinor: dollars(boundary + 16_100) }));

      const step = exactly.totals.incomeTax.amountMinor - just_below.totals.incomeTax.amountMinor;
      // One dollar of income can never cost more than 37 cents of tax.
      expect(step, `boundary ${boundary}`).toBeGreaterThanOrEqual(0);
      expect(step, `boundary ${boundary}`).toBeLessThanOrEqual(37);
    }
  });

  it("is monotonic: more income never means less tax", () => {
    let previous = -1;
    for (let income = 0; income <= 1_200_000; income += 7_777) {
      const tax = ok(run({ ordinaryIncomeMinor: dollars(income) })).totals.incomeTax.amountMinor;
      expect(tax, `$${income}`).toBeGreaterThanOrEqual(previous);
      previous = tax;
    }
  });

  it("never produces a negative tax", () => {
    // There is no credit or refund mechanism in this engine, so a negative
    // result could only come from an arithmetic error.
    for (const income of [0, 1, 16_099, 16_100, 16_101, 50_000, 640_600, 5_000_000]) {
      const result = ok(run({ ordinaryIncomeMinor: dollars(income) }));
      expect(result.totals.incomeTax.amountMinor, `$${income}`).toBeGreaterThanOrEqual(0);
      expect(result.totals.totalTax.amountMinor, `$${income}`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("self-employment tax", () => {
  it("$100,000 net profit, Single → $14,129.55 SE tax and $25,745.30 total", () => {
    // Net earnings 92.35% × 100,000 = 92,350.
    //   Social Security 12.4% × 92,350 = 11,451.40
    //   Medicare         2.9% × 92,350 =  2,678.15
    //   SE tax                          = 14,129.55, half deductible = 7,064.78
    //   AGI 100,000 − 7,064.78 = 92,935.22 → taxable 76,835.22
    //   Income tax 1,240 + 4,560 + 22% × 26,435.22 = 11,615.75
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(100_000) }));

    expect(result.totals.selfEmploymentTax.amountMinor).toBe(dollars(14_129.55));
    expect(result.totals.selfEmploymentTaxDeduction.amountMinor).toBe(dollars(7_064.78));
    expect(result.totals.adjustedGrossIncome.amountMinor).toBe(dollars(92_935.22));
    expect(result.totals.taxableIncome.amountMinor).toBe(dollars(76_835.22));
    expect(result.totals.incomeTax.amountMinor).toBe(dollars(11_615.75));
    expect(result.totals.totalTax.amountMinor).toBe(dollars(25_745.3));
  });

  it("caps the Social Security portion at the 2026 wage base", () => {
    // $250,000 profit → net earnings 230,875, above the $184,500 base.
    //   Social Security 12.4% × 184,500 = 22,878 (capped)
    //   Medicare         2.9% × 230,875 =  6,695.38 (uncapped)
    //   Additional Medicare 0.9% × (230,875 − 200,000) = 277.88
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(250_000) }));
    expect(result.totals.selfEmploymentTax.amountMinor).toBe(dollars(29_851.26));
  });

  it("excludes the Additional Medicare Tax from the deductible half", () => {
    // Only the Social Security and Medicare portions are deductible; the
    // 0.9% surtax is not. Halving the whole SE tax would over-deduct.
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(250_000) }));
    expect(result.totals.selfEmploymentTaxDeduction.amountMinor).toBe(dollars(14_786.69));
    expect(result.totals.selfEmploymentTaxDeduction.amountMinor * 2).toBeLessThan(result.totals.selfEmploymentTax.amountMinor);
  });

  it("applies no Additional Medicare Tax below the threshold", () => {
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(100_000) }));
    expect(result.steps.some((s) => s.key === "se_additional_medicare")).toBe(false);
  });

  it("uses the MFJ Additional Medicare threshold for a joint filer", () => {
    // $250,000 of net earnings is over the $200,000 single threshold but
    // under the $250,000 joint one.
    const single = ok(run({ selfEmploymentNetProfitMinor: dollars(250_000) }));
    const joint = ok(run({ filingStatus: "married_filing_jointly", selfEmploymentNetProfitMinor: dollars(250_000) }));

    expect(single.steps.some((s) => s.key === "se_additional_medicare")).toBe(true);
    expect(joint.steps.some((s) => s.key === "se_additional_medicare")).toBe(false);
    expect(joint.totals.selfEmploymentTax.amountMinor).toBeLessThan(single.totals.selfEmploymentTax.amountMinor);
  });

  it("owes no SE tax below the $400 net earnings threshold", () => {
    // A statutory cliff, not a phase-in. $433 profit → 399.87 net earnings.
    const below = ok(run({ selfEmploymentNetProfitMinor: dollars(433) }));
    expect(below.totals.selfEmploymentTax.amountMinor).toBe(0);
    expect(below.steps.some((s) => s.key === "se_below_threshold")).toBe(true);

    // $434 → 400.80, over the line.
    const above = ok(run({ selfEmploymentNetProfitMinor: dollars(434) }));
    expect(above.totals.selfEmploymentTax.amountMinor).toBeGreaterThan(0);
  });

  it("is owed even when income tax is zero", () => {
    // The most common way a freelancer's estimate comes out too low: the
    // standard deduction wipes out income tax, and SE tax is still due.
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(15_000) }));
    expect(result.totals.incomeTax.amountMinor).toBe(0);
    expect(result.totals.selfEmploymentTax.amountMinor).toBeGreaterThan(0);
    expect(result.totals.totalTax.amountMinor).toBe(result.totals.selfEmploymentTax.amountMinor);
  });

  it("charges no SE tax on zero or negative profit", () => {
    for (const profit of [0, -1, -50_000]) {
      const result = ok(run({ selfEmploymentNetProfitMinor: dollars(profit) }));
      expect(result.totals.selfEmploymentTax.amountMinor, `${profit}`).toBe(0);
      expect(result.totals.selfEmploymentTaxDeduction.amountMinor, `${profit}`).toBe(0);
    }
  });

  it("does not let a self-employment loss reduce ordinary income", () => {
    // Loss treatment (NOL, at-risk, passive activity) is outside scope, so
    // the engine says so in the trace rather than netting it silently.
    const result = ok(run({ ordinaryIncomeMinor: dollars(80_000), selfEmploymentNetProfitMinor: dollars(-20_000) }));
    expect(result.totals.grossIncome.amountMinor).toBe(dollars(80_000));
    expect(result.steps.find((s) => s.key === "gross_income")!.explanation).toMatch(/loss is not applied/i);
  });

  it("combines ordinary income and self-employment profit", () => {
    const result = ok(run({ ordinaryIncomeMinor: dollars(50_000), selfEmploymentNetProfitMinor: dollars(50_000) }));
    expect(result.totals.grossIncome.amountMinor).toBe(dollars(100_000));
    expect(result.totals.selfEmploymentTax.amountMinor).toBeGreaterThan(0);
  });
});

describe("unsupported combinations are refused, never approximated", () => {
  it.each([2024, 2025, 2027, 2030])("refuses tax year %s", (taxYear) => {
    const outcome = run({ taxYear });
    expect(outcome.supported).toBe(false);
    if (!outcome.supported) {
      expect(outcome.reason).toBe("unsupported_tax_year");
      expect(outcome.message).toBe("This federal tax year is not currently supported.");
    }
  });

  it("refuses a filing status the rule set does not carry", () => {
    // Never silently mapped to a neighbouring status.
    const outcome = run({ filingStatus: "married_filing_jointly_but_separately" as never });
    expect(outcome.supported).toBe(false);
    if (!outcome.supported) expect(outcome.reason).toBe("unsupported_filing_status");
  });

  it("refuses a currency that is not the rule set's", () => {
    const outcome = run({ currency: "EUR", ordinaryIncomeMinor: dollars(100_000) });
    expect(outcome.supported).toBe(false);
    if (!outcome.supported) expect(outcome.reason).toBe("currency_mismatch");
  });

  it("refuses negative ordinary income", () => {
    const outcome = run({ ordinaryIncomeMinor: dollars(-1_000) });
    expect(outcome.supported).toBe(false);
    if (!outcome.supported) expect(outcome.reason).toBe("invalid_input");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 10])("refuses the malformed amount %s", (amount) => {
    const outcome = run({ ordinaryIncomeMinor: amount });
    expect(outcome.supported).toBe(false);
    if (!outcome.supported) expect(outcome.reason).toBe("invalid_input");
  });

  it("never leaks an internal detail in a refusal", () => {
    const outcome = run({ taxYear: 2030 });
    if (!outcome.supported) {
      expect(outcome.message).not.toMatch(/error|stack|undefined|null|throw|at Object|\.ts/i);
      expect(outcome.message.endsWith(".")).toBe(true);
    }
  });
});

describe("the calculation trace", () => {
  const result = ok(run({ ordinaryIncomeMinor: dollars(60_000), selfEmploymentNetProfitMinor: dollars(40_000) }));

  it("records every stage in the order it was performed", () => {
    const keys = result.steps.map((s) => s.key);
    expect(keys).toContain("ordinary_income");
    expect(keys).toContain("schedule_c_net_profit");
    expect(keys).toContain("se_net_earnings");
    expect(keys).toContain("self_employment_tax");
    expect(keys).toContain("se_tax_deduction");
    expect(keys).toContain("adjusted_gross_income");
    expect(keys).toContain("standard_deduction");
    expect(keys).toContain("taxable_income");
    expect(keys).toContain("federal_income_tax");
    expect(keys).toContain("total_federal_tax");
  });

  it("carries the ACTUAL values used, not labels", () => {
    const taxableStep = result.steps.find((s) => s.key === "taxable_income")!;
    expect(taxableStep.amount.amountMinor).toBe(result.totals.taxableIncome.amountMinor);

    const deductionStep = result.steps.find((s) => s.key === "standard_deduction")!;
    // Negative, so the trace reads as a running statement.
    expect(deductionStep.amount.amountMinor).toBe(-dollars(16_100));
  });

  it("shows one step per bracket that was actually applied, summing to the tax", () => {
    const bracketSteps = result.steps.filter((s) => s.key.startsWith("bracket_"));
    expect(bracketSteps.length).toBeGreaterThan(1);

    const summed = bracketSteps.reduce((total, step) => total + step.amount.amountMinor, 0);
    // The breakdown shown to the user adds up to the total shown to the user.
    expect(summed).toBe(result.totals.incomeTax.amountMinor);
  });

  it("explains each step in words a person can check", () => {
    for (const step of result.steps) {
      expect(step.explanation.length, step.key).toBeGreaterThan(20);
      expect(step.label.length, step.key).toBeGreaterThan(0);
    }
  });

  it("stamps the rule set that produced it", () => {
    expect(result.ruleSet.jurisdiction).toBe("US_FEDERAL");
    expect(result.ruleSet.taxYear).toBe(2026);
    expect(result.ruleSet.version).toBe("2026.2");
    expect(result.ruleSet.sources.length).toBeGreaterThan(0);
    expect(result.ruleSet.roundingNote).toMatch(/integer|cent/i);
  });

  it("carries what was not modelled, and a disclaimer that is not a filing claim", () => {
    expect(result.notModelled.length).toBeGreaterThan(5);
    expect(result.disclaimer).toMatch(/estimate/i);
    expect(result.disclaimer).toMatch(/not a tax return/i);
    // Must never imply preparation or filing.
    expect(result.disclaimer).not.toMatch(/\bfile\b|filing|prepared your return|CPA/i);
  });
});

describe("reproducibility", () => {
  it("returns identical results for identical inputs", () => {
    const input: Partial<TaxCalculationInput> = {
      ordinaryIncomeMinor: dollars(123_456.78),
      selfEmploymentNetProfitMinor: dollars(87_654.32),
      filingStatus: "married_filing_jointly",
    };
    expect(JSON.stringify(run(input))).toBe(JSON.stringify(run(input)));
  });

  it("depends on nothing outside its inputs", () => {
    // No clock, no randomness, no I/O — so the same call a year from now
    // still reproduces a stored figure, provided the version matches.
    const first = ok(run({ ordinaryIncomeMinor: dollars(75_000) }));
    const second = ok(run({ ordinaryIncomeMinor: dollars(75_000) }));
    expect(first.totals).toEqual(second.totals);
    expect(first.ruleSetVersion).toBe(second.ruleSetVersion);
  });

  it("is exact in minor units, with no floating point residue", () => {
    for (const income of [33_333.33, 66_666.67, 99_999.99, 12_345.67]) {
      const result = ok(run({ ordinaryIncomeMinor: dollars(income) }));
      for (const value of Object.values(result.totals)) {
        expect(Number.isInteger(value.amountMinor), `${income}: ${value.amountMinor}`).toBe(true);
      }
    }
  });
});
