import { add, money, subtract, zero, type Money } from "@/domain/money/money";
import { floorAtZero } from "../calculation/brackets";
import { applyHighIncomeWorksheet } from "../calculation/high-income-worksheet";
import { applyPublishedRateSchedule } from "../calculation/published-rate-schedule";
import { resolveNewYorkRuleSet } from "../rules/resolve-new-york";
import type { TaxJurisdiction, TaxRuleSet } from "../rules/types";
import type { CalculationMethod, TaxCalculationInput, TaxCalculationOutcome, TaxTraceStep } from "../tax-engine";
import { calculateUsFederalTax } from "./us-federal";

/**
 * The deterministic New York STATE personal income tax calculation.
 *
 * PURE: no database, no clock, no network, no randomness, and it owns no tax
 * constant. Every threshold, rate, deduction, exemption and worksheet figure
 * is read from the rule set it is handed.
 *
 * THE CALCULATION IS NEW YORK'S
 *
 * Not federal taxable income times a New York rate. New York starts from
 * federal AGI and builds its own base, following Form IT-2105-I (2026)'s
 * estimated tax worksheet, which is the same path Form IT-201 takes:
 *
 *   line 1   New York adjusted gross income = federal AGI ± NY additions and
 *            subtractions
 *   line 2   − New York standard deduction (itemized deductions not modelled)
 *   line 3   = subtotal
 *   line 4   − dependent exemptions, $1,000 per dependent
 *   line 5   = New York taxable income
 *   line 6   New York State tax
 *
 * AND LINE 6 IS WHERE MOST OF THE DIFFICULTY LIVES
 *
 * At or below $107,650 of NYAGI it is the published rate schedule. Above it,
 * New York prescribes one of sixteen tax computation worksheets that
 * RECAPTURE the benefit of the lower brackets, so a high earner pays their
 * top rate on every dollar. An engine that applied only the brackets would
 * understate a high earner's New York tax by thousands while looking
 * perfectly reasonable. `calculationMethod` says which path ran.
 *
 * NO SUBSTITUTION, NO FEDERAL FALLBACK
 *
 * `resolveNewYorkRuleSet` holds an empty fallback policy: New York's 2026
 * figures are published, so 2026 answers with 2026's own rules. No other year
 * is answered at all, and no path here returns a federal or another state's
 * figure.
 *
 * WHAT NEW YORK STATE IS NOT
 *
 * New York City resident tax, Yonkers and the MCTMT are separate taxes on
 * separate bases and are deliberately absent — NYC would be its own
 * jurisdiction, never a mode of this one.
 */
