import { add, money, subtract, percentageOf, zero, type Money } from "@/domain/money/money";
import type { CurrencyCode } from "@/domain/money/currency";
import { applyProgressiveBrackets, floorAtZero } from "../calculation/brackets";
import { findRuleSet } from "../rules/registry";
import type { FilingStatus, TaxJurisdiction, TaxRuleSet } from "../rules/types";
import type { TaxCalculationInput, TaxCalculationOutcome, TaxTraceStep } from "../tax-engine";

/**
 * The deterministic US federal individual income tax calculation.
 *
 * PURE. No database, no clock, no network, no randomness. Given the same
 * input and the same rule set it returns byte-identical output, which is
 * what makes a stored result reproducible and every figure testable.
 *
 * IT OWNS NO TAX CONSTANT. Every threshold, rate and deduction is read from
 * the rule set it is handed. That is the point of the split: adding 2027 is
 * a data file, and this function does not change.
 *
 * ORDER OF OPERATIONS, WHICH IS NOT ARBITRARY
 *
 *   1. Self-employment tax is computed FIRST, from net profit alone. It does
 *      not depend on income tax, and it is owed even by someone whose
 *      standard deduction wipes out their income tax entirely — a fact that
 *      surprises most freelancers and is the single most common way an
 *      estimate comes out too low.
 *   2. Half of that SE tax is an above-the-line deduction (IRC § 164(f)), so
 *      it reduces AGI before the standard deduction is applied.
 *   3. Taxable income = AGI − standard deduction, floored at zero.
 *   4. Income tax comes from the progressive brackets.
 *
 * Doing (1) after (3) would make the SE deduction unavailable and overstate
 * income tax; skipping (2) would overstate it too.
 */

