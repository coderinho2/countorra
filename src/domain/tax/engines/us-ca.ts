import { add, money, subtract, percentageOf, zero, type Money } from "@/domain/money/money";
import { applyProgressiveBrackets, floorAtZero } from "../calculation/brackets";
import { applyTaxTable } from "../calculation/tax-table";
import { resolveCaliforniaRuleSet } from "../rules/resolve-california";
import type { TaxJurisdiction, TaxRuleSet } from "../rules/types";
import type { CalculationMethod, TaxCalculationInput, TaxCalculationOutcome, TaxTraceStep } from "../tax-engine";
import { calculateUsFederalTax } from "./us-federal";

/**
 * The deterministic California individual income tax calculation.
 *
 * PURE, like its federal sibling: no database, no clock, no network, no
 * randomness, and it owns no tax constant. Every threshold, rate, deduction
 * and table interval is read from the rule set it is handed.
 *
 * THE CALCULATION IS CALIFORNIA'S, NOT A RESCALED FEDERAL ONE
 *
 * A state engine that multiplied federal taxable income by a state rate
 * would be wrong from the first line, because California's taxable income is
 * a different number: it starts from federal AGI (not federal taxable
 * income), applies California's own adjustments, and subtracts California's
 * own standard deduction, which is roughly a third of the federal one. This
 * follows Form 540 exactly:
 *
 *   line 13  Federal adjusted gross income
 *   line 14  − California adjustments, subtractions  [Sch. CA (540) Part I, col. B]
 *   line 15  = subtotal
 *   line 16  + California adjustments, additions     [Sch. CA (540) Part I, col. C]
 *   line 17  = California adjusted gross income
 *   line 18  − California standard deduction
 *   line 19  = California taxable income
 *   line 31  Tax — from the Tax TABLE at or below $100,000, from the Tax Rate
 *            SCHEDULE above it. FTB requires this split; the two disagree.
 *   line 62  + Behavioral Health Services Tax, 1% of line 19 over $1,000,000
 *
 * FTB's own ordering — subtractions before additions — is preserved in the
 * trace even though addition is commutative, because a person checking this
 * against their return reads down the form.
 *
 * NO FEDERAL FALLBACK, EVER
 *
 * There is no path through this function that returns a federal figure. The
 * ONE substitution it will make is a California year for a California year,
 * decided by `resolveCaliforniaRuleSet` and disclosed on the result — see
 * `calculationStatus` and `fallback`. A substituted result is never labelled
 * as the requested year's own calculation.
 *
 * WHAT CALIFORNIA DOES NOT HAVE
 *
 * No state self-employment tax: Social Security and Medicare are federal,
 * and the rule set says so with `selfEmployment: null`. The self-employment
 * totals on a California result are therefore zero, not omitted, so that a
 * caller summing federal and state cannot double-count them.
 */
