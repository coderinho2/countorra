import { calculateCaliforniaTax } from "../engines/us-ca";
import { calculateArizonaTax } from "../engines/us-az";
import { calculateFloridaTax } from "../engines/us-fl";
import { calculateNewYorkTax } from "../engines/us-ny";
import { calculateTexasTax } from "../engines/us-tx";
import { calculateUsFederalTax } from "../engines/us-federal";
import type { TaxCalculationInput, TaxCalculationOutcome, TaxEngine } from "../tax-engine";

/**
 * US FEDERAL — IMPLEMENTED for tax year 2026.
 *
 * This module used to throw on every call, deliberately, because encoding tax
 * rules without a verified research pass would have meant silently producing
 * wrong numbers. That pass has now been done for 2026: every figure in
 * `rules/us-federal-2026.ts` is transcribed from IRS Rev. Proc. 2025-32 and
 * IRS Topic 751, and the bracket table is self-checked against the base
 * amounts the same Revenue Procedure publishes.
 *
 * WHAT IS AND IS NOT COVERED
 *
 *   Covered: ordinary income tax for all five filing statuses — Single,
 *   Married Filing Jointly, Married Filing Separately, Head of Household and
 *   Qualifying Surviving Spouse — the 2026 standard deduction, the seven
 *   progressive brackets, and self-employment tax on Schedule C net profit
 *   including the deductible half and the Additional Medicare Tax.
 *
 *   CALCULATED, NOT QUALIFIED: the engine computes tax under whichever status
 *   it is given. Whether the taxpayer may use that status — head of household
 *   and qualifying surviving spouse have qualification tests, and a separate
 *   filer loses the standard deduction if the spouse itemizes — is not
 *   decided anywhere in this module.
 *
 *   Not covered: filing-status qualification, itemized deductions, the QBI
 *   deduction, credits, capital-gains rates, AMT, NIIT, and all state tax.
 *   The full list travels on every result as `notModelled`.
 *
 * This is a tax ESTIMATE engine. It is not tax preparation, it does not
 * produce a return, and it does not file anything.
 *
 * STATE ENGINES PLUG IN BESIDE THIS ONE — see `usCaliforniaTaxEngine` below,
 * which is a separate engine over a separate rule set and shares only the
 * bracket arithmetic and the trace shape.
 */
export const usFederalTaxEngine: TaxEngine = {
  jurisdiction: "US_FEDERAL",
  calculate(input: TaxCalculationInput): TaxCalculationOutcome {
    return calculateUsFederalTax(input);
  },
};

/**
 * CALIFORNIA — a jurisdiction of its own, never a variant of the federal one.
 *
 * Registered under `US_CA`, which means `getTaxEngine("US_CA")` returns THIS
 * and `getTaxEngine("US_FEDERAL")` returns the federal engine. There is no
 * code path on which a California request is answered with federal figures:
 * the two engines share `applyProgressiveBrackets` and the trace types, and
 * nothing else.
 *
 * WHAT IS AND IS NOT COVERED
 *
 *   Covered: California income tax for Single and Married/RDP Filing Jointly
 *   for tax year 2025 — federal AGI through California adjustments, the
 *   California standard deduction, the nine-rate schedule, and the
 *   Behavioral Health Services Tax above $1,000,000 of taxable income.
 *
 *   Refused, with the reasons named: tax year 2026, whose rate schedules the
 *   Franchise Tax Board has not yet published; every other filing status;
 *   and every other state.
 *
 * State Disability Insurance is NOT here. It is payroll withholding, and
 * `calculateCaliforniaSdi` is its own entry point — including for 2026,
 * whose SDI rate EDD has published even though FTB's schedules are pending.
 */
export const usCaliforniaTaxEngine: TaxEngine = {
  jurisdiction: "US_CA",
  calculate(input: TaxCalculationInput): TaxCalculationOutcome {
    return calculateCaliforniaTax(input);
  },
};