export function calculateUsFederalTax(input: TaxCalculationInput): TaxCalculationOutcome {
  const jurisdiction: TaxJurisdiction = "US_FEDERAL";

  const ruleSet = findRuleSet(jurisdiction, input.taxYear);
  if (!ruleSet) {
    return {
      supported: false,
      reason: "unsupported_tax_year",
      message: "This federal tax year is not currently supported.",
      jurisdiction,
      taxYear: input.taxYear,
    };
  }

  const statusRules = ruleSet.filingStatuses[input.filingStatus];
  if (!statusRules) {
    return {
      supported: false,
      reason: "unsupported_filing_status",
      message: "This filing status is not currently supported.",
      jurisdiction,
      taxYear: input.taxYear,
    };
  }

  if (input.currency !== ruleSet.currency) {
    // Countorra converts no currencies anywhere. A EUR figure run through a
    // USD bracket table would be a confidently wrong number.
    return {
      supported: false,
      reason: "currency_mismatch",
      message: `Federal tax is calculated in ${ruleSet.currency}. This workspace's figures are in ${input.currency}.`,
      jurisdiction,
      taxYear: input.taxYear,
    };
  }

  const invalid = validateAmounts(input);
  if (invalid) {
    return { supported: false, reason: "invalid_input", message: invalid, jurisdiction, taxYear: input.taxYear };
  }

  const currency = ruleSet.currency;
  const steps: TaxTraceStep[] = [];

  const ordinaryIncome = money(input.ordinaryIncomeMinor ?? 0, currency);
  const netProfit = money(input.selfEmploymentNetProfitMinor ?? 0, currency);

  steps.push({
    key: "ordinary_income",
    label: "Ordinary income",
    amount: ordinaryIncome,
    explanation: "Wages, salary and other ordinary income entered for this tax year.",
  });

  if (netProfit.amountMinor !== 0) {
    steps.push({
      key: "schedule_c_net_profit",
      label: "Self-employment net profit",
      amount: netProfit,
      explanation: "Net profit from self-employment (Schedule C): business income less business expenses.",
    });
  }

  // ── 1. Self-employment tax ────────────────────────────────────────────
  // Box 5 is never smaller than box 3 and is equal for most taxpayers, so
  // when only Social Security wages are given that figure is used for
  // Medicare too — defaulting to zero would hand the whole Additional
  // Medicare threshold to self-employment income and understate the tax.
  const socialSecurityWages = input.w2SocialSecurityWagesMinor ?? 0;
  const medicareWasInferred = input.w2MedicareWagesMinor === undefined && socialSecurityWages > 0;
  const medicareWages = input.w2MedicareWagesMinor ?? socialSecurityWages;

  const se = calculateSelfEmploymentTax(
    netProfit,
    input.filingStatus,
    { socialSecurityMinor: socialSecurityWages, medicareMinor: medicareWages, medicareWasInferred },
    ruleSet,
    steps,
  );

  // ── 2. Adjusted gross income ──────────────────────────────────────────
  const grossIncome = add(ordinaryIncome, floorAtZero(netProfit));
  steps.push({
    key: "gross_income",
    label: "Gross income",
    amount: grossIncome,
    explanation:
      netProfit.amountMinor < 0
        ? "Ordinary income. A self-employment loss is not applied against ordinary income here — loss treatment is outside this engine's scope."
        : "Ordinary income plus self-employment net profit.",
  });

  const agi = subtract(grossIncome, se.deductiblePortion);
  if (se.deductiblePortion.amountMinor > 0) {
    steps.push({
      key: "se_tax_deduction",
      label: "Deduction for one-half of self-employment tax",
      amount: negated(se.deductiblePortion),
      explanation: "One half of self-employment tax is deductible when figuring adjusted gross income (IRC § 164(f)).",
    });
  }
  steps.push({ key: "adjusted_gross_income", label: "Adjusted gross income", amount: agi, explanation: "Gross income less supported adjustments." });

  // ── 3. Taxable income ─────────────────────────────────────────────────
  const standardDeduction = money(statusRules.standardDeductionMinor, currency);
  steps.push({
    key: "standard_deduction",
    label: "Standard deduction",
    amount: negated(standardDeduction),
    explanation: `The ${ruleSet.taxYear} standard deduction for this filing status. Itemized deductions are not modelled — the standard deduction is always applied.`,
  });

  const taxableIncome = floorAtZero(subtract(agi, standardDeduction));
  steps.push({
    key: "taxable_income",
    label: "Taxable income",
    amount: taxableIncome,
    explanation: "Adjusted gross income less the standard deduction, floored at zero.",
  });

  // ── 4. Income tax ─────────────────────────────────────────────────────
  const bracketResult = applyProgressiveBrackets(taxableIncome, statusRules.brackets, currency);

  for (const application of bracketResult.applications) {
    const upper = application.upToMinor === null ? "and above" : `to ${formatBound(application.upToMinor)}`;
    steps.push({
      key: `bracket_${application.rateBasisPoints}`,
      label: `${formatRate(application.rateBasisPoints)} on ${formatBound(application.fromMinor)} ${upper}`,
      amount: application.tax,
      explanation: `${formatMoneyPlain(application.taxableInBracket)} of taxable income fell in this bracket, taxed at ${formatRate(application.rateBasisPoints)}. Only the income inside the bracket is taxed at that rate.`,
    });
  }

  steps.push({
    key: "federal_income_tax",
    label: "Federal income tax",
    amount: bracketResult.total,
    explanation: "The sum of every bracket above.",
  });

  const totalFederalTax = add(bracketResult.total, se.totalTax);
  if (se.totalTax.amountMinor > 0) {
    steps.push({
      key: "total_federal_tax",
      label: "Total estimated federal tax",
      amount: totalFederalTax,
      explanation: "Federal income tax plus self-employment tax.",
    });
  }

  return {
    supported: true,
    jurisdiction,
    taxYear: ruleSet.taxYear,
    // The federal engine never substitutes a year: `findRuleSet` either has
    // the requested one or the call already returned unsupported above.
    requestedTaxYear: input.taxYear,
    calculationStatus: "PUBLISHED_RULES",
    calculationMethod: "FEDERAL_RATE_SCHEDULE",
    fallback: null,
    ruleSetVersion: ruleSet.version,
    currency,
    inputs: {
      filingStatus: input.filingStatus,
      ordinaryIncome,
      selfEmploymentNetProfit: netProfit,
    },
    steps,
    totals: {
      grossIncome,
      adjustedGrossIncome: agi,
      standardDeduction,
      taxableIncome,
      incomeTax: bracketResult.total,
      selfEmploymentTax: se.totalTax,
      selfEmploymentTaxDeduction: se.deductiblePortion,
      // The federal system levies no surcharge of this kind. Zero rather
      // than omitted, so every result has the same shape.
      surtax: zero(currency),
      totalTax: totalFederalTax,
    },
    rates: {
      marginalRateBasisPoints: bracketResult.marginalRateBasisPoints,
      effectiveRateBasisPoints: bracketResult.effectiveRateBasisPoints,
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
      "An estimate of federal tax on the figures supplied. It is not a tax return, not tax advice, and does not account for the items listed under what is not modelled.",
  };

  function negated(value: Money): Money {
    return money(-value.amountMinor, value.currency);
  }
  function formatBound(minor: number): string {
    return `$${(minor / 100).toLocaleString("en-US")}`;
  }
  function formatRate(basisPoints: number): string {
    return `${basisPoints / 100}%`;
  }
  function formatMoneyPlain(value: Money): string {
    return `$${(value.amountMinor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

interface SelfEmploymentResult {
  totalTax: Money;
  deductiblePortion: Money;
}

/**
 * Self-employment tax on Schedule C net profit, accounting for W-2 wages.
 *
 * THE BUG THIS REPLACED
 *
 * The first version treated Schedule C profit as the taxpayer's only
 * Social-Security-bearing income. For a pure freelancer that is right. For
 * someone with a job and a side business it is badly wrong in the expensive
 * direction: a $200,000 employee with $50,000 of consulting income was
 * charged 12.4% on the consulting earnings even though their salary had
 * already used the entire wage base. That is roughly $5,700 of tax they do
 * not owe.
 *
 * WAGES COME FIRST — BOTH TIMES
 *
 *   Social Security. The wage base applies to the COMBINED total of W-2
 *   wages and self-employment earnings, and wages are counted first. So the
 *   self-employment amount exposed to the 12.4% is whatever capacity the
 *   wages left behind, and nothing when they left none. (Schedule SE
 *   Section B: subtract social security wages from the base, then multiply
 *   the SMALLER of net earnings or the remainder.)
 *
 *   Additional Medicare Tax. IRS Topic 560 sets out three steps, and the
 *   middle one is the one that matters here: "Reducing the applicable
 *   threshold for the filing status by the total amount of Medicare wages
 *   received (but not below zero)", then charging 0.9% on self-employment
 *   income above what is left.
 *
 * The Medicare half (2.9%) is untouched by any of this — it has no cap and
 * no threshold, so wages do not change it.
 *
 * WHAT IS DELIBERATELY NOT INCLUDED
 *
 * Topic 560's first step — 0.9% on the WAGES above the threshold — is a real
 * liability but not self-employment tax, and employers withhold it. Folding
 * it into this figure would misname it and double-count against withholding
 * the taxpayer has already suffered. It is noted in the trace when it
 * applies, and listed under what is not modelled.
 */
function calculateSelfEmploymentTax(
  netProfit: Money,
  filingStatus: FilingStatus,
  wages: { socialSecurityMinor: number; medicareMinor: number; medicareWasInferred: boolean },
  ruleSet: TaxRuleSet,
  steps: TaxTraceStep[],
): SelfEmploymentResult {
  const currency = ruleSet.currency as CurrencyCode;
  const none: SelfEmploymentResult = { totalTax: zero(currency), deductiblePortion: zero(currency) };

  const rules = ruleSet.selfEmployment;
  // A loss produces no self-employment tax, and — per Topic 560 — is not
  // considered for the Additional Medicare Tax either.
  if (!rules || netProfit.amountMinor <= 0) return none;

  const netEarnings = percentageOf(netProfit, rules.netEarningsBasisPoints / 100);
  steps.push({
    key: "se_net_earnings",
    label: "Net earnings from self-employment",
    amount: netEarnings,
    explanation: `${rules.netEarningsBasisPoints / 100}% of net profit is subject to self-employment tax.`,
  });

  if (netEarnings.amountMinor < rules.minimumNetEarningsMinor) {
    // A cliff in statute: below it, no SE tax at all.
    steps.push({
      key: "se_below_threshold",
      label: "Below the self-employment tax threshold",
      amount: zero(currency),
      explanation: `Net earnings under $${rules.minimumNetEarningsMinor / 100} owe no self-employment tax (IRC § 6017).`,
    });
    return none;
  }

  if (wages.medicareWasInferred) {
    steps.push({
      key: "se_medicare_wages_inferred",
      label: "Medicare wages assumed equal to Social Security wages",
      amount: money(wages.medicareMinor, currency),
      explanation:
        "No separate Medicare wage figure (Form W-2 box 5) was supplied, so the Social Security figure (box 3) was used. Box 5 is never smaller than box 3 and is equal for most taxpayers; supply box 5 if they differ.",
    });
  }

  // ── Social Security: wages consume the base first ──────────────────────
  const remainingWageBase = Math.max(0, rules.socialSecurityWageBaseMinor - wages.socialSecurityMinor);
  const socialSecurityBase = money(Math.min(netEarnings.amountMinor, remainingWageBase), currency);
  const socialSecurity = percentageOf(socialSecurityBase, rules.socialSecurityRateBasisPoints / 100);

  if (wages.socialSecurityMinor > 0) {
    steps.push({
      key: "se_wage_base_remaining",
      label: "Social Security wage base left after W-2 wages",
      amount: money(remainingWageBase, currency),
      explanation:
        remainingWageBase === 0
          ? `W-2 wages of $${formatPlain(wages.socialSecurityMinor)} already reach the $${formatPlain(rules.socialSecurityWageBaseMinor)} wage base for ${ruleSet.taxYear}, so no self-employment earnings are subject to the Social Security portion.`
          : `The $${formatPlain(rules.socialSecurityWageBaseMinor)} wage base applies to wages and self-employment earnings combined, and wages count first. W-2 wages of $${formatPlain(wages.socialSecurityMinor)} leave this much capacity.`,
    });
  }

  steps.push({
    key: "se_social_security",
    label: `Social Security portion (${rules.socialSecurityRateBasisPoints / 100}%)`,
    amount: socialSecurity,
    explanation:
      socialSecurityBase.amountMinor === 0
        ? "No self-employment earnings are subject to the Social Security portion."
        : socialSecurityBase.amountMinor < netEarnings.amountMinor
          ? `Applied to $${formatPlain(socialSecurityBase.amountMinor)} of net earnings — the remaining wage-base capacity. Earnings above it are not subject to the Social Security portion.`
          : "Applied to all net earnings, which are within the wage base.",
  });

  // ── Medicare: no cap, unaffected by wages ─────────────────────────────
  const medicare = percentageOf(netEarnings, rules.medicareRateBasisPoints / 100);
  steps.push({
    key: "se_medicare",
    label: `Medicare portion (${rules.medicareRateBasisPoints / 100}%)`,
    amount: medicare,
    explanation: "Applied to all net earnings. The Medicare portion has no wage base, so W-2 wages do not change it.",
  });

  let totalTax = add(socialSecurity, medicare);

  // ── Additional Medicare Tax: wages consume the threshold first ────────
  const threshold = rules.additionalMedicareThresholdMinor[filingStatus];
  if (threshold !== undefined) {
    const remainingThreshold = Math.max(0, threshold - wages.medicareMinor);
    const subjectToAdditional = Math.max(0, netEarnings.amountMinor - remainingThreshold);

    if (wages.medicareMinor > 0) {
      steps.push({
        key: "se_additional_medicare_threshold",
        label: "Additional Medicare Tax threshold left after Medicare wages",
        amount: money(remainingThreshold, currency),
        explanation:
          remainingThreshold === 0
            ? `Medicare wages of $${formatPlain(wages.medicareMinor)} already exceed the $${formatPlain(threshold)} threshold for this filing status, so all net earnings are subject to the Additional Medicare Tax.`
            : `The $${formatPlain(threshold)} threshold is reduced by Medicare wages received (IRS Topic 560).`,
      });
    }

    if (subjectToAdditional > 0) {
      const additional = percentageOf(money(subjectToAdditional, currency), rules.additionalMedicareRateBasisPoints / 100);
      steps.push({
        key: "se_additional_medicare",
        label: `Additional Medicare Tax (${rules.additionalMedicareRateBasisPoints / 100}%)`,
        amount: additional,
        explanation: `On $${formatPlain(subjectToAdditional)} of net earnings above the remaining threshold. This threshold is fixed in statute and is not adjusted for inflation.`,
      });
      totalTax = add(totalTax, additional);
    }

    if (wages.medicareMinor > threshold) {
      // Real, owed, and not self-employment tax. Named so the figure is not
      // mistaken for the taxpayer's whole Additional Medicare liability.
      steps.push({
        key: "additional_medicare_on_wages_excluded",
        label: "Additional Medicare Tax on W-2 wages (not included)",
        amount: zero(currency),
        explanation: `Medicare wages above $${formatPlain(threshold)} also carry the 0.9% Additional Medicare Tax, but employers withhold that and it is not self-employment tax. It is not included in this figure.`,
      });
    }
  }

  steps.push({
    key: "self_employment_tax",
    label: "Self-employment tax",
    amount: totalTax,
    explanation: "Owed in addition to income tax, and owed even when the standard deduction reduces income tax to zero.",
  });

  // The deductible half is computed from the Social Security and Medicare
  // portions only. The Additional Medicare Tax is NOT deductible, which is
  // why it is excluded from this base rather than halving `totalTax`.
  const deductibleBase = add(socialSecurity, medicare);
  const deductiblePortion = percentageOf(deductibleBase, rules.deductiblePortionBasisPoints / 100);

  return { totalTax, deductiblePortion };
}

/** `1,234,500` cents → `12,345`. For trace prose only; never arithmetic. */
function formatPlain(minor: number): string {
  return (minor / 100).toLocaleString("en-US");
}

/** Rejects amounts the engine will not compute on. */
function validateAmounts(input: TaxCalculationInput): string | null {
  const ordinary = input.ordinaryIncomeMinor ?? 0;
  const profit = input.selfEmploymentNetProfitMinor ?? 0;

  const socialSecurityWages = input.w2SocialSecurityWagesMinor ?? 0;
  const medicareWages = input.w2MedicareWagesMinor ?? 0;

  for (const [name, value] of [
    ["ordinary income", ordinary],
    ["self-employment net profit", profit],
    ["W-2 Social Security wages", socialSecurityWages],
    ["W-2 Medicare wages", medicareWages],
  ] as const) {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      return `The ${name} figure isn't a usable amount.`;
    }
  }

  if (socialSecurityWages < 0 || medicareWages < 0) {
    // Wages are a reported W-2 box. Negative is not a loss, it is a mistake.
    return "W-2 wages can't be negative.";
  }

  if (input.w2MedicareWagesMinor !== undefined && input.w2MedicareWagesMinor < socialSecurityWages) {
    // Box 5 includes everything box 3 does and more (box 3 stops at the wage
    // base, box 5 never does). Box 5 below box 3 means the two were swapped,
    // and accepting it would quietly understate the Additional Medicare Tax.
    return "W-2 Medicare wages (box 5) can't be less than Social Security wages (box 3).";
  }

  if (ordinary < 0) {
    // Negative wages are not a thing. A self-employment LOSS is, so that one
    // is permitted and handled explicitly above.
    return "Ordinary income can't be negative.";
  }

  if (!Number.isInteger(input.taxYear) || input.taxYear < 1900 || input.taxYear > 2200) {
    return "That isn't a usable tax year.";
  }

  return null;
}
