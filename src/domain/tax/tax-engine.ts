import type { Money } from "@/domain/money/money";
import type { CurrencyCode } from "@/domain/money/currency";
import type { FilingStatus, RuleSource, TaxJurisdiction } from "./rules/types";
import type { CalculationStatus, RuleFallback } from "./rules/resolve-rule-set";

/**
 * The tax engine abstraction (DESIGN brief §12).
 *
 * WHAT CHANGED, AND WHY THIS IS AN EXTENSION RATHER THAN A REPLACEMENT
 *
 * The original interface took `{ organizationId, taxYear, taxableAmountMinor,
 * currency }` and returned an estimate. That shape could not express the
 * inputs a real federal calculation needs — filing status above all — and it
 * threw on failure, which meant "this year isn't supported" reached the UI as
 * an exception rather than an answer.
 *
 * So the input and the result are widened, and the registry, the country
 * modules and the AI tool all keep working against the same abstraction.
 * There is no second tax system.
 *
 * OUTCOMES, NOT EXCEPTIONS
 *
 * `TaxCalculationOutcome` is a discriminated union. An unsupported year, an
 * unsupported filing status and an unsupported jurisdiction are RESULTS —
 * each with a reason code and a sentence safe to show a person. Nothing
 * about them is exceptional, and modelling them as throws is what produced
 * opaque errors in the UI.
 *
 * SCOPE: PERSONAL (INDIVIDUAL) INCOME TAX ONLY
 *
 * Countorra launches as a personal finance and personal tax product
 * (src/domain/organizations/launch-scope.ts). This engine calculates one
 * thing: an individual's income tax — the federal Form 1040 and the resident
 * individual return of each supported state (California Form 540, New York
 * IT-201, Arizona Form 140; Texas and Florida levy no personal income tax).
 * See `TAX_ENGINE_SCOPE`.
 *
 * Self-employment income is in scope because it is part of an INDIVIDUAL's
 * return: net profit from Schedule C and the self-employment tax on
 * Schedule SE are schedules of Form 1040, filed by anyone with side income.
 * No business return — corporate (1120), partnership (1065) or S-corporation
 * (1120-S) — is modelled, and none may be claimed. A workspace recorded as a
 * business is refused by tax preparation rather than given a personal return
 * (src/domain/tax-preparation/completeness.ts).
 */

/**
 * What the tax engine covers, stated once so product copy, the assistant and
 * tests read it from the same place.
 */
export const TAX_ENGINE_SCOPE = {
  returnType: "individual",
  country: "US",
  federal: "Form 1040, including Schedule C net profit and Schedule SE self-employment tax",
  states: {
    US_CA: "California Form 540 (resident individual)",
    US_NY: "New York Form IT-201 (resident individual)",
    US_AZ: "Arizona Form 140 (resident individual)",
    US_TX: "No personal income tax",
    US_FL: "No personal income tax",
  },
  notSupported: ["Business returns (Forms 1120, 1120-S, 1065)", "Payroll or employer tax filings", "Sales and use tax returns", "Filing or submitting any return"],
} as const;

export type UnsupportedReason =
  | "unsupported_jurisdiction"
  | "unsupported_tax_year"
  | "unsupported_filing_status"
  | "currency_mismatch"
  | "invalid_input"
  /**
   * The jurisdiction and year ARE understood, but the taxing authority has
   * not yet released figures the calculation needs.
   *
   * Distinct from `unsupported_tax_year`, which means nobody has modelled
   * the year at all. This one means: we know exactly what is missing, we
   * know who publishes it, and we are refusing rather than substituting last
   * year's numbers. `details` names the missing figures.
   */
  | "rules_not_published";

export interface TaxCalculationInput {
  /** Scoping only — the engine itself is pure and reads no rows. */
  organizationId: string;
  taxYear: number;
  filingStatus: FilingStatus;
  /**
   * Wages, salary and other ordinary income, in minor units. This is the
   * INCOME TAX figure and already includes any W-2 wages.
   */
  ordinaryIncomeMinor: number;
  /** Schedule C net profit, in minor units. May be negative (a loss). */
  selfEmploymentNetProfitMinor?: number;

  /**
   * W-2 wages already subject to Social Security tax — Form W-2 box 3.
   *
   * NOT additional income. `ordinaryIncomeMinor` already counts these for
   * income tax; this field exists solely because the Social Security wage
   * base applies to the COMBINED total of wages and self-employment
   * earnings, with wages counted first.
   *
   * Omitting it means "no W-2 wages", which is right for someone whose only
   * earned income is self-employment, and wrong for someone with a job and
   * side income — the latter would
   * otherwise be charged 12.4% on self-employment earnings that are already
   * over the base. Defaults to zero, so existing callers are unaffected.
   */
  w2SocialSecurityWagesMinor?: number;

  /**
   * W-2 Medicare wages — Form W-2 box 5. Used only for the Additional
   * Medicare Tax threshold, which wages consume before self-employment
   * income reaches it (IRS Topic 560).
   *
   * When Social Security wages are given and this is not, it defaults to the
   * Social Security figure rather than to zero: box 5 is always at least box
   * 3 and is equal for most taxpayers, and defaulting to zero would hand the
   * whole threshold to self-employment income and understate the tax. The
   * substitution is stated in the trace rather than made silently.
   */
  w2MedicareWagesMinor?: number;

