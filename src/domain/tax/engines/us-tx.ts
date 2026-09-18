import { zero, type Money } from "@/domain/money/money";
import { resolveTexasRuleSet } from "../rules/resolve-texas";
import type { TaxJurisdiction } from "../rules/types";
import type { TaxCalculationInput, TaxCalculationOutcome, TaxTraceStep } from "../tax-engine";

/**
 * Texas individual state income tax.
 *
 * THERE ISN'T ANY, AND SAYING SO PRECISELY IS THE JOB
 *
 * Texas levies no individual personal income tax, because Article VIII,
 * Section 24-a of the Texas Constitution forbids the legislature from
 * imposing one. The result is $0 — but "$0 because the constitution forbids
 * the tax", "$0 because taxable income came out at zero" and "$0 because
 * nobody implemented this" are three different statements that look identical
 * as a number, and only the first is Texas's answer.
 *
 * So the zero comes from a sourced rule in the Texas rule set, carries
 * `NO_INDIVIDUAL_INCOME_TAX` as its method, and states the constitutional
 * basis in its trace.
 *
 * IT COMPUTES NOTHING, ON PURPOSE
 *
 * No income figure is read, no deduction applied, no exemption applied, no
 * taxable income derived, no bracket consulted, and no federal figure
 * touched. There is nothing to compute: the answer does not depend on income,
 * on filing status, or on anything else a caller supplies. Every total is
 * zero — including gross and adjusted gross income, and the echoed inputs —
 * so that no reader can mistake this for a calculation that happened to come
 * out at zero.
 *
 * SEPARATE FROM FLORIDA, WHICH REACHES THE SAME NUMBER
 *
 * This engine shares no rule data with `us-fl.ts` and never delegates to it.
 * Same result, different jurisdiction, different constitutional basis,
 * different date, different sources, different version — and if Texas ever
 * changes, only Texas changes.
 *
 * WHAT $0 DOES NOT MEAN
 *
 * Not "no Texas tax". The Comptroller administers the franchise tax, sales
 * and use tax and much else; property tax is levied locally; and Texas
 * residents owe federal income tax in full. `notModelled` lists them and
 * travels on every result, because this is the single most expensive way to
 * misread Texas.
 */
export function calculateTexasTax(input: TaxCalculationInput): TaxCalculationOutcome {
  const jurisdiction: TaxJurisdiction = "US_TX";

  // Which Texas rules answer this year — decided here, on the server, from
  // the registry alone. Nothing in `input` can select a rule set, and an
  // unregistered year is refused rather than routed to the one that exists.
  const resolution = resolveTexasRuleSet(input.taxYear);
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
    // Unreachable for the registered rule set, and loud if Texas is ever
    // given brackets without an engine to match: returning $0 from a rule set
    // that no longer says "no tax" would be silently wrong, and Texas's
    // constitutional position is amendable.
    return {
      supported: false,
      reason: "rules_not_published",
      message: "Texas's individual income tax rules for this year are not modelled.",
      jurisdiction,
      taxYear: input.taxYear,
    };
  }

  if (input.currency !== ruleSet.currency) {
    // The amount is zero in any currency, but a zero labelled USD in a EUR
    // workspace is still a mislabelled figure, and every other engine
    // refuses a mismatch. Consistency is worth more than convenience.
    return {
      supported: false,
      reason: "currency_mismatch",
      message: `Texas figures are reported in ${ruleSet.currency}. This workspace's figures are in ${input.currency}.`,
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
      key: "tx_no_individual_income_tax",
      label: "Texas imposes no individual personal income tax",
      amount: nothing,
      explanation: `${noTax.basis} Filing status and income make no difference to this result, so none were used to produce it.`,
    },
    {
      key: "tx_income_tax",
      label: "Texas individual state income tax",
      amount: nothing,
      explanation:
        "Zero because of Texas's constitutional position, not because a calculation was skipped and not because taxable income came out at zero. This is Texas INDIVIDUAL INCOME tax only — it says nothing about Texas franchise tax, sales and use tax, locally levied property tax, or any other Texas tax or fee, and nothing about federal tax.",
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
      // Not "the rate happens to be zero" — there is no rate schedule at all,
      // and the legislature may not enact one.
      marginalRateBasisPoints: 0,
      // Null rather than 0: an effective rate needs taxable income to divide
      // by, and none was derived.
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
      "Texas imposes no individual personal income tax, so Texas individual state income tax is $0 and there is no Texas individual income tax return to file. That is not the same as owing no Texas tax: the Comptroller administers the franchise tax, sales and use tax and many others, property tax is levied locally, and Texas residents owe federal tax in full. This is not tax advice, and Countorra does not prepare or file any Texas return.",
  };
}
