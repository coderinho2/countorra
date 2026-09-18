import { describe, expect, it } from "vitest";
import { calculateUsFederalTax } from "./us-federal";
import type { SupportedTaxCalculation, TaxCalculationInput } from "../tax-engine";

/**
 * Self-employment tax when the taxpayer ALSO has W-2 wages.
 *
 * THE BUG THESE GUARD
 *
 * The engine originally treated Schedule C profit as the only income bearing
 * Social Security and Medicare tax. That is right for a pure freelancer and
 * wrong for the very common case of a job plus a side business — and wrong
 * in the expensive direction, because the wage base and the Additional
 * Medicare threshold are both consumed by wages FIRST.
 *
 * Every figure below was computed by hand from the 2026 rules and the IRS
 * methodology:
 *
 *   Social Security — Schedule SE: the wage base applies to wages and
 *   self-employment earnings COMBINED; multiply the smaller of net earnings
 *   or the remaining base by 12.4%.
 *
 *   Additional Medicare — IRS Topic 560: reduce the filing-status threshold
 *   by Medicare wages received (not below zero), then charge 0.9% on
 *   self-employment income above what remains.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const dollars = (amount: number) => Math.round(amount * 100);

const WAGE_BASE = 184_500;
const SINGLE_THRESHOLD = 200_000;
const MFJ_THRESHOLD = 250_000;

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

function ok(outcome: ReturnType<typeof run>): SupportedTaxCalculation {
  if (!outcome.supported) throw new Error(`Expected a supported calculation, got ${outcome.reason}: ${outcome.message}`);
  return outcome;
}

const seTax = (overrides: Partial<TaxCalculationInput>) => ok(run(overrides)).totals.selfEmploymentTax.amountMinor;

describe("1 — Schedule C only, no wages", () => {
  it("$100,000 profit → $14,129.55, the whole wage base available", () => {
    // 92.35% × 100,000 = 92,350 net earnings, all within the base.
    //   12.4% × 92,350 = 11,451.40 + 2.9% × 92,350 = 2,678.15
    expect(seTax({ selfEmploymentNetProfitMinor: dollars(100_000) })).toBe(dollars(14_129.55));
  });

  it("behaves identically whether wages are omitted or explicitly zero", () => {
    // Backwards compatibility: every existing caller passes neither field.
    const omitted = seTax({ selfEmploymentNetProfitMinor: dollars(100_000) });
    const explicit = seTax({ selfEmploymentNetProfitMinor: dollars(100_000), w2SocialSecurityWagesMinor: 0, w2MedicareWagesMinor: 0 });
    expect(omitted).toBe(explicit);
  });
});

describe("2 — W-2 wages only, no self-employment", () => {
  it("owes no self-employment tax at all", () => {
    // Payroll tax on wages is withheld by the employer; none of it is SE tax.
    const result = ok(run({ ordinaryIncomeMinor: dollars(150_000), w2SocialSecurityWagesMinor: dollars(150_000) }));
    expect(result.totals.selfEmploymentTax.amountMinor).toBe(0);
    expect(result.totals.selfEmploymentTaxDeduction.amountMinor).toBe(0);
  });

  it("still taxes the wages as ordinary income", () => {
    const result = ok(run({ ordinaryIncomeMinor: dollars(100_000), w2SocialSecurityWagesMinor: dollars(100_000) }));
    // Unchanged from the no-wages case: these fields are payroll-tax inputs,
    // not extra income. Double-counting them would be its own bug.
    expect(result.totals.taxableIncome.amountMinor).toBe(dollars(83_900));
    expect(result.totals.incomeTax.amountMinor).toBe(dollars(13_170));
  });
});

describe("3 — wages below the base, plus Schedule C", () => {
  it("$100,000 wages + $100,000 profit → $13,156.15, not $14,129.55", () => {
    //   Remaining base 184,500 − 100,000 = 84,500
    //   Social Security 12.4% × 84,500 (capped) = 10,478.00
    //   Medicare        2.9%  × 92,350          =  2,678.15
    //   Additional Medicare: 200,000 − 100,000 = 100,000 left; 92,350 is under it.
    expect(seTax({ selfEmploymentNetProfitMinor: dollars(100_000), w2SocialSecurityWagesMinor: dollars(100_000) })).toBe(dollars(13_156.15));
  });

  it("is strictly less than ignoring the wages would give", () => {
    // The correction itself: $973.40 the taxpayer does not owe.
    const withWages = seTax({ selfEmploymentNetProfitMinor: dollars(100_000), w2SocialSecurityWagesMinor: dollars(100_000) });
    const ignoringWages = seTax({ selfEmploymentNetProfitMinor: dollars(100_000) });
    expect(withWages).toBeLessThan(ignoringWages);
    expect(ignoringWages - withWages).toBe(dollars(973.4));
  });

  it("deducts half of the Social Security and Medicare portions", () => {
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(100_000), w2SocialSecurityWagesMinor: dollars(100_000) }));
    expect(result.totals.selfEmploymentTaxDeduction.amountMinor).toBe(dollars(6_578.08));
  });
});

describe("4 — wages at or above the base, plus Schedule C", () => {
  it("$200,000 wages + $50,000 profit → NO Social Security portion", () => {
    //   Remaining base max(0, 184,500 − 200,000) = 0 → Social Security 0
    //   Medicare 2.9% × 46,175 = 1,339.08
    //   Additional Medicare: threshold fully consumed → 0.9% × 46,175 = 415.58
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(50_000), w2SocialSecurityWagesMinor: dollars(200_000) }));

    expect(result.totals.selfEmploymentTax.amountMinor).toBe(dollars(1_754.66));
    const ssStep = result.steps.find((s) => s.key === "se_social_security")!;
    expect(ssStep.amount.amountMinor).toBe(0);
    expect(ssStep.explanation).toMatch(/No self-employment earnings are subject/i);
  });

  it("would have over-charged by $5,725.70 before the fix", () => {
    // 12.4% × 46,175 charged on earnings the wage base had already covered.
    const correct = seTax({ selfEmploymentNetProfitMinor: dollars(50_000), w2SocialSecurityWagesMinor: dollars(200_000) });
    const ignoringWages = seTax({ selfEmploymentNetProfitMinor: dollars(50_000) });
    expect(ignoringWages - correct).toBe(dollars(5_725.7) - dollars(415.58));
  });

  it("still deducts half of the Medicare portion, with no Social Security to halve", () => {
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(50_000), w2SocialSecurityWagesMinor: dollars(200_000) }));
    expect(result.totals.selfEmploymentTaxDeduction.amountMinor).toBe(dollars(669.54));
  });
});

describe("5 — wages partially consuming the base", () => {
  it("$150,000 wages + $60,000 profit → $5,933.58", () => {
    //   Remaining base 184,500 − 150,000 = 34,500 → 12.4% × 34,500 = 4,278.00
    //   Medicare 2.9% × 55,410 = 1,606.89
    //   Additional Medicare: 200,000 − 150,000 = 50,000 left; 55,410 − 50,000
    //     = 5,410 → 0.9% = 48.69
    expect(seTax({ selfEmploymentNetProfitMinor: dollars(60_000), w2SocialSecurityWagesMinor: dollars(150_000) })).toBe(dollars(5_933.58));
  });

  it("taxes only the remaining capacity, not the full net earnings", () => {
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(60_000), w2SocialSecurityWagesMinor: dollars(150_000) }));
    expect(result.steps.find((s) => s.key === "se_social_security")!.amount.amountMinor).toBe(dollars(4_278));
    expect(result.steps.find((s) => s.key === "se_wage_base_remaining")!.amount.amountMinor).toBe(dollars(34_500));
  });

  it("never lets remaining capacity go negative", () => {
    for (const wages of [WAGE_BASE, WAGE_BASE + 1, 500_000]) {
      const result = ok(run({ selfEmploymentNetProfitMinor: dollars(50_000), w2SocialSecurityWagesMinor: dollars(wages) }));
      expect(result.steps.find((s) => s.key === "se_wage_base_remaining")!.amount.amountMinor, `${wages}`).toBe(0);
    }
  });
});

describe("6 — Medicare wages below the threshold, plus Schedule C", () => {
  it("applies no Additional Medicare Tax when the combined total stays under", () => {
    // 120,000 wages + 46,175 net earnings = 166,175, under 200,000.
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(50_000), w2MedicareWagesMinor: dollars(120_000) }));
    expect(result.steps.some((s) => s.key === "se_additional_medicare")).toBe(false);
  });

  it("applies it as soon as the COMBINED total crosses, even though neither alone does", () => {
    // 180,000 wages + 46,175 = 226,175. Neither figure alone exceeds
    // 200,000; together they do, and only the excess is charged.
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(50_000), w2MedicareWagesMinor: dollars(180_000) }));
    const additional = result.steps.find((s) => s.key === "se_additional_medicare")!;
    // Remaining threshold 20,000; 46,175 − 20,000 = 26,175 → 0.9% = 235.575
    expect(additional.amount.amountMinor).toBe(dollars(235.58));
  });
});

describe("7 — Medicare wages above the threshold, plus Schedule C", () => {
  it("charges 0.9% on ALL net earnings once wages exhaust the threshold", () => {
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(50_000), w2MedicareWagesMinor: dollars(250_000) }));
    expect(result.steps.find((s) => s.key === "se_additional_medicare")!.amount.amountMinor).toBe(dollars(415.58));
  });

  it("says plainly that the wage-side Additional Medicare Tax is not included", () => {
    // Real and owed, but withheld by the employer and not self-employment
    // tax. Folding it in would misname it and double-count withholding.
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(50_000), w2MedicareWagesMinor: dollars(250_000) }));
    const note = result.steps.find((s) => s.key === "additional_medicare_on_wages_excluded");
    expect(note).toBeDefined();
    expect(note!.explanation).toMatch(/employers withhold/i);
  });
});

describe("8 — the MFJ threshold is $250,000", () => {
  it("$240,000 wages + $50,000 profit costs a joint filer less than a single one", () => {
    const joint = seTax({
      filingStatus: "married_filing_jointly",
      selfEmploymentNetProfitMinor: dollars(50_000),
      w2SocialSecurityWagesMinor: dollars(184_500),
      w2MedicareWagesMinor: dollars(240_000),
    });
    const single = seTax({
      selfEmploymentNetProfitMinor: dollars(50_000),
      w2SocialSecurityWagesMinor: dollars(184_500),
      w2MedicareWagesMinor: dollars(240_000),
    });

    //   Joint:  250,000 − 240,000 = 10,000 left → (46,175 − 10,000) × 0.9% = 325.58
    //   Single: 200,000 − 240,000 = 0 left      →  46,175           × 0.9% = 415.58
    expect(joint).toBe(dollars(1_339.08) + dollars(325.58));
    expect(single).toBe(dollars(1_339.08) + dollars(415.58));
    expect(joint).toBeLessThan(single);
  });

  it("applies no Additional Medicare Tax to a joint filer under $250,000 combined", () => {
    const result = ok(
      run({ filingStatus: "married_filing_jointly", selfEmploymentNetProfitMinor: dollars(50_000), w2MedicareWagesMinor: dollars(200_000) }),
    );
    // 200,000 + 46,175 = 246,175, still under the joint threshold.
    expect(result.steps.some((s) => s.key === "se_additional_medicare")).toBe(false);
  });
});

describe("9 — box 3 and box 5 are different numbers", () => {
  it("uses each for its own purpose when both are given", () => {
    // The realistic high earner: the employer caps box 3 at the wage base
    // while box 5 reports everything.
    const result = ok(
      run({ selfEmploymentNetProfitMinor: dollars(50_000), w2SocialSecurityWagesMinor: dollars(WAGE_BASE), w2MedicareWagesMinor: dollars(250_000) }),
    );

    expect(result.steps.find((s) => s.key === "se_social_security")!.amount.amountMinor).toBe(0);
    expect(result.steps.find((s) => s.key === "se_additional_medicare")!.amount.amountMinor).toBe(dollars(415.58));
  });

  it("infers Medicare wages from Social Security wages when box 5 is absent, and says so", () => {
    // Defaulting to zero would hand the whole threshold to self-employment
    // income and understate the tax.
    const inferred = ok(run({ selfEmploymentNetProfitMinor: dollars(50_000), w2SocialSecurityWagesMinor: dollars(190_000) }));
    const explicit = ok(
      run({ selfEmploymentNetProfitMinor: dollars(50_000), w2SocialSecurityWagesMinor: dollars(190_000), w2MedicareWagesMinor: dollars(190_000) }),
    );

    expect(inferred.totals.selfEmploymentTax.amountMinor).toBe(explicit.totals.selfEmploymentTax.amountMinor);
    expect(inferred.steps.some((s) => s.key === "se_medicare_wages_inferred")).toBe(true);
    expect(explicit.steps.some((s) => s.key === "se_medicare_wages_inferred")).toBe(false);
  });

  it("refuses box 5 below box 3, which means the two were swapped", () => {
    const outcome = run({
      selfEmploymentNetProfitMinor: dollars(50_000),
      w2SocialSecurityWagesMinor: dollars(150_000),
      w2MedicareWagesMinor: dollars(100_000),
    });
    expect(outcome.supported).toBe(false);
    if (!outcome.supported) {
      expect(outcome.reason).toBe("invalid_input");
      expect(outcome.message).toMatch(/box 5.*can't be less than.*box 3/i);
    }
  });

  it("refuses negative wages", () => {
    for (const field of ["w2SocialSecurityWagesMinor", "w2MedicareWagesMinor"] as const) {
      const outcome = run({ selfEmploymentNetProfitMinor: dollars(50_000), [field]: dollars(-1) });
      expect(outcome.supported, field).toBe(false);
      if (!outcome.supported) expect(outcome.reason, field).toBe("invalid_input");
    }
  });
});

describe("10 — zero or negative Schedule C profit", () => {
  it.each([0, -1, -50_000])("charges no self-employment tax on profit of %s, even with wages", (profit) => {
    const result = ok(run({ ordinaryIncomeMinor: dollars(200_000), selfEmploymentNetProfitMinor: dollars(profit), w2SocialSecurityWagesMinor: dollars(200_000) }));
    expect(result.totals.selfEmploymentTax.amountMinor).toBe(0);
  });

  it("does not let a loss reduce the Additional Medicare Tax", () => {
    // IRS Topic 560: "Don't consider a self-employment loss for purposes of
    // this tax." A loss must not create a credit against the wage side.
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(-100_000), w2MedicareWagesMinor: dollars(300_000) }));
    expect(result.totals.selfEmploymentTax.amountMinor).toBe(0);
    expect(result.totals.selfEmploymentTax.amountMinor).toBeGreaterThanOrEqual(0);
  });

  it("still charges nothing below the $400 net earnings cliff, wages or not", () => {
    expect(seTax({ selfEmploymentNetProfitMinor: dollars(433), w2SocialSecurityWagesMinor: dollars(100_000) })).toBe(0);
    expect(seTax({ selfEmploymentNetProfitMinor: dollars(434), w2SocialSecurityWagesMinor: dollars(100_000) })).toBeGreaterThan(0);
  });
});

describe("11 — the wage-base boundary exactly", () => {
  it("leaves nothing at exactly $184,500 of wages", () => {
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(50_000), w2SocialSecurityWagesMinor: dollars(WAGE_BASE) }));
    expect(result.steps.find((s) => s.key === "se_social_security")!.amount.amountMinor).toBe(0);
  });

  it("leaves exactly $100 of capacity at $184,400 of wages", () => {
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(50_000), w2SocialSecurityWagesMinor: dollars(WAGE_BASE - 100) }));
    // 12.4% × 100 = 12.40
    expect(result.steps.find((s) => s.key === "se_social_security")!.amount.amountMinor).toBe(dollars(12.4));
  });

  it("is continuous across the boundary — one dollar of wages never costs more than 12.4 cents of SE tax", () => {
    let previous: number | null = null;
    for (const wages of [WAGE_BASE - 2, WAGE_BASE - 1, WAGE_BASE, WAGE_BASE + 1]) {
      const tax = seTax({ selfEmploymentNetProfitMinor: dollars(50_000), w2SocialSecurityWagesMinor: dollars(wages) });
      if (previous !== null) {
        expect(tax, `${wages}`).toBeLessThanOrEqual(previous);
        // One more dollar of wages removes at most one dollar of wage-base
        // capacity, which is at most 12.4 cents of Social Security tax.
        expect(previous - tax, `${wages}`).toBeLessThanOrEqual(dollars(0.124) + 1);
      }
      previous = tax;
    }
  });

  it("is monotonic: more wages never increase self-employment tax", () => {
    // More wages can only consume more of the base and more of the
    // threshold. The Additional Medicare Tax pushes the other way, so this
    // checks the combined figure never rises through the wage-base range.
    let previous = Number.POSITIVE_INFINITY;
    for (let wages = 0; wages <= WAGE_BASE; wages += 5_000) {
      const tax = seTax({ selfEmploymentNetProfitMinor: dollars(40_000), w2SocialSecurityWagesMinor: dollars(wages) });
      expect(tax, `$${wages}`).toBeLessThanOrEqual(previous);
      previous = tax;
    }
  });
});

describe("12 — the Additional Medicare threshold boundary exactly", () => {
  it("leaves nothing at exactly $200,000 of Medicare wages (Single)", () => {
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(50_000), w2MedicareWagesMinor: dollars(SINGLE_THRESHOLD) }));
    expect(result.steps.find((s) => s.key === "se_additional_medicare_threshold")!.amount.amountMinor).toBe(0);
    // All net earnings charged: 0.9% × 46,175
    expect(result.steps.find((s) => s.key === "se_additional_medicare")!.amount.amountMinor).toBe(dollars(415.58));
  });

  it("leaves exactly $1,000 at $199,000 of Medicare wages", () => {
    const result = ok(run({ selfEmploymentNetProfitMinor: dollars(50_000), w2MedicareWagesMinor: dollars(SINGLE_THRESHOLD - 1_000) }));
    // (46,175 − 1,000) × 0.9% = 406.575
    expect(result.steps.find((s) => s.key === "se_additional_medicare")!.amount.amountMinor).toBe(dollars(406.58));
  });

  it("leaves nothing at exactly $250,000 for a joint filer", () => {
    const result = ok(
      run({ filingStatus: "married_filing_jointly", selfEmploymentNetProfitMinor: dollars(50_000), w2MedicareWagesMinor: dollars(MFJ_THRESHOLD) }),
    );
    expect(result.steps.find((s) => s.key === "se_additional_medicare")!.amount.amountMinor).toBe(dollars(415.58));
  });

  it("charges nothing when net earnings exactly fill the remaining threshold", () => {
    // Remaining threshold 46,175; net earnings 46,175. Nothing is "above" it.
    const result = ok(
      run({ selfEmploymentNetProfitMinor: dollars(50_000), w2MedicareWagesMinor: dollars(SINGLE_THRESHOLD - 46_175) }),
    );
    expect(result.steps.some((s) => s.key === "se_additional_medicare")).toBe(false);
  });
});

describe("reproducibility is preserved", () => {
  it("returns identical results for identical inputs including wages", () => {
    const input: Partial<TaxCalculationInput> = {
      ordinaryIncomeMinor: dollars(150_000),
      selfEmploymentNetProfitMinor: dollars(67_890.12),
      w2SocialSecurityWagesMinor: dollars(150_000),
      w2MedicareWagesMinor: dollars(155_000),
      filingStatus: "married_filing_jointly",
    };
    expect(JSON.stringify(run(input))).toBe(JSON.stringify(run(input)));
  });

  it("keeps every total an exact integer in minor units", () => {
    const result = ok(
      run({ ordinaryIncomeMinor: dollars(123_456.78), selfEmploymentNetProfitMinor: dollars(87_654.32), w2SocialSecurityWagesMinor: dollars(99_999.99) }),
    );
    for (const value of Object.values(result.totals)) {
      expect(Number.isInteger(value.amountMinor)).toBe(true);
    }
  });
});