export function calculateCaliforniaTax(input: TaxCalculationInput): TaxCalculationOutcome {
  const jurisdiction: TaxJurisdiction = "US_CA";

  // Which California rules answer this year — decided here, on the server,
  // from the registry alone. Nothing in `input` can select a rule set.
  const resolution = resolveCaliforniaRuleSet(input.taxYear);
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
      message: "California calculations currently cover Single and Married/RDP Filing Jointly only.",
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
      message: `California tax is calculated in ${ruleSet.currency}. This workspace's figures are in ${input.currency}.`,
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

  // ── 0. The substitution, said first if it happened ────────────────────
  //
  // At the top of the trace rather than the bottom: someone reading down the
  // calculation must know which year's rules produced every line below
  // before they read any of them.
  if (fallback) {
    steps.push({
      key: "ca_rules_year_substituted",
      label: `Calculated under California ${fallback.ruleSetTaxYear} rules`,
      amount: zero(currency),
      explanation: `${fallback.notice} ${fallback.reason}`,
    });
  }

  // ── line 13. Federal AGI ──────────────────────────────────────────────
  const federalAgi = resolveFederalAgi(input, currency, steps);
  if ("refusal" in federalAgi) return federalAgi.refusal;

  // ── lines 14–17. California AGI ───────────────────────────────────────
  const subtractions = money(input.stateSubtractionsMinor ?? 0, currency);
  const additions = money(input.stateAdditionsMinor ?? 0, currency);

  if (subtractions.amountMinor !== 0) {
    steps.push({
      key: "ca_adjustments_subtractions",
      label: "California adjustments — subtractions",
      amount: negated(subtractions),
      explanation:
        "Income California does not tax that federal AGI includes — Schedule CA (540), Part I, column B. Taken as supplied; this engine does not derive California adjustments.",
    });
  }
  if (additions.amountMinor !== 0) {
    steps.push({
      key: "ca_adjustments_additions",
      label: "California adjustments — additions",
      amount: additions,
      explanation:
        "Income California taxes that federal AGI excludes — Schedule CA (540), Part I, column C. Taken as supplied; this engine does not derive California adjustments.",
    });
  }

  const californiaAgi = add(subtract(federalAgi.amount, subtractions), additions);
  steps.push({
    key: "ca_adjusted_gross_income",
    label: "California adjusted gross income",
    amount: californiaAgi,
    explanation:
      subtractions.amountMinor === 0 && additions.amountMinor === 0
        ? "Equal to federal adjusted gross income, no California adjustments having been supplied."
        : "Federal adjusted gross income less California subtractions plus California additions (Form 540, line 17).",
  });

  // ── line 18. California standard deduction ────────────────────────────
  const standardDeduction = money(statusRules.standardDeductionMinor, currency);
  steps.push({
    key: "ca_standard_deduction",
    label: `California standard deduction (${ruleSet.taxYear})`,
    amount: negated(standardDeduction),
    explanation: `The ${ruleSet.taxYear} California standard deduction for this filing status${fallback ? `, used because the ${fallback.requestedTaxYear} amount has not been published` : ""}. It is far smaller than the federal one, which is why California taxable income is usually well above federal taxable income. California itemized deductions are not modelled.`,
  });

  // ── line 19. California taxable income ────────────────────────────────
  const taxableIncome = floorAtZero(subtract(californiaAgi, standardDeduction));
  steps.push({
    key: "ca_taxable_income",
    label: "California taxable income",
    amount: taxableIncome,
    explanation: "California adjusted gross income less the California standard deduction, floored at zero (Form 540, line 19).",
  });

  // ── line 31. Tax — TABLE at or below the cap, SCHEDULE above it ───────
  const table = ruleSet.taxTable ?? null;
  const tableApplication = table ? applyTaxTable(taxableIncome, statusRules.brackets, table, currency) : null;

  let incomeTax: Money;
  let calculationMethod: CalculationMethod;
  let marginalRateBasisPoints: number;

  if (table && tableApplication) {
    calculationMethod = "CA_TAX_TABLE";
    incomeTax = tableApplication.tax;

    steps.push({
      key: "ca_tax_table_interval",
      label: tableApplication.belowFirstRow
        ? "Below the first California Tax Table row"
        : `California Tax Table row: ${formatBound(tableApplication.intervalFromMinor)} to ${formatBound(tableApplication.intervalToMinor)}`,
      amount: taxableIncome,
      explanation: tableApplication.belowFirstRow
        ? `FTB requires the Tax Table for taxable income of ${formatBound(table.appliesUpToMinor)} or less. This taxable income falls below the Table's first published row, and owes no California income tax.`
        : `FTB requires the Tax Table for taxable income of ${formatBound(table.appliesUpToMinor)} or less. The Table is a published, discrete calculation: every taxable income inside this row pays the same whole-dollar tax, so the figure does not change with each extra dollar the way a rate schedule does.`,
    });

    // How FTB built the row. Shown because "why is my tax this number" is
    // otherwise unanswerable for a table, and because it makes clear the
    // schedule was applied to the MIDPOINT and not to the income.
    const midpointBrackets = applyProgressiveBrackets(tableApplication.midpoint, statusRules.brackets, currency);
    marginalRateBasisPoints = midpointBrackets.marginalRateBasisPoints;

    if (!tableApplication.belowFirstRow) {
      steps.push({
        key: "ca_tax_table_midpoint",
        label: "Midpoint of the Tax Table row",
        amount: tableApplication.midpoint,
        explanation:
          "The row's tax is the rate schedule applied to the midpoint of the row, not to the taxable income itself. This is how FTB builds each published row.",
      });
    }

    for (const application of midpointBrackets.applications) {
      const upper = application.upToMinor === null ? "and above" : `to ${formatBound(application.upToMinor)}`;
      steps.push({
        key: `ca_table_bracket_${application.rateBasisPoints}`,
        label: `${formatRate(application.rateBasisPoints)} on ${formatBound(application.fromMinor)} ${upper}`,
        amount: application.tax,
        explanation: `${formatMoneyPlain(application.taxableInBracket)} of the row midpoint fell in this bracket, taxed at ${formatRate(application.rateBasisPoints)}.`,
      });
    }

    steps.push({
      key: "ca_income_tax",
      label: "California income tax (Tax Table)",
      amount: incomeTax,
      explanation: `${formatMoneyPlain(tableApplication.taxAtMidpoint)} at the row midpoint, rounded to the whole dollar the Table publishes.`,
    });
  } else {
    calculationMethod = "CA_RATE_SCHEDULE";
    const bracketResult = applyProgressiveBrackets(taxableIncome, statusRules.brackets, currency);
    incomeTax = bracketResult.total;
    marginalRateBasisPoints = bracketResult.marginalRateBasisPoints;

    if (table) {
      steps.push({
        key: "ca_rate_schedule_applies",
        label: "California Tax Rate Schedule applies",
        amount: taxableIncome,
        explanation: `Taxable income is above ${formatBound(table.appliesUpToMinor)}, so FTB requires the Tax Rate Schedule rather than the Tax Table.`,
      });
    }

    for (const application of bracketResult.applications) {
      const upper = application.upToMinor === null ? "and above" : `to ${formatBound(application.upToMinor)}`;
      steps.push({
        key: `ca_bracket_${application.rateBasisPoints}`,
        label: `${formatRate(application.rateBasisPoints)} on ${formatBound(application.fromMinor)} ${upper}`,
        amount: application.tax,
        explanation: `${formatMoneyPlain(application.taxableInBracket)} of California taxable income fell in this bracket, taxed at ${formatRate(application.rateBasisPoints)}. Only the income inside the bracket is taxed at that rate.`,
      });
    }

    steps.push({
      key: "ca_income_tax",
      label: "California income tax (Tax Rate Schedule)",
      amount: incomeTax,
      explanation: "The sum of every bracket above, from the California rate schedule for this filing status.",
    });
  }

  // ── line 62. Behavioral Health Services Tax ───────────────────────────
  const surtaxResult = applySurtaxes(ruleSet, taxableIncome, steps);

  const totalTax = add(incomeTax, surtaxResult.total);
  if (surtaxResult.total.amountMinor > 0) {
    steps.push({
      key: "ca_total_tax",
      label: "Total estimated California tax",
      amount: totalTax,
      explanation: "California income tax plus the surcharges above.",
    });
  }

  return {
    supported: true,
    jurisdiction,
    // The year whose rules ran, which `ruleSetVersion` pins. Deliberately
    // NOT the requested year when a substitution happened.
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
      // computation begins from — Form 540 line 13.
      grossIncome: federalAgi.amount,
      adjustedGrossIncome: californiaAgi,
      standardDeduction,
      taxableIncome,
      incomeTax,
      // Explicitly zero rather than absent: California levies no state
      // self-employment tax, and a caller adding federal and state totals
      // must not pick this up twice.
      selfEmploymentTax: zero(currency),
      selfEmploymentTaxDeduction: zero(currency),
      surtax: surtaxResult.total,
      totalTax,
    },
    rates: {
      // Deliberately the BRACKET rate. The Behavioral Health Services Tax
      // pushes the true top marginal rate to 13.3%, but reporting 13.3% here
      // would misstate the bracket a person is in for every taxpayer under
      // $1,000,000 and is a separate line on the return.
      //
      // Under the Tax Table this is the rate at the row's midpoint. Inside a
      // table row the literal marginal rate is zero — the tax is flat across
      // the row — which is true but useless for describing where someone
      // sits in the schedule.
      marginalRateBasisPoints,
      // The surcharge IS included here, unlike the marginal rate above and
      // unlike the federal engine's treatment of self-employment tax. The
      // difference is the base: self-employment tax is a different tax on a
      // different base, while the Behavioral Health Services Tax falls on
      // this very taxable income — so including it gives the real rate paid
      // on it, and excluding it would understate what a millionaire owes.
      effectiveRateBasisPoints:
        taxableIncome.amountMinor > 0 ? Math.round((totalTax.amountMinor / taxableIncome.amountMinor) * 10_000) : null,
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
      ? `${fallback.notice} It is not a Form 540, not tax advice, and Countorra does not prepare or file California returns. It does not account for the items listed under what is not modelled.`
      : "An estimate of California state income tax on the figures supplied. It is not a Form 540, not tax advice, and Countorra does not prepare or file California returns. It does not account for the items listed under what is not modelled.",
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
 * Form 540 line 13.
 *
 * Supplied is best — it comes off an actual 1040. Otherwise the FEDERAL
 * engine computes it, because federal AGI is a federal quantity and
 * reimplementing it here would create a second, drifting copy of the
 * self-employment-tax deduction that feeds it.
 *
 * If the federal engine cannot produce a figure for that year, this refuses.
 * That is the no-fallback rule applied to a dependency: California without a
 * real federal AGI is not California with an approximate one.
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
      explanation: "As supplied from the federal return (Form 1040, line 11). California's calculation begins here (Form 540, line 13).",
    });
    return { amount };
  }

  const federal = calculateUsFederalTax(input);
  if (!federal.supported) {
    // `invalid_input`, not `rules_not_published`: nothing is waiting on a
    // publisher here. The input set is simply insufficient, and the fix is
    // in the caller's hands — supply Form 1040 line 11.
    return {
      refusal: {
        supported: false,
        reason: "invalid_input",
        message:
          federal.reason === "invalid_input"
            ? federal.message
            : `California's calculation starts from federal adjusted gross income, and this build can't derive one for ${input.taxYear}. Supply the federal adjusted gross income from Form 1040, line 11.`,
        jurisdiction: "US_CA",
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
    explanation: `Not supplied, so it was computed from the same figures using the federal rule set (version ${federal.ruleSetVersion}), including the deduction for one-half of self-employment tax. California's calculation begins here (Form 540, line 13).`,
  });
  return { amount };
}

