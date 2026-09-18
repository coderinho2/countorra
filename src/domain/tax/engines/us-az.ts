import { resolveArizonaRuleSet } from "../rules/resolve-arizona";
import type { TaxJurisdiction } from "../rules/types";
import type { TaxCalculationInput, TaxCalculationOutcome } from "../tax-engine";

/**
 * Arizona individual income tax.
 *
 * THIS ENGINE CURRENTLY REFUSES, AND THE REFUSAL IS THE CORRECT ANSWER.
 *
 * Arizona's 2026 rate is settled — a flat 2.5% of taxable income under
 * A.R.S. § 43-1011(A)(9), confirmed in force by the Legislature's own Joint
 * Legislative Budget Committee. What is not settled is the 2026 STANDARD
 * DEDUCTION: § 43-1041(H) leaves the annual inflation adjustment to the
 * Department of Revenue, and azdor.gov could not be reached from this
 * environment. No standard deduction means no Arizona taxable income, and a
 * rate with nothing to apply to produces no figure.
 *
 * WHY IT DOES NOT FALL BACK TO 2025
 *
 * California answers 2026 with 2025's rules because FTB's own 2026 Form
 * 540-ES instructs filers to do that. No equivalent Arizona instruction
 * exists, so `resolve-arizona.ts` carries an empty fallback policy. A
 * disclosed substitution that no authority asked for is still a substitution
 * this codebase invented, and for a tax figure that is not good enough.
 *
 * WHY THE COMPUTATION PATH IS NOT WRITTEN YET
 *
 * There is deliberately no federal-AGI-to-taxable-income pipeline in this
 * file. Every line of it would be unreachable and untestable until the
 * Department publishes, and unreachable arithmetic in a tax engine is a
 * liability rather than an asset — it looks verified because it compiles.
 * `us-az-2026.ts` records precisely what to add and when.
 *
 * WHAT AN ARIZONA FIGURE WILL AND WILL NOT BE, WHEN IT ARRIVES
 *
 * Tax BEFORE credits. Arizona's dependent tax credit and its charitable,
 * foster-care, public-school and school-tuition-organisation credits are not
 * modelled, and none of them is small. `notModelled` says so and will travel
 * on every result.
 */
export function calculateArizonaTax(input: TaxCalculationInput): TaxCalculationOutcome {
  const jurisdiction: TaxJurisdiction = "US_AZ";

  // Which Arizona rules answer this year — decided here, on the server, from
  // the registry alone. Nothing in `input` can select a rule set, request a
  // fallback, or supply a figure the Department has not published.
  const resolution = resolveArizonaRuleSet(input.taxYear);

  if (!resolution.resolved) {
    return {
      supported: false,
      // `details` is present only when the year IS modelled but its figures
      // are pending — which is 2026. A year nobody has modelled gets
      // `unsupported_tax_year` instead, and the two must not be conflated:
      // one is "waiting on the Department", the other is "not attempted".
      reason: resolution.details ? "rules_not_published" : "unsupported_tax_year",
      message: resolution.message,
      jurisdiction,
      taxYear: input.taxYear,
      ...(resolution.details ? { details: resolution.details } : {}),
    };
  }

  // Unreachable while 2026 is the only registered Arizona year and it is
  // pending. Kept as a loud refusal rather than a half-written calculation:
  // when `us-az-2026.ts` gains its standard deduction this branch is what
  // must be replaced, and it should fail visibly until it is.
  return {
    supported: false,
    reason: "rules_not_published",
    message:
      `Arizona ${resolution.ruleSet.taxYear} rules are published, but this build does not yet compute Arizona income tax. ` +
      "The rate is a flat 2.5% of Arizona taxable income; the calculation from federal adjusted gross income has not been implemented.",
    jurisdiction,
    taxYear: input.taxYear,
    details: resolution.ruleSet.notModelled,
  };
}
