import { describe, expect, it } from "vitest";
import { money } from "@/domain/money/money";
import { calculateCaliforniaTax } from "./us-ca";
import { calculateUsFederalTax } from "./us-federal";
import { applyProgressiveBrackets } from "../calculation/brackets";
import { US_CA_2025 } from "../rules/us-ca-2025";
import type { SupportedTaxCalculation, TaxCalculationInput } from "../tax-engine";

/**
 * The California engine end to end.
 *
 * Every expected figure was computed by hand from the FTB 2025 rate
 * schedules and is stated in dollars in the test name, so a failure says
 * which number moved rather than only that one did.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const dollars = (amount: number) => Math.round(amount * 100);

/** California's standard deduction, so a test can name a TAXABLE income and
 *  let the arithmetic find the AGI that produces it. */
const SINGLE_DEDUCTION = US_CA_2025.filingStatuses.single!.standardDeductionMinor;
const JOINT_DEDUCTION = US_CA_2025.filingStatuses.married_filing_jointly!.standardDeductionMinor;

function run(overrides: Partial<TaxCalculationInput> = {}) {
  return calculateCaliforniaTax({
    organizationId: ORG,
    taxYear: 2025,
    filingStatus: "single",
    ordinaryIncomeMinor: 0,
    federalAdjustedGrossIncomeMinor: 0,
    currency: "USD",
    ...overrides,
  });
}

/** Narrows, and fails loudly if the engine refused when it should not. */
function ok(outcome: ReturnType<typeof run>): SupportedTaxCalculation {
  if (!outcome.supported) throw new Error(`Expected a supported calculation, got ${outcome.reason}: ${outcome.message}`);
  return outcome;
}

/** A run at a given CALIFORNIA TAXABLE income. */
function atTaxable(taxableMinor: number, overrides: Partial<TaxCalculationInput> = {}) {
  const deduction = overrides.filingStatus === "married_filing_jointly" ? JOINT_DEDUCTION : SINGLE_DEDUCTION;
  return ok(run({ federalAdjustedGrossIncomeMinor: taxableMinor + deduction, ...overrides }));
}

describe("the Form 540 pipeline", () => {
  it("starts from federal AGI, not from federal taxable income", () => {
    const result = ok(run({ federalAdjustedGrossIncomeMinor: dollars(100_000) }));
    expect(result.totals.grossIncome.amountMinor).toBe(dollars(100_000));
    expect(result.steps[0].key).toBe("federal_adjusted_gross_income");
  });

  it("applies subtractions and then additions, reaching California AGI", () => {
    const result = ok(
      run({
        federalAdjustedGrossIncomeMinor: dollars(100_000),
        stateSubtractionsMinor: dollars(8_000),
        stateAdditionsMinor: dollars(3_000),
      }),
    );
    // 100,000 − 8,000 + 3,000 = 95,000
    expect(result.totals.adjustedGrossIncome.amountMinor).toBe(dollars(95_000));

    const keys = result.steps.map((step) => step.key);
    expect(keys.indexOf("ca_adjustments_subtractions")).toBeLessThan(keys.indexOf("ca_adjustments_additions"));
  });

  it("leaves California AGI equal to federal AGI when no adjustments are supplied", () => {
    const result = ok(run({ federalAdjustedGrossIncomeMinor: dollars(64_000) }));
    expect(result.totals.adjustedGrossIncome.amountMinor).toBe(dollars(64_000));
    expect(result.steps.some((step) => step.key === "ca_adjustments_additions")).toBe(false);
  });

  it("subtracts California's own standard deduction, not the federal one", () => {
    const result = ok(run({ federalAdjustedGrossIncomeMinor: dollars(100_000) }));
    expect(result.totals.standardDeduction.amountMinor).toBe(dollars(5_706));
    expect(result.totals.taxableIncome.amountMinor).toBe(dollars(100_000) - dollars(5_706));
  });

  it("floors taxable income at zero rather than producing a negative", () => {
    const result = ok(run({ federalAdjustedGrossIncomeMinor: dollars(2_000) }));
    expect(result.totals.taxableIncome.amountMinor).toBe(0);
    expect(result.totals.totalTax.amountMinor).toBe(0);
  });

  it("handles a negative federal AGI, which a large business loss really does produce", () => {
    const result = ok(run({ federalAdjustedGrossIncomeMinor: dollars(-40_000) }));
    expect(result.totals.adjustedGrossIncome.amountMinor).toBe(dollars(-40_000));
    expect(result.totals.taxableIncome.amountMinor).toBe(0);
    expect(result.totals.totalTax.amountMinor).toBe(0);
  });

  it("reports the steps in Form 540 order", () => {
    const keys = ok(
      run({ federalAdjustedGrossIncomeMinor: dollars(100_000), stateSubtractionsMinor: dollars(1_000) }),
    ).steps.map((step) => step.key);

    const expectedOrder = ["federal_adjusted_gross_income", "ca_adjustments_subtractions", "ca_adjusted_gross_income", "ca_standard_deduction", "ca_taxable_income"];
    expect(keys.slice(0, expectedOrder.length)).toEqual(expectedOrder);
    expect(keys[keys.length - 1]).toBe("ca_income_tax");
  });

  it("shows the deduction as a negative amount so the trace reads as a running statement", () => {
    const result = ok(run({ federalAdjustedGrossIncomeMinor: dollars(100_000), stateSubtractionsMinor: dollars(1_000) }));
    expect(result.steps.find((step) => step.key === "ca_standard_deduction")!.amount.amountMinor).toBeLessThan(0);
    expect(result.steps.find((step) => step.key === "ca_adjustments_subtractions")!.amount.amountMinor).toBeLessThan(0);
  });
});

