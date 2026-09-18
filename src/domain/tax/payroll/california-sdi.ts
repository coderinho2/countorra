import { money, percentageOf, type Money } from "@/domain/money/money";
import type { CurrencyCode } from "@/domain/money/currency";
import { capAt } from "../calculation/brackets";
import { findRuleSet } from "../rules/registry";
import type { RuleSource } from "../rules/types";

/**
 * CALIFORNIA STATE DISABILITY INSURANCE — A PAYROLL CONTRIBUTION, NOT A TAX
 * ON INCOME.
 *
 * WHY THIS IS A SEPARATE ENTRY POINT AND NOT A LINE IN THE TAX ENGINE
 *
 * SDI is a different thing in every respect that matters:
 *
 *   • It is computed on WAGES, not on taxable income — no deductions, no
 *     adjustments, no filing status, no brackets.
 *   • It is administered by EDD, not by the Franchise Tax Board.
 *   • The employer withholds it from each paycheque; it is not settled on a
 *     Form 540.
 *   • It is owed in full by someone whose California income tax is zero.
 *
 * Adding it to a California income tax total would overstate that total and
 * misname what the money is. So `calculateCaliforniaTax` never sees it, and
 * the only way to a figure is this function, asked for deliberately.
 *
 * THE 2026 RATE AND THE CEILING THAT NO LONGER EXISTS
 *
 * For 2026 EDD publishes 1.3% with NO taxable wage ceiling. The ceiling was
 * removed effective 1 January 2024 — EDD states that from that date "all
 * wages are subject to SDI contributions". Before that, withholding
 * stopped once wages passed a cap. Code written against the old rule — or a
 * rule set that reintroduced a cap "for safety" — understates the
 * withholding on every high earner in the state, and does so silently. The
 * rule set carries `wageCeilingMinor: null` to say the absence is a fact
 * rather than a gap, and this function honours a ceiling only where one is
 * actually published.
 *
 * NOT A PAYROLL SYSTEM. This computes the employee contribution on a wage
 * figure supplied to it. It does not run payroll, does not know about pay
 * periods, and does not handle the separate employer-side contributions
 * (UI and ETT) that EDD also administers.
 */

export interface CaliforniaSdiInput {
  taxYear: number;
  /** Wages subject to SDI, in minor units. */
  wagesMinor: number;
  currency: CurrencyCode;
}

export interface CaliforniaSdiSupported {
  supported: true;
  taxYear: number;
  /** The California rule-set version these figures came from, so a stored
   *  payroll figure is as reproducible as a stored tax figure. */
  ruleSetVersion: string;
  rateBasisPoints: number;
  /** Null means every dollar of wages is subject — current California law. */
  wageCeilingMinor: number | null;
  wages: Money;
  /** Wages actually exposed to the rate, after any ceiling. */
  wagesSubject: Money;
  contribution: Money;
  source: RuleSource;
  note: string;
}

export interface CaliforniaSdiUnsupported {
  supported: false;
  reason: "unsupported_tax_year" | "rules_not_published" | "currency_mismatch" | "invalid_input";
  message: string;
  taxYear: number;
}

export type CaliforniaSdiOutcome = CaliforniaSdiSupported | CaliforniaSdiUnsupported;

export function calculateCaliforniaSdi(input: CaliforniaSdiInput): CaliforniaSdiOutcome {
  const ruleSet = findRuleSet("US_CA", input.taxYear);
  if (!ruleSet) {
    return {
      supported: false,
      reason: "unsupported_tax_year",
      message: "This California tax year is not currently supported.",
      taxYear: input.taxYear,
    };
  }

  // NOTE the asymmetry with income tax, and that it is deliberate: a year
  // whose income-tax schedules are unpublished can still have a published
  // SDI rate, because EDD and FTB publish on their own timetables. 2026 is
  // exactly that case, so this is checked per-contribution rather than
  // gated on the rule set's `pendingPublication`.
  const rules = ruleSet.payrollContributions?.find((contribution) => contribution.key === "ca_sdi");
  if (!rules) {
    return {
      supported: false,
      reason: "rules_not_published",
      message: `The California SDI rate for ${input.taxYear} has not been established from an authoritative EDD source.`,
      taxYear: input.taxYear,
    };
  }

  if (input.currency !== ruleSet.currency) {
    return {
      supported: false,
      reason: "currency_mismatch",
      message: `California SDI is calculated in ${ruleSet.currency}. This workspace's figures are in ${input.currency}.`,
      taxYear: input.taxYear,
    };
  }

  if (!Number.isFinite(input.wagesMinor) || !Number.isSafeInteger(input.wagesMinor)) {
    return { supported: false, reason: "invalid_input", message: "That wage figure isn't a usable amount.", taxYear: input.taxYear };
  }
  if (input.wagesMinor < 0) {
    return { supported: false, reason: "invalid_input", message: "Wages can't be negative.", taxYear: input.taxYear };
  }

  const wages = money(input.wagesMinor, ruleSet.currency);
  const wagesSubject = rules.wageCeilingMinor === null ? wages : capAt(wages, rules.wageCeilingMinor);
  const contribution = percentageOf(wagesSubject, rules.rateBasisPoints / 100);

  return {
    supported: true,
    taxYear: ruleSet.taxYear,
    ruleSetVersion: ruleSet.version,
    rateBasisPoints: rules.rateBasisPoints,
    wageCeilingMinor: rules.wageCeilingMinor,
    wages,
    wagesSubject,
    contribution,
    source: rules.source,
    note:
      rules.wageCeilingMinor === null
        ? `${rules.rateBasisPoints / 100}% of all wages. California has had no SDI taxable wage ceiling since 1 January 2024, so every dollar of wages is subject. This is payroll withholding administered by EDD — it is not California income tax and is not included in any income tax total.`
        : `${rules.rateBasisPoints / 100}% of wages up to $${(rules.wageCeilingMinor / 100).toLocaleString("en-US")}. This is payroll withholding administered by EDD — it is not California income tax and is not included in any income tax total.`,
  };
}