  /**
   * Federal adjusted gross income — Form 1040, line 11 — in minor units.
   *
   * STATE ENGINES BEGIN HERE. A California return does not recompute income
   * from scratch: Form 540 line 13 IS federal AGI, and the state adjustments
   * are applied to it. Supplying the figure from an actual 1040 is the
   * accurate path.
   *
   * When omitted, a state engine may derive it by running the federal engine
   * for the same year on the same inputs, and says so in the trace. That
   * requires a federal rule set for that year to exist; where it does not,
   * the state engine refuses rather than guessing.
   *
   * Ignored by the federal engine, which computes AGI itself.
   */
  federalAdjustedGrossIncomeMinor?: number;

  /**
   * State additions to federal AGI — Schedule CA (540), Part I, line 27,
   * column C — in minor units. Defaults to zero.
   *
   * Taken as supplied. This engine does NOT derive, enumerate or check the
   * individual adjustments; doing so would mean modelling every point of
   * California/federal non-conformity, and a half-complete version of that
   * would quietly produce wrong state AGI. What is applied is stated in the
   * trace and listed under what is not modelled.
   */
  stateAdditionsMinor?: number;

  /** State subtractions from federal AGI — Schedule CA (540), Part I, line
   *  27, column B — in minor units. Defaults to zero. Same caveat as above. */
  stateSubtractionsMinor?: number;

  /**
   * Number of dependents, for jurisdictions that grant a flat per-dependent
   * exemption. New York's is $1,000 each and covers DEPENDENTS ONLY — not the
   * taxpayer or spouse, which is the mistake this field invites.
   *
   * Ignored where a jurisdiction has no such exemption.
   */
  dependentCount?: number;

  /**
   * Whether another taxpayer can claim this filer as a dependent.
   *
   * Only matters where a jurisdiction publishes a separate, smaller standard
   * deduction for that case. New York does: $3,100 against $8,000 for a
   * Single filer. Defaults to false, which is the ordinary case.
   */
  claimedAsDependent?: boolean;

  currency: CurrencyCode;
}

/** One line of the calculation, in the order it was performed. */
export interface TaxTraceStep {
  key: string;
  label: string;
  /** Negative for a subtraction, so the trace reads as a running statement. */
  amount: Money;
  explanation: string;
}

export interface TaxRuleSetStamp {
  jurisdiction: TaxJurisdiction;
  taxYear: number;
  /** Recorded on every stored result, so a later correction to the figures
   *  cannot silently restate history. */
  version: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  roundingNote: string;
  sources: readonly RuleSource[];
}

export interface TaxCalculationTotals {
  /**
   * For the federal engine, gross income. For a STATE engine, the federal
   * adjusted gross income the state computation starts from — which is what
   * Form 540 line 13 is. The trace names it precisely either way.
   */
  grossIncome: Money;
  /** Federal AGI for the federal engine; state AGI for a state engine. */
  adjustedGrossIncome: Money;
  standardDeduction: Money;
  taxableIncome: Money;
  /**
   * Tax produced by this jurisdiction's progressive brackets, before any
   * surtax. Named neutrally because the same field carries federal income
   * tax and California income tax — a `federalIncomeTax` key on a California
   * result would be a lie in the data itself.
   */
  incomeTax: Money;
  /** Zero for jurisdictions that levy no self-employment tax, California
   *  among them. Social Security and Medicare are federal. */
  selfEmploymentTax: Money;
  selfEmploymentTaxDeduction: Money;
  /**
   * Surcharges applied on top of the brackets — California's Behavioral
   * Health Services Tax. Zero where the jurisdiction levies none. Kept out
   * of `incomeTax` so the marginal rate stays the bracket rate.
   */
  surtax: Money;
  /** Everything this jurisdiction is owed on these figures. */
  totalTax: Money;
}

/**
 * Which published method produced the figure.
 *
 * Present on every result because the distinction is visible on a filed
 * return: FTB requires the Tax Table below $100,000 of taxable income and the
 * Rate Schedules above it, and the two give different answers. A result that
 * did not say which one ran could not be checked against a Form 540.
 */
export type CalculationMethod =
  | "FEDERAL_RATE_SCHEDULE"
  | "CA_TAX_TABLE"
  | "CA_RATE_SCHEDULE"
  | "NY_RATE_SCHEDULE"
  /** New York above $107,650 of NYAGI: one of the sixteen published tax
   *  computation worksheets, which recapture the lower brackets. */
  | "NY_TAX_COMPUTATION_WORKSHEET"
  /**
   * The jurisdiction levies no individual income tax at all — Florida.
   *
   * Distinct from a calculation that came out at zero. This says the $0 is
   * the jurisdiction's law, with no rate schedule, no table and no brackets
   * behind it, so nobody reads the figure as a missing implementation.
   */
  | "NO_INDIVIDUAL_INCOME_TAX";