describe("California income tax — Single (Schedule X)", () => {
  it("owes nothing on zero income", () => {
    const result = ok(run());
    expect(result.totals.incomeTax.amountMinor).toBe(0);
    expect(result.totals.totalTax.amountMinor).toBe(0);
    expect(result.rates.effectiveRateBasisPoints).toBeNull();
  });

  it("owes nothing when AGI is below the $5,706 standard deduction", () => {
    expect(ok(run({ federalAdjustedGrossIncomeMinor: dollars(5_706) })).totals.incomeTax.amountMinor).toBe(0);
  });

  it("charges 1% on the first dollar of taxable income", () => {
    // $100 of taxable income at 1% is $1.00 — the lowest California bracket,
    // and a rate no federal bracket has.
    expect(atTaxable(dollars(100)).totals.incomeTax.amountMinor).toBe(dollars(1));
  });

  it("owes $5,209 on $100,000 of AGI, the figure the published Tax Table prints", () => {
    // 100,000 − 5,706 = 94,294 taxable, which is under the $100,000 cap, so
    // FTB requires the TABLE. Row $94,251–$94,350, midpoint $94,300.50:
    // 3,201.97 + 9.3% × 21,576.50 = 5,208.58, printed as $5,209.
    //
    // The published 2025 table prints 5209 in the "1 Or 3" column for that
    // row — this is checked against the verbatim row in
    // `california-tax-table.test.ts`. The rate schedule applied directly to
    // 94,294 would give $5,207.98, which is NOT what a filed Form 540 shows.
    const result = ok(run({ federalAdjustedGrossIncomeMinor: dollars(100_000) }));
    expect(result.calculationMethod).toBe("CA_TAX_TABLE");
    expect(result.totals.incomeTax.amountMinor).toBe(dollars(5_209));
    expect(result.totals.totalTax.amountMinor).toBe(dollars(5_209));
  });

  it("reports 9.3% as the marginal rate there, and an effective rate well below it", () => {
    const result = ok(run({ federalAdjustedGrossIncomeMinor: dollars(100_000) }));
    expect(result.rates.marginalRateBasisPoints).toBe(930);
    // 5,207.98 ÷ 94,294 ≈ 5.52%. The gap between marginal and effective is
    // the whole reason a progressive calculation exists.
    expect(result.rates.effectiveRateBasisPoints).toBe(552);
  });

  it("does not charge the marginal rate on the whole of income", () => {
    const result = ok(run({ federalAdjustedGrossIncomeMinor: dollars(100_000) }));
    expect(result.totals.incomeTax.amountMinor).toBeLessThan(dollars(94_294) * 0.093);
  });
});