export function calculateNewYorkTax(input: TaxCalculationInput): TaxCalculationOutcome {
  const jurisdiction: TaxJurisdiction = "US_NY";

  // Which New York rules answer this year — decided here, on the server,
  // from the registry alone. Nothing in `input` can select a rule set.
  const resolution = resolveNewYorkRuleSet(input.taxYear);
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

  const statusRules = ruleSet.filingStatuses[input.filingStatus];
  if (!statusRules) {
    return {
      supported: false,
      reason: "unsupported_filing_status",
      message: "This filing status is not currently supported for New York.",
      jurisdiction,
      taxYear: input.taxYear,
    };
  }

  if (input.currency !== ruleSet.currency) {
    // Countorra converts no currencies anywhere. A EUR figure run through a
    // USD schedule would be a confidently wrong number.
    return {
      supported: false,
      reason: "currency_mismatch",
      message: `New York tax is calculated in ${ruleSet.currency}. This workspace's figures are in ${input.currency}.`,
      jurisdiction,
      taxYear: input.taxYear,
    };
  }

  const invalid = validateStateAmounts(input);
  if (invalid) {
    return { supported: false, reason: "invalid_input", message: invalid, jurisdiction, taxYear: input.taxYear };
  }

  const currency = ruleSet.currency;
  const steps: TaxTraceStep[] = [];

  if (fallback) {
    // Unreachable while New York's policy is empty, and kept because the
    // disclosure must exist the moment a future year ever needs it — not be
    // remembered later.
    steps.push({
      key: "ny_rules_year_substituted",
      label: `Calculated under New York ${fallback.ruleSetTaxYear} rules`,
      amount: zero(currency),
      explanation: `${fallback.notice} ${fallback.reason}`,
    });
  }

  // ── line 1. New York adjusted gross income ────────────────────────────
  const federalAgi = resolveFederalAgi(input, currency, steps);
  if ("refusal" in federalAgi) return federalAgi.refusal;

  const subtractions = money(input.stateSubtractionsMinor ?? 0, currency);
  const additions = money(input.stateAdditionsMinor ?? 0, currency);

  if (additions.amountMinor !== 0) {
    steps.push({
      key: "ny_additions",
      label: "New York additions",
      amount: additions,
      explanation: "Income New York taxes that federal AGI excludes. Taken as supplied; this engine does not derive New York additions.",
    });
  }
  if (subtractions.amountMinor !== 0) {
    steps.push({
      key: "ny_subtractions",
      label: "New York subtractions",
      amount: negated(subtractions),
      explanation: "Income New York does not tax that federal AGI includes. Taken as supplied; this engine does not derive New York subtractions.",
    });
  }

  const nyagi = subtract(add(federalAgi.amount, additions), subtractions);
  steps.push({
    key: "ny_adjusted_gross_income",
    label: "New York adjusted gross income",
    amount: nyagi,
    explanation:
      additions.amountMinor === 0 && subtractions.amountMinor === 0
        ? "Equal to federal adjusted gross income, no New York adjustments having been supplied."
        : "Federal adjusted gross income plus New York additions less New York subtractions.",
  });

  // ── line 2. New York standard deduction ───────────────────────────────
  const claimedAsDependent = input.claimedAsDependent === true;
  const dependentDeduction = statusRules.standardDeductionIfClaimedAsDependentMinor;
  const standardDeductionMinor = claimedAsDependent && dependentDeduction !== undefined ? dependentDeduction : statusRules.standardDeductionMinor;
  const standardDeduction = money(standardDeductionMinor, currency);

  steps.push({
    key: "ny_standard_deduction",
    label: `New York standard deduction (${ruleSet.taxYear})`,
    amount: negated(standardDeduction),
    explanation:
      claimedAsDependent && dependentDeduction !== undefined
        ? `The ${ruleSet.taxYear} New York standard deduction for someone another taxpayer can claim as a dependent, which is lower than the ordinary amount. New York itemized deductions are not modelled.`
        : `The ${ruleSet.taxYear} New York standard deduction for this filing status. New York itemized deductions (Form IT-196) are not modelled.`,
  });

  // ── line 4. Dependent exemptions ──────────────────────────────────────
  const dependentCount = Math.max(0, Math.trunc(input.dependentCount ?? 0));
  const dependentExemption = money((ruleSet.dependentExemptionMinor ?? 0) * dependentCount, currency);
  if (dependentExemption.amountMinor > 0) {
    steps.push({
      key: "ny_dependent_exemptions",
      label: `New York dependent exemptions (${dependentCount})`,
      amount: negated(dependentExemption),
      explanation: `$${((ruleSet.dependentExemptionMinor ?? 0) / 100).toLocaleString("en-US")} for each dependent. New York's exemption covers dependents only — not the taxpayer or spouse.`,
    });
  }

  // ── line 5. New York taxable income ───────────────────────────────────
  const taxableIncome = floorAtZero(subtract(subtract(nyagi, standardDeduction), dependentExemption));
  steps.push({
    key: "ny_taxable_income",
    label: "New York taxable income",
    amount: taxableIncome,
    explanation: "New York adjusted gross income less the standard deduction and dependent exemptions, floored at zero.",
  });

  // ── line 6. New York State tax ────────────────────────────────────────
  const highIncome = ruleSet.highIncome ?? null;
  const worksheet = highIncome ? applyHighIncomeWorksheet(nyagi, taxableIncome, input.filingStatus, statusRules.brackets, highIncome, currency) : null;

  let incomeTax: Money;
  let calculationMethod: CalculationMethod;
  let marginalRateBasisPoints: number;

  const schedule = applyPublishedRateSchedule(taxableIncome, statusRules.brackets, currency);

  if (worksheet) {
    calculationMethod = "NY_TAX_COMPUTATION_WORKSHEET";
    incomeTax = worksheet.tax;
    marginalRateBasisPoints = worksheet.kind === "flat_top_rate" ? ruleSet.filingStatuses[input.filingStatus]!.brackets.at(-1)!.rateBasisPoints : schedule.marginalRateBasisPoints;

    steps.push({
      key: "ny_high_income_worksheet",
      label: `New York tax computation worksheet ${worksheet.worksheetId}`,
      amount: nyagi,
      explanation: `New York adjusted gross income is above $${((highIncome?.ordinaryScheduleUpToAgiMinor ?? 0) / 100).toLocaleString("en-US")}, so New York prescribes this published worksheet instead of the rate schedule alone. It recaptures the benefit of the lower brackets, so the tax is higher than the brackets alone would give.`,
    });

    for (const line of worksheet.lines) {
      steps.push({
        key: `ny_worksheet_${worksheet.worksheetId}_line_${line.line}`,
        label: `Worksheet ${worksheet.worksheetId}, line ${line.line} — ${line.label}`,
        amount: line.amount,
        explanation: "A line of the published New York tax computation worksheet, in the order the form sets out.",
      });
    }

    if (worksheet.phaseInTenThousandths !== null) {
      steps.push({
        key: "ny_phase_in_fraction",
        label: `Phase-in fraction ${(worksheet.phaseInTenThousandths / 10_000).toFixed(4)}`,
        amount: zero(currency),
        explanation: "The worksheet divides the excess adjusted gross income by $50,000 and rounds to four decimal places. That rounding is New York's, and it is applied exactly.",
      });
    }
  } else {
    calculationMethod = "NY_RATE_SCHEDULE";
    incomeTax = schedule.total;
    marginalRateBasisPoints = schedule.marginalRateBasisPoints;

    if (schedule.application) {
      const a = schedule.application;
      steps.push({
        key: "ny_rate_schedule",
        label: `${formatRate(a.rateBasisPoints)} bracket, ${formatBound(a.fromMinor)}${a.upToMinor === null ? " and above" : ` to ${formatBound(a.upToMinor)}`}`,
        amount: incomeTax,
        explanation: `New York publishes this bracket as "${formatBound(a.baseTaxMinor)} plus ${formatRate(a.rateBasisPoints)} of the excess over ${formatBound(a.fromMinor)}". The excess is ${formatMoneyPlain(a.excess)}, giving ${formatMoneyPlain(a.taxOnExcess)} on top of the published base.`,
      });
    }
  }

  steps.push({
    key: "ny_income_tax",
    label: "New York State tax",
    amount: incomeTax,
    explanation:
      calculationMethod === "NY_TAX_COMPUTATION_WORKSHEET"
        ? "From the published tax computation worksheet above."
        : "From the published New York State tax rate schedule for this filing status.",
  });

  return {
    supported: true,
    jurisdiction,
    taxYear: ruleSet.taxYear,
    requestedTaxYear: resolution.requestedTaxYear,
    calculationStatus: resolution.status,
    calculationMethod,
    fallback,
    ruleSetVersion: ruleSet.version,
    currency,
    inputs: {
      filingStatus: input.filingStatus,
      ordinaryIncome: money(input.ordinaryIncomeMinor ?? 0, currency),
      selfEmploymentNetProfit: money(input.selfEmploymentNetProfitMinor ?? 0, currency),
    },
    steps,
    totals: {
      // For a state engine `grossIncome` is the federal AGI the state
      // computation begins from.
      grossIncome: federalAgi.amount,
      adjustedGrossIncome: nyagi,
      standardDeduction,
      taxableIncome,
      incomeTax,
      // Explicitly zero: New York levies no state self-employment tax, and a
      // caller adding federal and state totals must not pick this up twice.
      selfEmploymentTax: zero(currency),
      selfEmploymentTaxDeduction: zero(currency),
      surtax: zero(currency),
      totalTax: incomeTax,
    },
    rates: {
      marginalRateBasisPoints,
      effectiveRateBasisPoints: taxableIncome.amountMinor > 0 ? Math.round((incomeTax.amountMinor / taxableIncome.amountMinor) * 10_000) : null,
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
    disclaimer: fallback
      ? `${fallback.notice} It is not a Form IT-201, not tax advice, and Countorra does not prepare or file New York returns. It covers New York State tax only — not New York City, Yonkers or the MCTMT — and does not account for the items listed under what is not modelled.`
      : "An estimate of New York State income tax on the figures supplied. It is not a Form IT-201, not tax advice, and Countorra does not prepare or file New York returns. It covers New York State tax only — not New York City, Yonkers or the MCTMT — and does not account for the items listed under what is not modelled.",
  };
}

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

/**
 * Federal AGI — New York's line 1 starts from it.
 *
 * Supplied is best. Otherwise the FEDERAL engine computes it, because federal
 * AGI is a federal quantity and reimplementing it here would create a second,
 * drifting copy of the self-employment-tax deduction that feeds it.
 */
function resolveFederalAgi(
  input: TaxCalculationInput,
  currency: TaxRuleSet["currency"],
  steps: TaxTraceStep[],
): { amount: Money } | { refusal: TaxCalculationOutcome } {
  if (input.federalAdjustedGrossIncomeMinor !== undefined) {
    const amount = money(input.federalAdjustedGrossIncomeMinor, currency);
    steps.push({
      key: "federal_adjusted_gross_income",
      label: "Federal adjusted gross income",
      amount,
      explanation: "As supplied from the federal return (Form 1040, line 11). New York's calculation begins here.",
    });
    return { amount };
  }

  const federal = calculateUsFederalTax(input);
  if (!federal.supported) {
    return {
      refusal: {
        supported: false,
        reason: "invalid_input",
        message:
          federal.reason === "invalid_input"
            ? federal.message
            : `New York's calculation starts from federal adjusted gross income, and this build can't derive one for ${input.taxYear}. Supply the federal adjusted gross income from Form 1040, line 11.`,
        jurisdiction: "US_NY",
        taxYear: input.taxYear,
        details: [federal.message],
      },
    };
  }

  const amount = federal.totals.adjustedGrossIncome;
  steps.push({
    key: "federal_adjusted_gross_income",
    label: "Federal adjusted gross income",
    amount,
    explanation: `Not supplied, so it was computed from the same figures using the federal rule set (version ${federal.ruleSetVersion}), including the deduction for one-half of self-employment tax. New York's calculation begins here.`,
  });
  return { amount };
}

/** Rejects amounts the state engine will not compute on. */
function validateStateAmounts(input: TaxCalculationInput): string | null {
  const fields = [
    ["federal adjusted gross income", input.federalAdjustedGrossIncomeMinor],
    ["New York additions", input.stateAdditionsMinor],
    ["New York subtractions", input.stateSubtractionsMinor],
  ] as const;

  for (const [name, value] of fields) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) return `The ${name} figure isn't a usable amount.`;
  }

  if ((input.stateAdditionsMinor ?? 0) < 0) return "New York additions can't be negative — use the subtractions field instead.";
  if ((input.stateSubtractionsMinor ?? 0) < 0) return "New York subtractions can't be negative — use the additions field instead.";

  if (input.dependentCount !== undefined) {
    if (!Number.isFinite(input.dependentCount) || !Number.isInteger(input.dependentCount)) return "The number of dependents isn't a usable whole number.";
    if (input.dependentCount < 0) return "The number of dependents can't be negative.";
    if (input.dependentCount > 50) return "That number of dependents isn't a usable figure.";
  }

  if (!Number.isInteger(input.taxYear) || input.taxYear < 1900 || input.taxYear > 2200) return "That isn't a usable tax year.";

  return null;
}
