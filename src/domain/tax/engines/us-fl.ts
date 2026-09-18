import { zero, type Money } from "@/domain/money/money";
import { resolveFloridaRuleSet } from "../rules/resolve-florida";
import type { TaxJurisdiction } from "../rules/types";
import type { TaxCalculationInput, TaxCalculationOutcome, TaxTraceStep } from "../tax-engine";

/**
 * Florida individual state income tax.
 *
 * THERE ISN'T ANY, AND SAYING SO IS THE JOB
 *
 * Florida levies no individual personal income tax. The result is $0 — but
 * "$0 because the law says so" and "$0 because nobody implemented this" look
 * identical in a number, and only one of them is safe to show someone. So the
 * zero is produced from a sourced rule in the rule set, carries
 * `NO_INDIVIDUAL_INCOME_TAX` as its method, and states the constitutional
 * basis in its trace.
 *
 * IT COMPUTES NOTHING, ON PURPOSE
 *
 * No income figure is read, no deduction is applied, no bracket is consulted,
 * and federal figures are never touched. There is nothing to compute: the
 * answer does not depend on income, on filing status, or on anything else the
 * caller supplies. Every total is zero, including gross and adjusted gross
 * income, so that no reader can mistake this for a calculation that happened
 * to come out at zero.
 *
 * WHAT $0 DOES NOT MEAN
 *
 * Not "no Florida tax". Florida levies corporate income tax, sales and use
 * tax, documentary stamp tax and reemployment tax, and Florida residents owe
 * federal income tax in full. `notModelled` lists them and travels on every
 * result, because this is the single most expensive way to misread Florida.
 */
export function calculateFloridaTax(input: TaxCalculationInput): TaxCalculationOutcome {
  const jurisdiction: TaxJurisdiction = "US_FL";

  // Which Florida rules answer this year — decided here, on the server, from
  // the registry alone. Nothing in `input` can select a rule set, and an
  // unregistered year is refused rather than routed to the one that exists.
  const resolution = resolveFloridaRuleSet(input.taxYear);
  if (!resolution.resolved) {
    return {
      supported: false,
      reason: resolution.details ? "rules_not_published" : "unsupported_tax_year",
      message: resolution.message,
      jurisdiction,
      taxYear: input.taxYear,
      ...(resolution.details ? { details: resolution.details } : {}),
    };
  }

  const { ruleSet, fallback } = resolution;

  const noTax = ruleSet.noIndividualIncomeTax ?? null;
  if (!noTax) {
    // Unreachable for the registered rule set, and loud if Florida is ever
    // given brackets without an engine to match: returning $0 from a rule set
    // that no longer says "no tax" would be silently wrong.
    return {
      supported: false,
      reason: "rules_not_published",
      message: "Florida's individual income tax rules for this year are not modelled.",
      jurisdiction,
      taxYear: input.taxYear,
    };
  }

  if (input.currency !== ruleSet.currency) {
    // The amount is zero in any currency, but a zero labelled USD in a EUR
    // workspace is still a mislabelled figure, and every other engine
    // refuses a mismatch. Consistency here is worth more than convenience.
    return {
      supported: false,
      reason: "currency_mismatch",
      message: `Florida figures are reported in ${ruleSet.currency}. This workspace's figures are in ${input.currency}.`,
      jurisdiction,
      taxYear: input.taxYear,
    };
  }

  if (!Number.isInteger(input.taxYear) || input.taxYear < 1900 || input.taxYear > 2200) {
    return { supported: false, reason: "invalid_input", message: "That isn't a usable tax year.", jurisdiction, taxYear: input.taxYear };
  }

  const currency = ruleSet.currency;
  const nothing: Money = zero(currency);

  const steps: TaxTraceStep[] = [
    {
      key: "fl_no_individual_income_tax",
      label: "Florida imposes no individual personal income tax",
      amount: nothing,
      explanation: `${noTax.basis} Filing status and income make no difference to this result, so none were used to produce it.`,
    },
    {
      key: "fl_income_tax",
      label: "Florida individual state income tax",
      amount: nothing,
      explanation:
        "Zero because of Florida's tax law, not because a calculation was skipped. This is Florida INDIVIDUAL INCOME tax only — it says nothing about Florida corporate income tax, sales and use tax, documentary stamp tax or reemployment tax, and nothing about federal tax.",
    },
  ];

  return {
    supported: true,
    jurisdiction,
    taxYear: ruleSet.taxYear,
    requestedTaxYear: resolution.requestedTaxYear,
    calculationStatus: resolution.status,
    calculationMethod: "NO_INDIVIDUAL_INCOME_TAX",
    fallback,
    ruleSetVersion: ruleSet.version,
    currency,
    inputs: {
      filingStatus: input.filingStatus,
      // Echoed as zero rather than as the supplied figures: nothing about the
      // result derives from them, and reflecting them back would suggest
      // otherwise.
      ordinaryIncome: nothing,
      selfEmploymentNetProfit: nothing,
    },
    steps,
    totals: {
      grossIncome: nothing,
      adjustedGrossIncome: nothing,
      standardDeduction: nothing,
      taxableIncome: nothing,
      incomeTax: nothing,
      selfEmploymentTax: nothing,
      selfEmploymentTaxDeduction: nothing,
      surtax: nothing,
      totalTax: nothing,
    },
    rates: {
      // Not "the rate happens to be zero" — there is no rate schedule at all.
      marginalRateBasisPoints: 0,
      // Null rather than 0: an effective rate needs taxable income to divide
      // by, and there is none.
      effectiveRateBasisPoints: null,
    },
    ruleSet: {
      jurisdiction: ruleSet.jurisdiction,
      taxYear: ruleSet.taxYear,
      version: ruleSet.version,
      effectiveFrom: ruleSet.effectiveFrom,
      effectiveTo: ruleSet.effectiveTo,
      roundingNote: ruleSet.roundingNote,
      sources: ruleSet.sources,
    },
    notModelled: ruleSet.notModelled,
    disclaimer:
      "Florida imposes no individual personal income tax, so Florida individual state income tax is $0. That is not the same as owing no Florida tax: Florida levies corporate income tax, sales and use tax and others, and Florida residents owe federal tax in full. This is not tax advice, and Countorra does not prepare or file any Florida return.",
  };
}