describe("California income tax — Married/RDP Filing Jointly (Schedule Y)", () => {
  it("owes $10,415.96 on $200,000 of AGI", () => {
    // 200,000 − 11,412 = 188,588 taxable:
    // 6,403.94 (base at 145,448) + 9.3% × 43,140 = 6,403.94 + 4,012.02.
    const result = ok(run({ filingStatus: "married_filing_jointly", federalAdjustedGrossIncomeMinor: dollars(200_000) }));
    expect(result.totals.incomeTax.amountMinor).toBe(dollars(10_415.96));
  });

  it("taxes a joint couple less than a single filer on the same income", () => {
    const single = ok(run({ federalAdjustedGrossIncomeMinor: dollars(200_000) }));
    const joint = ok(run({ filingStatus: "married_filing_jointly", federalAdjustedGrossIncomeMinor: dollars(200_000) }));
    expect(joint.totals.incomeTax.amountMinor).toBeLessThan(single.totals.incomeTax.amountMinor);
  });

  it("charges a joint couple exactly what two singles on half the income would pay, below the surcharge", () => {
    // A consequence of the schedule being a doubling. It is a strong check
    // on both tables at once, and it would break if a single threshold in
    // either were mistyped.
    const joint = atTaxable(dollars(300_000), { filingStatus: "married_filing_jointly" });
    const single = atTaxable(dollars(150_000));
    expect(joint.totals.incomeTax.amountMinor).toBe(single.totals.incomeTax.amountMinor * 2);
  });
});

describe("Behavioral Health Services Tax", () => {
  it("is not charged at exactly $1,000,000 of taxable income", () => {
    const result = atTaxable(dollars(1_000_000));
    expect(result.totals.surtax.amountMinor).toBe(0);
    expect(result.steps.some((step) => step.key === "ca_behavioral_health_services_tax")).toBe(false);
  });

  it("charges 1 cent on the first dollar above $1,000,000", () => {
    const result = atTaxable(dollars(1_000_001));
    expect(result.totals.surtax.amountMinor).toBe(dollars(0.01));
  });

  it("charges $1,000 on $1,100,000 of taxable income", () => {
    const result = atTaxable(dollars(1_100_000));
    expect(result.totals.surtax.amountMinor).toBe(dollars(1_000));
    // 72,219.84 (base at 742,953) + 12.3% × 357,047 = 116,136.62.
    expect(result.totals.incomeTax.amountMinor).toBe(dollars(116_136.62));
    expect(result.totals.totalTax.amountMinor).toBe(dollars(117_136.62));
  });

  it("is kept out of incomeTax, so the two are separately reportable", () => {
    const result = atTaxable(dollars(1_100_000));
    expect(result.totals.incomeTax.amountMinor + result.totals.surtax.amountMinor).toBe(result.totals.totalTax.amountMinor);
  });

  it("leaves the marginal rate at 12.3%, not 13.3%", () => {
    // The surcharge is a separate line on Form 540. Reporting 13.3% as the
    // bracket would misdescribe the schedule the taxpayer is actually in.
    expect(atTaxable(dollars(1_100_000)).rates.marginalRateBasisPoints).toBe(1230);
  });

  it("is included in the effective rate, because that IS what they pay", () => {
    const result = atTaxable(dollars(1_100_000));
    const expected = Math.round((result.totals.totalTax.amountMinor / result.totals.taxableIncome.amountMinor) * 10_000);
    expect(result.rates.effectiveRateBasisPoints).toBe(expected);
    expect(result.rates.effectiveRateBasisPoints!).toBeGreaterThan(result.rates.marginalRateBasisPoints - 200);
  });

  it("applies at the same $1,000,000 for joint filers — the threshold is not doubled", () => {
    // Unlike the brackets. R&TC § 17043 sets one threshold, and doubling it
    // for couples would exempt a million dollars of income that is taxed.
    expect(atTaxable(dollars(1_000_000), { filingStatus: "married_filing_jointly" }).totals.surtax.amountMinor).toBe(0);
    expect(atTaxable(dollars(1_100_000), { filingStatus: "married_filing_jointly" }).totals.surtax.amountMinor).toBe(dollars(1_000));
  });

  it("names it Behavioral Health Services Tax, the name FTB now uses", () => {
    const step = atTaxable(dollars(1_100_000)).steps.find((s) => s.key === "ca_behavioral_health_services_tax");
    expect(step!.label).toContain("Behavioral Health Services Tax");
    expect(step!.explanation).toContain("fixed in statute");
  });
});