/**
 * Surcharges on taxable income, applied after the brackets.
 *
 * Written against the rule set's list rather than against California's one
 * surcharge by name, so a second surcharge — or another state's — is data.
 */
function applySurtaxes(ruleSet: TaxRuleSet, taxableIncome: Money, steps: TaxTraceStep[]): { total: Money } {
  let total = zero(ruleSet.currency);

  for (const surtax of ruleSet.surtaxes ?? []) {
    const excess = Math.max(0, taxableIncome.amountMinor - surtax.thresholdMinor);
    if (excess <= 0) continue;

    const amount = percentageOf(money(excess, ruleSet.currency), surtax.rateBasisPoints / 100);
    steps.push({
      key: surtax.key,
      label: `${surtax.label} (${formatRate(surtax.rateBasisPoints)})`,
      amount,
      explanation: `${formatRate(surtax.rateBasisPoints)} of the ${formatMoneyPlain(money(excess, ruleSet.currency))} of taxable income above ${formatBound(surtax.thresholdMinor)}. Reported on its own line of Form 540 rather than as a tax bracket${surtax.indexed ? "" : ", and its threshold is fixed in statute rather than adjusted for inflation"}.`,
    });
    total = add(total, amount);
  }

  return { total };
}

/** Rejects amounts the state engine will not compute on. The federal engine
 *  validates its own inputs; these are the fields only a state uses. */
function validateStateAmounts(input: TaxCalculationInput): string | null {
  const fields = [
    ["federal adjusted gross income", input.federalAdjustedGrossIncomeMinor],
    ["California additions", input.stateAdditionsMinor],
    ["California subtractions", input.stateSubtractionsMinor],
  ] as const;

  for (const [name, value] of fields) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      return `The ${name} figure isn't a usable amount.`;
    }
  }

  // Negative federal AGI is real — a large business loss produces one — and
  // flows through to a California taxable income of zero. Negative
  // ADJUSTMENTS are not: each column of Schedule CA is a total of positive
  // amounts, and a negative one means the two columns were swapped, which
  // would move income in exactly the wrong direction.
  if ((input.stateAdditionsMinor ?? 0) < 0) return "California additions can't be negative — use the subtractions field instead.";
  if ((input.stateSubtractionsMinor ?? 0) < 0) return "California subtractions can't be negative — use the additions field instead.";

  if (!Number.isInteger(input.taxYear) || input.taxYear < 1900 || input.taxYear > 2200) {
    return "That isn't a usable tax year.";
  }

  return null;
}