export interface SupportedTaxCalculation {
  supported: true;
  jurisdiction: TaxJurisdiction;
  /**
   * The tax year of the rules that ACTUALLY RAN.
   *
   * Equal to `requestedTaxYear` except when a fallback applied, and in that
   * case deliberately different: this is the year whose published figures
   * produced the number, and it is what `ruleSetVersion` pins.
   */
  taxYear: number;
  /** The year the caller asked about. */
  requestedTaxYear: number;
  /**
   * Whether `taxYear` is the year that was asked about. A caller rendering a
   * figure must branch on this — an `ESTIMATE_USING_LATEST_PUBLISHED_RULES`
   * result presented as an authoritative calculation for the requested year
   * is the exact failure the field exists to prevent.
   */
  calculationStatus: CalculationStatus;
  calculationMethod: CalculationMethod;
  /** Set only when the rules used are not the requested year's own. Carries
   *  the reason, the missing figures, and a sentence safe to show a person. */
  fallback: RuleFallback | null;
  ruleSetVersion: string;
  currency: CurrencyCode;
  inputs: {
    filingStatus: FilingStatus;
    ordinaryIncome: Money;
    selfEmploymentNetProfit: Money;
  };
  steps: TaxTraceStep[];
  totals: TaxCalculationTotals;
  rates: {
    /** The rate on the last dollar of taxable income. */
    marginalRateBasisPoints: number;
    /** Tax ÷ taxable income. Null when there is no taxable income. */
    effectiveRateBasisPoints: number | null;
  };
  ruleSet: TaxRuleSetStamp;
  /** What a real return includes and this does not. Attached to every
   *  result, because a figure without it reads as more than it is. */
  notModelled: readonly string[];
  disclaimer: string;
}

export interface UnsupportedTaxCalculation {
  supported: false;
  reason: UnsupportedReason;
  /** Safe to show a user: no stack, no internals, no provider detail. */
  message: string;
  jurisdiction: TaxJurisdiction;
  taxYear: number;
  /**
   * Specifics behind the refusal, safe to show. For `rules_not_published`
   * this is the list of figures the authority has yet to release — the
   * difference between "we can't" and "we can't, and here is exactly what is
   * missing and who publishes it".
   */
  details?: readonly string[];
}

export type TaxCalculationOutcome = SupportedTaxCalculation | UnsupportedTaxCalculation;

/**
 * A jurisdiction's engine.
 *
 * Synchronous and pure — the previous signature returned a Promise for an
 * implementation that never had anything to await. Keeping it sync makes the
 * determinism obvious and the tests trivial.
 */
export interface TaxEngine {
  readonly jurisdiction: TaxJurisdiction;
  calculate(input: TaxCalculationInput): TaxCalculationOutcome;
}

const registry = new Map<TaxJurisdiction, TaxEngine>();

export function registerTaxEngine(engine: TaxEngine): void {
  registry.set(engine.jurisdiction, engine);
}

export function getTaxEngine(jurisdiction: TaxJurisdiction): TaxEngine | undefined {
  return registry.get(jurisdiction);
}

export function isJurisdictionSupported(jurisdiction: TaxJurisdiction): boolean {
  return registry.has(jurisdiction);
}

/**
 * Maps an organization's ISO country to a jurisdiction.
 *
 * Returns null for anything unrecognised rather than defaulting to federal —
 * a German organization must not be handed US brackets.
 */
export function jurisdictionForCountry(countryCode: string): TaxJurisdiction | null {
  return countryCode === "US" ? "US_FEDERAL" : null;
}

/**
 * Maps a US state (or other subdivision) to its state jurisdiction.
 *
 * NULL IS THE ANSWER FOR EVERY STATE BUT CALIFORNIA, and that is the whole
 * point. Nine states levy no individual income tax and the rest each need
 * their own researched rule set; returning `US_FEDERAL` for an unmodelled
 * state would hand someone federal brackets labelled as their state's, and
 * returning `US_CA` would hand them California's. Both are worse than
 * "we don't calculate state tax there".
 *
 * The state code is matched case-insensitively against the two-letter USPS
 * abbreviation. Anything else — including a non-US country — is null.
 */
export function stateJurisdictionFor(countryCode: string, stateCode: string | null | undefined): TaxJurisdiction | null {
  if (countryCode !== "US" || !stateCode) return null;
  const code = stateCode.trim().toUpperCase();
  if (code === "CA") return "US_CA";
  if (code === "NY") return "US_NY";
  // Florida and Texas levy no individual income tax, and saying so is a
  // RESULT worth returning — routing them to null would make those
  // workspaces indistinguishable from an unmodelled state.
  if (code === "FL") return "US_FL";
  if (code === "TX") return "US_TX";
  // Arizona is registered but its 2026 figures are pending, so this routes to
  // an engine that REFUSES with the reason. Returning null instead would say
  // "Arizona isn't modelled", which is a different and less useful answer.
  if (code === "AZ") return "US_AZ";
  return null;
}

export type { FilingStatus, TaxJurisdiction };