describe("bracket boundaries", () => {
  const SINGLE_THRESHOLDS = [11_079, 26_264, 41_452, 57_542, 72_724, 371_479, 445_771, 742_953];
  const RATE_ABOVE = [200, 400, 600, 800, 930, 1030, 1130, 1230];
  const SINGLE_BRACKETS = US_CA_2025.filingStatuses.single!.brackets;

  it.each(SINGLE_THRESHOLDS.map((threshold, index) => [threshold, RATE_ABOVE[index]] as const))(
    "at $%s the next dollar is taxed at %s basis points under the rate schedule",
    (threshold, rateAbove) => {
      // Asserted against the schedule arithmetic directly rather than through
      // the engine, because the five lowest thresholds sit under $100,000
      // where FTB requires the TABLE — and inside a table row the tax is flat,
      // so the engine correctly no longer exposes a per-dollar step there.
      // The arithmetic itself is unchanged, and this keeps proving it.
      const at = applyProgressiveBrackets(money(dollars(threshold), "USD"), SINGLE_BRACKETS, "USD");
      const above = applyProgressiveBrackets(money(dollars(threshold) + 100, "USD"), SINGLE_BRACKETS, "USD");

      // One extra dollar costs exactly the new rate on that dollar — the
      // definition of a marginal bracket, and the thing a "you're in the X%
      // bracket so you pay X%" calculation gets wrong.
      expect(above.total.amountMinor - at.total.amountMinor).toBe(Math.round(rateAbove / 100));
      expect(above.marginalRateBasisPoints).toBe(rateAbove);
    },
  );

  const ABOVE_TABLE_CAP = [371_479, 445_771, 742_953] as const;
  const ABOVE_TABLE_RATE = [1030, 1130, 1230] as const;

  it.each(ABOVE_TABLE_CAP.map((threshold, index) => [threshold, ABOVE_TABLE_RATE[index]] as const))(
    "through the engine at $%s — above the table cap — the next dollar costs %s basis points",
    (threshold, rateAbove) => {
      const at = atTaxable(dollars(threshold));
      const above = atTaxable(dollars(threshold) + 100);
      expect(at.calculationMethod).toBe("CA_RATE_SCHEDULE");
      expect(above.totals.incomeTax.amountMinor - at.totals.incomeTax.amountMinor).toBe(Math.round(rateAbove / 100));
      expect(above.rates.marginalRateBasisPoints).toBe(rateAbove);
    },
  );

  it("has no cliff at a bracket edge: one more dollar never costs more than a dollar", () => {
    for (const threshold of SINGLE_THRESHOLDS) {
      const below = atTaxable(dollars(threshold) - 100);
      const above = atTaxable(dollars(threshold) + 100);
      expect(above.totals.totalTax.amountMinor - below.totals.totalTax.amountMinor, `$${threshold}`).toBeLessThanOrEqual(dollars(2));
    }
  });

  it("steps only at Tax Table row edges below the cap, and never by more than one row", () => {
    // The table IS a step function — that is not a defect, it is what FTB
    // publishes. What matters is that the step is one row's worth and the
    // tax never falls.
    let previous = 0;
    for (let taxable = 0; taxable <= 100_000; taxable += 37) {
      const tax = atTaxable(dollars(taxable)).totals.totalTax.amountMinor;
      expect(tax, `$${taxable}`).toBeGreaterThanOrEqual(previous);
      // A $100 row at the top rate steps by at most 12.30% × $100 ≈ $13.
      expect(tax - previous, `$${taxable}`).toBeLessThanOrEqual(dollars(13));
      previous = tax;
    }
  });

  it("is monotonic across the whole range, surcharge included", () => {
    let previous = -1;
    for (const taxable of [0, 1_000, 11_079, 26_264, 57_542, 100_000, 371_479, 500_000, 742_953, 999_999, 1_000_000, 1_000_001, 2_000_000]) {
      const tax = atTaxable(dollars(taxable)).totals.totalTax.amountMinor;
      expect(tax, `$${taxable}`).toBeGreaterThanOrEqual(previous);
      previous = tax;
    }
  });

  it("never produces a negative figure", () => {
    for (const agi of [-100_000, 0, 1, 5_706, 50_000, 1_500_000]) {
      const result = ok(run({ federalAdjustedGrossIncomeMinor: dollars(agi) }));
      expect(result.totals.incomeTax.amountMinor, `$${agi}`).toBeGreaterThanOrEqual(0);
      expect(result.totals.surtax.amountMinor, `$${agi}`).toBeGreaterThanOrEqual(0);
      expect(result.totals.totalTax.amountMinor, `$${agi}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("sums the per-bracket trace steps to the reported income tax", () => {
    const result = atTaxable(dollars(1_100_000));
    const summed = result.steps
      .filter((step) => step.key.startsWith("ca_bracket_"))
      .reduce((total, step) => total + step.amount.amountMinor, 0);
    expect(summed).toBe(result.totals.incomeTax.amountMinor);
  });
});

describe("California is never answered with federal figures", () => {
  it("stamps every result US_CA", () => {
    const result = ok(run({ federalAdjustedGrossIncomeMinor: dollars(100_000) }));
    expect(result.jurisdiction).toBe("US_CA");
    expect(result.ruleSet.jurisdiction).toBe("US_CA");
    expect(result.ruleSetVersion).toBe("2025.1");
  });

  it("produces a different figure from the federal engine on the same income", () => {
    const california = ok(run({ federalAdjustedGrossIncomeMinor: dollars(100_000) }));
    const federal = calculateUsFederalTax({
      organizationId: ORG,
      taxYear: 2026,
      filingStatus: "single",
      ordinaryIncomeMinor: dollars(100_000),
      currency: "USD",
    });
    if (!federal.supported) throw new Error("federal 2026 should be supported");
    expect(california.totals.incomeTax.amountMinor).not.toBe(federal.totals.incomeTax.amountMinor);
  });

  it("cites only California authorities", () => {
    const result = ok(run({ federalAdjustedGrossIncomeMinor: dollars(100_000) }));
    expect(result.ruleSet.sources.length).toBeGreaterThan(0);
    for (const source of result.ruleSet.sources) {
      expect(source.authority).not.toMatch(/IRS/);
      expect(source.url).toContain("ca.gov");
    }
  });

  it("refuses an unmodelled California year instead of reaching for a neighbouring one", () => {
    const outcome = run({ taxYear: 2024, federalAdjustedGrossIncomeMinor: dollars(100_000) });
    expect(outcome.supported).toBe(false);
    if (outcome.supported) return;
    expect(outcome.reason).toBe("unsupported_tax_year");
    expect(outcome.jurisdiction).toBe("US_CA");
  });

  it("levies no state self-employment tax, and says so with zeroes rather than silence", () => {
    const result = ok(run({ federalAdjustedGrossIncomeMinor: dollars(200_000), selfEmploymentNetProfitMinor: dollars(80_000) }));
    expect(result.totals.selfEmploymentTax.amountMinor).toBe(0);
    expect(result.totals.selfEmploymentTaxDeduction.amountMinor).toBe(0);
    expect(result.steps.some((step) => step.key.startsWith("se_"))).toBe(false);
  });

  it("ignores W-2 wage fields entirely — they are federal wage-base inputs", () => {
    const without = ok(run({ federalAdjustedGrossIncomeMinor: dollars(150_000) }));
    const with_ = ok(run({ federalAdjustedGrossIncomeMinor: dollars(150_000), w2SocialSecurityWagesMinor: dollars(150_000), w2MedicareWagesMinor: dollars(150_000) }));
    expect(with_.totals.totalTax.amountMinor).toBe(without.totals.totalTax.amountMinor);
  });
});

describe("2026 answers with the latest published rules, and says so", () => {
  const outcome = run({ taxYear: 2026, federalAdjustedGrossIncomeMinor: dollars(100_000) });

  it("produces a figure rather than refusing", () => {
    expect(outcome.supported).toBe(true);
  });

  it("stamps the rules that actually ran — California 2025 — not the year asked about", () => {
    if (!outcome.supported) return;
    expect(outcome.requestedTaxYear).toBe(2026);
    expect(outcome.taxYear).toBe(2025);
    expect(outcome.ruleSetVersion).toBe("2025.1");
    expect(outcome.ruleSet.taxYear).toBe(2025);
  });

  it("marks the result as an estimate under the latest published rules", () => {
    if (!outcome.supported) return;
    expect(outcome.calculationStatus).toBe("ESTIMATE_USING_LATEST_PUBLISHED_RULES");
  });

  it("carries a notice naming both years and what is missing", () => {
    if (!outcome.supported) return;
    expect(outcome.fallback).not.toBeNull();
    expect(outcome.fallback!.requestedTaxYear).toBe(2026);
    expect(outcome.fallback!.ruleSetTaxYear).toBe(2025);
    expect(outcome.fallback!.notice).toContain("2026");
    expect(outcome.fallback!.notice).toContain("2025");
    expect(outcome.fallback!.notice).toContain("not a 2026 filed-return calculation");
    expect(outcome.fallback!.pendingPublication.join(" ")).toMatch(/rate schedule/i);
  });

  it("says it in the disclaimer too, so a caller rendering only that is still honest", () => {
    if (!outcome.supported) return;
    expect(outcome.disclaimer).toContain("have not yet been published");
  });

  it("says it FIRST in the trace, before any figure the substituted rules produced", () => {
    if (!outcome.supported) return;
    expect(outcome.steps[0].key).toBe("ca_rules_year_substituted");
  });

  it("labels the standard deduction with the year it actually comes from", () => {
    if (!outcome.supported) return;
    const step = outcome.steps.find((s) => s.key === "ca_standard_deduction")!;
    expect(step.label).toContain("2025");
    expect(step.explanation).toContain("has not been published");
  });

  it("produces exactly the same figure as an explicit 2025 request on the same inputs", () => {
    const asked2025 = ok(run({ taxYear: 2025, federalAdjustedGrossIncomeMinor: dollars(100_000) }));
    if (!outcome.supported) return;
    expect(outcome.totals.totalTax.amountMinor).toBe(asked2025.totals.totalTax.amountMinor);
    // ...but is NOT presented the same way.
    expect(asked2025.calculationStatus).toBe("PUBLISHED_RULES");
    expect(asked2025.fallback).toBeNull();
  });

  it("does not claim 2026 anywhere in the rule-set stamp", () => {
    if (!outcome.supported) return;
    expect(outcome.ruleSet.effectiveFrom).toBe("2025-01-01");
    expect(outcome.ruleSet.effectiveTo).toBe("2025-12-31");
  });

  it("works for both supported filing statuses", () => {
    for (const filingStatus of ["single", "married_filing_jointly"] as const) {
      const result = run({ taxYear: 2026, filingStatus, federalAdjustedGrossIncomeMinor: dollars(100_000) });
      expect(result.supported).toBe(true);
      if (result.supported) expect(result.calculationStatus).toBe("ESTIMATE_USING_LATEST_PUBLISHED_RULES");
    }
  });

  it("still refuses a currency mismatch — the fallback is about years, not about anything else", () => {
    const result = run({ taxYear: 2026, currency: "EUR", federalAdjustedGrossIncomeMinor: dollars(100_000) });
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reason).toBe("currency_mismatch");
  });

  it("still refuses an unsupported filing status", () => {
    const result = run({ taxYear: 2026, filingStatus: "head_of_household", federalAdjustedGrossIncomeMinor: dollars(100_000) });
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reason).toBe("unsupported_filing_status");
  });
});

describe("refusals", () => {
  it.each(["married_filing_separately", "head_of_household", "qualifying_surviving_spouse"] as const)(
    "refuses %s rather than approximating with a neighbouring schedule",
    (filingStatus) => {
      const outcome = run({ filingStatus, federalAdjustedGrossIncomeMinor: dollars(100_000) });
      expect(outcome.supported).toBe(false);
      if (outcome.supported) return;
      expect(outcome.reason).toBe("unsupported_filing_status");
      expect(outcome.message).toContain("Married/RDP Filing Jointly");
    },
  );

  it("refuses a currency mismatch rather than converting", () => {
    const outcome = run({ currency: "EUR", federalAdjustedGrossIncomeMinor: dollars(100_000) });
    expect(outcome.supported).toBe(false);
    if (outcome.supported) return;
    expect(outcome.reason).toBe("currency_mismatch");
  });

  it("rejects negative California additions, which mean the two columns were swapped", () => {
    const outcome = run({ federalAdjustedGrossIncomeMinor: dollars(100_000), stateAdditionsMinor: dollars(-500) });
    expect(outcome.supported).toBe(false);
    if (outcome.supported) return;
    expect(outcome.reason).toBe("invalid_input");
    expect(outcome.message).toContain("subtractions");
  });

  it("rejects negative California subtractions the same way", () => {
    const outcome = run({ federalAdjustedGrossIncomeMinor: dollars(100_000), stateSubtractionsMinor: dollars(-500) });
    expect(outcome.supported).toBe(false);
    if (outcome.supported) return;
    expect(outcome.reason).toBe("invalid_input");
  });

  it("rejects a non-integer amount", () => {
    const outcome = run({ federalAdjustedGrossIncomeMinor: 100.5 });
    expect(outcome.supported).toBe(false);
    if (!outcome.supported) expect(outcome.reason).toBe("invalid_input");
  });

  it("refuses when federal AGI is neither supplied nor derivable for the year", () => {
    // No federal rule set exists for 2025, so there is no honest federal AGI
    // to start from. Guessing one would corrupt every line below it.
    const outcome = calculateCaliforniaTax({ organizationId: ORG, taxYear: 2025, filingStatus: "single", ordinaryIncomeMinor: dollars(100_000), currency: "USD" });
    expect(outcome.supported).toBe(false);
    if (outcome.supported) return;
    // An input problem, not a publishing one: the fix is to supply the
    // figure, and the message says so.
    expect(outcome.reason).toBe("invalid_input");
    expect(outcome.message).toContain("federal adjusted gross income");
    expect(outcome.message).toContain("Form 1040, line 11");
  });

  it("never returns a partial result alongside a refusal", () => {
    const outcome = run({ taxYear: 2027, federalAdjustedGrossIncomeMinor: dollars(100_000) });
    expect(outcome.supported).toBe(false);
    expect(outcome).not.toHaveProperty("totals");
    expect(outcome).not.toHaveProperty("steps");
  });
});

describe("determinism and tamper-resistance", () => {
  const input: TaxCalculationInput = {
    organizationId: ORG,
    taxYear: 2025,
    filingStatus: "single",
    ordinaryIncomeMinor: dollars(250_000),
    federalAdjustedGrossIncomeMinor: dollars(250_000),
    stateAdditionsMinor: dollars(4_000),
    stateSubtractionsMinor: dollars(9_000),
    currency: "USD",
  };

  it("returns byte-identical output for identical input", () => {
    expect(JSON.stringify(calculateCaliforniaTax(input))).toBe(JSON.stringify(calculateCaliforniaTax(input)));
  });

  it("is just as deterministic for a fallback year, disclosure included", () => {
    const fallbackInput: TaxCalculationInput = { ...input, taxYear: 2026 };
    const first = JSON.stringify(calculateCaliforniaTax(fallbackInput));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(JSON.stringify(calculateCaliforniaTax(fallbackInput))).toBe(first);
    }
    // And the resolution itself is stable: same requested year, same rule-set
    // version, same figure.
    const result = ok(calculateCaliforniaTax(fallbackInput));
    expect(result.requestedTaxYear).toBe(2026);
    expect(result.ruleSetVersion).toBe("2025.1");
  });

  it("is deterministic under the Tax Table too, where the figure is a published row", () => {
    const tableInput: TaxCalculationInput = { ...input, federalAdjustedGrossIncomeMinor: dollars(70_000), stateAdditionsMinor: 0, stateSubtractionsMinor: 0 };
    const first = JSON.stringify(calculateCaliforniaTax(tableInput));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(JSON.stringify(calculateCaliforniaTax(tableInput))).toBe(first);
    }
    expect(ok(calculateCaliforniaTax(tableInput)).calculationMethod).toBe("CA_TAX_TABLE");
  });

  it("reproduces the same figure across a hundred runs", () => {
    const first = ok(calculateCaliforniaTax(input)).totals.totalTax.amountMinor;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(ok(calculateCaliforniaTax(input)).totals.totalTax.amountMinor).toBe(first);
    }
  });

  it("cannot be steered by mutating a previous result — the rules live in the rule set, not the output", () => {
    const first = ok(calculateCaliforniaTax(input));
    const tampered = first as unknown as Record<string, unknown>;
    tampered.ruleSetVersion = "9999.9";
    (tampered.totals as Record<string, { amountMinor: number }>).incomeTax.amountMinor = 0;
    (tampered.rates as Record<string, number>).marginalRateBasisPoints = 0;

    const second = ok(calculateCaliforniaTax(input));
    expect(second.ruleSetVersion).toBe("2025.1");
    expect(second.totals.incomeTax.amountMinor).toBeGreaterThan(0);
    expect(second.rates.marginalRateBasisPoints).toBe(930);
  });

  it("takes no rate or threshold from its input, however the caller dresses one up", () => {
    const withJunk = calculateCaliforniaTax({
      ...input,
      // Fields the type does not have. If any of them reached the
      // calculation, the figure would move.
      ...({ standardDeductionMinor: 0, brackets: [{ fromMinor: 0, upToMinor: null, rateBasisPoints: 1 }], surtaxes: [] } as unknown as object),
    });
    expect(ok(withJunk).totals.totalTax.amountMinor).toBe(ok(calculateCaliforniaTax(input)).totals.totalTax.amountMinor);
  });
});

describe("what every result carries", () => {
  const result = ok(run({ federalAdjustedGrossIncomeMinor: dollars(100_000) }));

  it("states what is not modelled", () => {
    expect(result.notModelled.length).toBeGreaterThan(0);
    expect(result.notModelled.join(" ")).toContain("199A");
  });

  it("says it is an estimate and not a return, and does not claim California filing", () => {
    expect(result.disclaimer).toContain("estimate");
    expect(result.disclaimer).toContain("does not prepare or file");
    expect(result.disclaimer).not.toMatch(/\bfiles?\b(?! California)/);
  });

  it("carries the rounding note, including the Tax Table caveat below $100,000", () => {
    expect(result.ruleSet.roundingNote).toContain("Tax Table");
  });

  it("stamps the rule set so a later correction cannot restate it", () => {
    expect(result.ruleSet.version).toBe("2025.1");
    expect(result.ruleSet.effectiveFrom).toBe("2025-01-01");
    expect(result.ruleSet.effectiveTo).toBe("2025-12-31");
  });

  it("reports every amount in USD", () => {
    expect(result.currency).toBe("USD");
    for (const step of result.steps) expect(step.amount.currency).toBe("USD");
  });
});