/**
 * NEW YORK STATE — a jurisdiction of its own, and only the STATE tax.
 *
 * WHAT IS AND IS NOT COVERED
 *
 *   Covered: New York State personal income tax for tax year 2026, for all
 *   five filing statuses, from federal AGI through New York additions and
 *   subtractions, the New York standard deduction, the $1,000-per-dependent
 *   exemption, the published rate schedules, and — above $107,650 of New York
 *   adjusted gross income — the sixteen published tax computation worksheets
 *   that recapture the lower brackets.
 *
 *   NOT covered, and deliberately: New York City resident tax, Yonkers, and
 *   the MCTMT. Those are separate taxes on separate bases. NYC in particular
 *   would be registered as its own jurisdiction rather than folded in here,
 *   so that a New York State figure can never quietly include or exclude it.
 *
 *   Also not covered: nonresident and part-year returns (Form IT-203). This
 *   models full-year residents only.
 */
export const usNewYorkTaxEngine: TaxEngine = {
  jurisdiction: "US_NY",
  calculate(input: TaxCalculationInput): TaxCalculationOutcome {
    return calculateNewYorkTax(input);
  },
};

/**
 * FLORIDA — registered precisely because there is no tax to compute.
 *
 * Florida levies no individual personal income tax, and that is a first-class
 * answer rather than an absence. Leaving Florida unregistered would make a
 * Florida workspace indistinguishable from a state nobody has modelled, and
 * the difference matters: one is "we know, and it is zero", the other is "we
 * don't know". The engine returns $0 with `NO_INDIVIDUAL_INCOME_TAX` and the
 * constitutional basis in its trace.
 *
 * STATE INDIVIDUAL INCOME TAX ONLY. Florida corporate income/franchise tax,
 * sales and use tax, documentary stamp tax and reemployment tax are real
 * Florida taxes, none of them modelled anywhere in Countorra, and none of
 * them addressed by a $0 result here.
 */
export const usFloridaTaxEngine: TaxEngine = {
  jurisdiction: "US_FL",
  calculate(input: TaxCalculationInput): TaxCalculationOutcome {
    return calculateFloridaTax(input);
  },
};

/**
 * TEXAS — the same $0 as Florida, reached independently.
 *
 * Texas levies no individual personal income tax because Article VIII,
 * Section 24-a of the Texas Constitution forbids the legislature from
 * imposing one — a prohibition voters added in November 2019, replacing a
 * section that had merely required a referendum. Different instrument,
 * different date, different sources from Florida's, and this engine shares no
 * rule data with `usFloridaTaxEngine` and never delegates to it.
 *
 * STATE INDIVIDUAL INCOME TAX ONLY. The Texas franchise tax, sales and use
 * tax, locally levied property tax and the rest of what the Comptroller
 * administers are real Texas taxes, none of them modelled anywhere in
 * Countorra, and none addressed by a $0 result here.
 */
export const usTexasTaxEngine: TaxEngine = {
  jurisdiction: "US_TX",
  calculate(input: TaxCalculationInput): TaxCalculationOutcome {
    return calculateTexasTax(input);
  },
};

/**
 * ARIZONA — registered, and currently refusing on purpose.
 *
 * Arizona's 2026 rate is settled: a flat 2.5% of taxable income under
 * A.R.S. § 43-1011(A)(9). Its 2026 STANDARD DEDUCTION is not — § 43-1041(H)
 * leaves the annual inflation adjustment to the Department of Revenue, and
 * that publication could not be reached. Without a standard deduction there
 * is no Arizona taxable income for the rate to apply to.
 *
 * So the engine returns `rules_not_published` naming exactly what is missing,
 * and `resolve-arizona.ts` carries an EMPTY fallback policy: no Arizona
 * source instructs filers to use a prior year, so nothing here substitutes
 * one. Registering the jurisdiction is still worth it — "we know, and we are
 * waiting on this specific figure" is a far better answer than silence.
 */
export const usArizonaTaxEngine: TaxEngine = {
  jurisdiction: "US_AZ",
  calculate(input: TaxCalculationInput): TaxCalculationOutcome {
    return calculateArizonaTax(input);
  },
};
