import type { CurrencyCode } from "@/domain/money/currency";

/**
 * The shape of a versioned tax rule set.
 *
 * WHY RULES ARE DATA AND NOT CODE
 *
 * Tax rules change every year, by statute and by inflation adjustment, and a
 * result computed under one year's rules must stay reproducible after the
 * next year's land. Encoding "the 22% bracket starts at $50,400" inside a
 * calculation function makes both impossible: the number cannot be dated,
 * cannot be sourced, and cannot coexist with the same number for a different
 * year.
 *
 * So a rule set is a dated, sourced, versioned record, and the engine is a
 * pure function that consumes one. Adding 2027, or California, is a new
 * record — not a change to the calculation.
 *
 * EVERY AMOUNT IS IN MINOR UNITS
 *
 * Integer cents throughout, per ARCHITECTURE.md's money rule. `$16,100` is
 * `1_610_000`. No float ever touches an authoritative figure.
 */

/** Extensible by design: state engines are added here, not by forking. */
export type TaxJurisdiction = "US_FEDERAL" | "US_CA" | "US_NY" | "US_FL" | "US_TX" | "US_AZ";

/**
 * Filing statuses this product can express. A rule set declares which of
 * them it actually supports, and the engine refuses the rest — a status
 * present in the type but absent from the rule set is unsupported, not
 * silently mapped to a neighbour.
 */
export type FilingStatus = "single" | "married_filing_jointly" | "married_filing_separately" | "head_of_household" | "qualifying_surviving_spouse";

/**
 * One marginal bracket.
 *
 * `upToMinor` is the top of the bracket in TAXABLE income, exclusive-ish in
 * the IRS sense ("over X but not over Y"); `null` is the top bracket. Rates
 * are basis points — integers — so no float appears in the data either.
 */
export interface TaxBracket {
  /** Inclusive lower bound of the bracket, in minor units. */
  fromMinor: number;
  /** Upper bound in minor units; `null` for the highest bracket. */
  upToMinor: number | null;
  /** 1000 = 10.00%. Integer, so the table has no float in it. */
  rateBasisPoints: number;
  /**
   * The PUBLISHED cumulative tax at `fromMinor`, where the authority states
   * its schedule that way.
   *
   * New York's schedules read "$669 plus 4.40% of the excess over $17,150",
   * and those base amounts are printed in whole dollars — which means they
   * are NOT equal to the exact sum of the brackets below them. Reconstructing
   * the tax by summing per-bracket amounts is off by up to a dollar at every
   * threshold, in a way no reader would spot.
   *
   * So where the authority publishes a base, it is transcribed here and
   * `applyPublishedRateSchedule` uses it verbatim. Absent (federal,
   * California) means the schedule is stated only as rates, and
   * `applyProgressiveBrackets` sums the brackets instead.
   */
  baseTaxMinor?: number;
}

/**
 * How far a cited source was actually checked.
 *
 * THIS FIELD EXISTS BECAUSE "CITED" AND "VERIFIED" ARE NOT THE SAME THING,
 * and a tax engine that blurs them is worse than one that cites nothing: a
 * confident-looking citation invites a reader to stop checking.
 *
 * `VERIFIED_PRIMARY_SOURCE` means the document at `url` was opened from this
 * codebase's environment and the cited values were read out of it. Nothing
 * else earns it — a search-engine snippet quoting the document does not, and
 * neither does a summary produced by a model.
 */
export type SourceVerification =
  | "VERIFIED_PRIMARY_SOURCE"
  /**
   * Opened and read from this environment, and official — but not the taxing
   * authority's own statement of the rule.
   *
   * Arizona's Joint Legislative Budget Committee tax handbook is the case
   * this exists for: it is an official Arizona government publication, and it
   * is what establishes that the conditional flat rate in A.R.S. § 43-1011
   * is actually in force. A legislative analyst describing the law is worth
   * less than the Department of Revenue applying it, and the distinction
   * should survive in the data rather than being flattened into "verified".
   */
  | "VERIFIED_OFFICIAL_SECONDARY_SOURCE"
  /** The document could not be reached from this environment. The rule may
   *  still be correct and independently established — but the citation has
   *  NOT been confirmed, and must never be presented as though it had. */
  | "SOURCE_UNVERIFIED_ENVIRONMENT";

/** Where a value came from, recorded per rule set so any figure is traceable
 *  back to the document that established it. */
export interface RuleSource {
  /** e.g. "IRS Rev. Proc. 2025-32" */
  authority: string;
  /**
   * What the document says and WHERE — the locator. Carries the page,
   * section, line or table that holds the cited values, so "where did this
   * number come from" is answerable without re-reading the whole document.
   */
  citation: string;
  url: string;
  /**
   * When the document was actually opened and read, ISO date.
   *
   * ABSENT WHEN IT WAS NOT OPENED. Optional precisely so that an unverified
   * source cannot carry a date implying someone read it.
   */
  retrievedOn?: string;
  /** Required, so every source has to declare how far it was checked. */
  verification: SourceVerification;
  /** Why, when the source is not verified. Required in practice for
   *  `SOURCE_UNVERIFIED_ENVIRONMENT`. */
  verificationNote?: string;
}

/** Self-employment tax parameters. Separate from the income-tax brackets
 *  because they are set by different statutes and adjusted by a different
 *  body — the OASDI wage base comes from SSA, not from a Revenue Procedure. */
export interface SelfEmploymentRules {
  /** Portion of net profit that is subject to SE tax. 9235 = 92.35%. */
  netEarningsBasisPoints: number;
  /** Social Security (OASDI) rate on net earnings. 1240 = 12.40%. */
  socialSecurityRateBasisPoints: number;
  /** Wage base above which OASDI stops. */
  socialSecurityWageBaseMinor: number;
  /** Medicare (HI) rate, uncapped. 290 = 2.90%. */
  medicareRateBasisPoints: number;
  /** Net earnings below this owe no SE tax at all (IRC § 6017). */
  minimumNetEarningsMinor: number;
  /** Share of SE tax deductible when computing AGI (IRC § 164(f)). */
  deductiblePortionBasisPoints: number;
  /** Additional Medicare Tax (IRC § 1401(b)(2)). NOT inflation-adjusted —
   *  the thresholds are fixed in statute and have never been indexed. */
  additionalMedicareRateBasisPoints: number;
  additionalMedicareThresholdMinor: Partial<Record<FilingStatus, number>>;
  source: RuleSource;
}

export interface FilingStatusRules {
  standardDeductionMinor: number;
  /**
   * The smaller standard deduction for someone another taxpayer can claim as
   * a dependent, where the jurisdiction publishes one. New York does, for
   * Single filers ($3,100 against $8,000). Absent means the jurisdiction
   * publishes no separate amount and the ordinary one applies.
   */
  standardDeductionIfClaimedAsDependentMinor?: number;
  brackets: readonly TaxBracket[];
}

/**
 * A flat surcharge levied on taxable income above a threshold, ON TOP of the
 * progressive brackets rather than as another bracket.
 *
 * California's Behavioral Health Services Tax (formerly the Mental Health
 * Services Tax) is one: 1% of taxable income over $1,000,000, reported on its
 * own line of Form 540 rather than folded into the rate schedule. Modelling
 * it as a tenth bracket would be wrong in a way that matters — it would
 * appear in the marginal-rate figure as though the top rate were 13.3%, and
 * it would be computed on the wrong base if the brackets and the surcharge
 * ever diverged.
 */
export interface SurtaxRules {
  /** Stable identifier used as the trace step key. */
  key: string;
  label: string;
  /** Applies to taxable income ABOVE this amount, in minor units. */
  thresholdMinor: number;
  /** 100 = 1.00%. */
  rateBasisPoints: number;
  /**
   * Whether the threshold moves with inflation. California's does not — it
   * is fixed in statute (R&TC § 17043) at $1,000,000 and has never been
   * indexed, so it must not be "updated" alongside the bracket table.
   */
  indexed: boolean;
  source: RuleSource;
}

/**
 * One band of a published tax table, and the width of the intervals inside it.
 *
 * California's 2025 table has two bands: a single $50-wide interval covering
 * $1–$50, then $100-wide intervals from $51 up to $100,000. The last interval
 * of a band is truncated at `toMinor` when the band does not divide evenly —
 * which is exactly how FTB's final row ($99,951–$100,000) is only $50 wide.
 */
export interface TaxTableBand {
  /** First taxable income in the band, minor units, inclusive. */
  fromMinor: number;
  /** Last taxable income in the band, minor units, inclusive. */
  toMinor: number;
  /** Width of each interval in the band, minor units. */
  intervalWidthMinor: number;
}

/**
 * A published tax TABLE, which is not a rate schedule and must not be
 * confused with one.
 *
 * WHY A TABLE EXISTS AT ALL
 *
 * FTB requires the Tax Table for taxable income of $100,000 or less and the
 * Tax Rate Schedules above it. The table is DISCRETE: every income inside an
 * interval pays the same whole-dollar amount, so the tax is a step function,
 * not a continuous one. Running the rate schedule directly on the income
 * would produce a different figure from a filed Form 540 for almost every
 * taxpayer under $100,000 — usually by a dollar or two, occasionally more.
 *
 * HOW FTB CONSTRUCTS EACH ROW
 *
 * The rate schedule is applied to the MIDPOINT of the interval, and the
 * result is rounded to a whole dollar. So the row "$51 – $150" is taxed as
 * though the income were $100.50: 1% × $100.50 = $1.005, printed as $1.
 *
 * This construction was verified, not assumed: all 983 rows recoverable from
 * the published 2025 table reproduce EXACTLY under it, for Single and for
 * Married/RDP Filing Jointly alike, including the short final row. The
 * verbatim rows are kept as an executable oracle in `california-tax-table.test.ts`.
 *
 * One honest caveat about `rounding`: no row of the 2025 table lands on an
 * exact half-dollar, so the published data cannot distinguish half-up from
 * half-even. Half-up is declared because it matches the rounding used
 * everywhere else in this codebase, and the tie does not arise here.
 */
export interface TaxTableRules {
  /** The table governs taxable income at or below this; above it, the rate
   *  schedule applies. FTB sets this at $100,000. */
  appliesUpToMinor: number;
  bands: readonly TaxTableBand[];
  /** Declared rather than implied, so the construction is data and the
   *  calculation cannot quietly use a different one. */
  method: "midpoint_of_interval";
  rounding: "whole_dollar_half_up";
  source: RuleSource;
}


/**
 * ONE OF NEW YORK'S PUBLISHED TAX COMPUTATION WORKSHEETS.
 *
 * WHY THESE EXIST AND WHY SKIPPING THEM WOULD BE WRONG
 *
 * Above $107,650 of New York adjusted gross income, New York does not simply
 * apply its progressive brackets. It RECAPTURES the benefit of the lower
 * brackets, so that a high earner pays their top rate on every dollar rather
 * than on the top slice only. New York publishes this as sixteen numbered
 * worksheets — five or six per filing status — and an engine that stopped at
 * the bracket table would understate a high earner's New York tax by
 * thousands of dollars while looking entirely reasonable.
 *
 * Each worksheet is transcribed as data. The three shapes are New York's own,
 * not an abstraction invented here.
 */
export type HighIncomeWorksheet =
  /**
   * Worksheets 1, 7 and 12 — the phase-in.
   *
   * The whole taxable income is taxed at the flat rate that applies at the
   * top of the band, and the DIFFERENCE from the ordinary bracket tax is
   * phased in across $50,000 of NYAGI above the threshold. Above
   * `phaseInCompleteAtAgiMinor` the flat-rate figure stands on its own —
   * New York's "Stop" instruction.
   */
  | {
      kind: "phase_in";
      /** New York's own worksheet number, so the trace can name the form. */
      id: number;
      agiOverMinor: number;
      agiUpToMinor: number | null;
      taxableIncomeUpToMinor: number;
      flatRateBasisPoints: number;
      phaseInFromMinor: number;
      phaseInRangeMinor: number;
      phaseInCompleteAtAgiMinor: number;
    }
  /**
   * Worksheets 2–5, 8–10 and 13–15 — the recapture.
   *
   * Ordinary bracket tax, plus a published recapture base already fully
   * phased in by the band below, plus this band's incremental benefit phased
   * in across $50,000 of NYAGI above the threshold.
   *
   * `recaptureBaseMinor` and `incrementalBenefitMinor` are PUBLISHED
   * CONSTANTS, transcribed rather than derived: New York's printed values do
   * not follow a single rounding rule (332.70 is printed 333 while 567.60 is
   * printed 567), so any derivation would disagree with the form.
   */
  | {
      kind: "recapture";
      id: number;
      agiOverMinor: number;
      agiUpToMinor: number | null;
      taxableIncomeOverMinor: number;
      taxableIncomeUpToMinor: number | null;
      recaptureBaseMinor: number;
      incrementalBenefitMinor: number;
      phaseInFromMinor: number;
      phaseInRangeMinor: number;
    }
  /**
   * Worksheets 6, 11 and 16 — above $25,000,000 of NYAGI the recapture is
   * total: every dollar of taxable income is taxed at the top rate.
   */
  | {
      kind: "flat_top_rate";
      id: number;
      agiOverMinor: number;
      topRateBasisPoints: number;
    };

export interface HighIncomeRules {
  /** At or below this NYAGI the ordinary rate schedule applies unchanged. */
  ordinaryScheduleUpToAgiMinor: number;
  /** The published worksheets, per filing status. A status with none is one
   *  whose worksheets have not been transcribed, and must not be computed
   *  above the threshold above. */
  worksheets: Partial<Record<FilingStatus, readonly HighIncomeWorksheet[]>>;
  /** Decimal places the published worksheet rounds its phase-in fraction to. */
  phaseInFractionDecimalPlaces: number;
  source: RuleSource;
}

/**
 * A jurisdiction that levies NO individual income tax at all.
 *
 * WHY THIS IS A RULE AND NOT AN ABSENCE
 *
 * Florida's answer is $0, and the difference between "$0 because the law says
 * so" and "$0 because nobody implemented this" is the whole point. An empty
 * rule set would express the second. This expresses the first: a positive,
 * sourced statement that the jurisdiction imposes no tax on individual
 * income, which the engine reports as a result rather than a gap.
 *
 * It also keeps the alternative off the table. Modelling Florida as a single
 * 0% bracket would be a fabricated rate schedule — there is no such schedule
 * to transcribe — and would invite someone to "correct" the rate later.
 */
export interface NoIndividualIncomeTaxRule {
  /** The constitutional or statutory basis, cited. */
  basis: string;
  source: RuleSource;
}

/**
 * An employee payroll contribution that is NOT income tax.
 *
 * California SDI is withheld by the employer, computed on WAGES rather than
 * on taxable income, administered by EDD rather than FTB, and owed whether
 * or not any income tax is. It lives in the rule set because it is a dated,
 * sourced rate like any other — but the income-tax engine never touches it,
 * and `calculateCaliforniaSdi` is a separate entry point for exactly that
 * reason.
 */
export interface PayrollContributionRules {
  key: string;
  label: string;
  /** 130 = 1.30%. */
  rateBasisPoints: number;
  /**
   * Wage ceiling in minor units, or `null` when every dollar of wages is
   * subject. California's ceiling was REMOVED effective 1 January 2024 — EDD
   * states that from that date "all wages are subject to SDI contributions".
   * `null` here is a deliberate statement of current law, not a missing
   * value, and reintroducing a cap would overstate take-home pay.
   */
  wageCeilingMinor: number | null;
  source: RuleSource;
}

export interface TaxRuleSet {
  jurisdiction: TaxJurisdiction;
  taxYear: number;
  /**
   * `<taxYear>.<revision>`. The revision increments when a figure in this
   * record changes — a correction, or a mid-year statutory change — so a
   * stored calculation can name the exact rules it was computed under.
   */
  version: string;
  /** First day the rules apply. */
  effectiveFrom: string;
  /** Last day, or null while the year is open. */
  effectiveTo: string | null;
  currency: CurrencyCode;
  /** Rounding actually applied, stated because it is a legal behaviour
   *  rather than an implementation detail. */
  roundingNote: string;
  sources: readonly RuleSource[];
  /** Only the statuses genuinely modelled. Anything absent is unsupported. */
  filingStatuses: Partial<Record<FilingStatus, FilingStatusRules>>;
  selfEmployment: SelfEmploymentRules | null;

  /**
   * The published tax TABLE for this jurisdiction and year, where one exists
   * and governs part of the range. Absent for the federal rule set, whose
   * table this engine does not model.
   */
  taxTable?: TaxTableRules | null;

  /**
   * A flat per-dependent exemption subtracted after the standard deduction,
   * where the jurisdiction publishes one. New York's is $1,000 per dependent.
   */
  dependentExemptionMinor?: number;

  /** New York's tax computation worksheets. Absent for jurisdictions with no
   *  such mechanism. */
  highIncome?: HighIncomeRules | null;

  /**
   * Set where the jurisdiction levies no individual income tax at all.
   *
   * When present, `filingStatuses` is empty and MUST stay empty: there are no
   * brackets and no standard deduction to model, because none exist. An
   * engine seeing this reports $0 as the jurisdiction's law, not as a
   * calculation.
   */
  noIndividualIncomeTax?: NoIndividualIncomeTaxRule | null;

  /**
   * Surcharges applied to taxable income after the brackets. Omitted where a
   * jurisdiction has none — the federal rule set does not set it.
   */
  surtaxes?: readonly SurtaxRules[];

  /**
   * Employee payroll contributions published for this year. NOT income tax,
   * and never included in any income-tax total. Present so that a single
   * dated, sourced record holds everything published for the jurisdiction
   * and year, and so the payroll figure carries the same version stamp.
   */
  payrollContributions?: readonly PayrollContributionRules[];

  /**
   * Figures the taxing authority has NOT YET PUBLISHED for this year.
   *
   * A non-empty list means this rule set cannot compute income tax, and the
   * engine must return a structured refusal naming these items rather than
   * a number. It exists so that a year can be REGISTERED — carrying its
   * sources, and whichever figures are already established — without the
   * absence of the rest being mistaken for "this jurisdiction is unknown".
   *
   * This is the only honest representation of the state California is in for
   * 2026 as of this writing: the Behavioral Health Services Tax and the SDI
   * rate are published, the bracket thresholds and standard deduction are
   * not. Carrying last year's figures forward under a 2026 label would be a
   * silently wrong answer, which is worse than no answer.
   */
  pendingPublication?: readonly string[];
  /**
   * Federal provisions this rule set does NOT model, stated in the data so
   * the engine can surface them on every result. A user told "your federal
   * tax is $X" deserves to know the list of things that were not considered.
   */
  notModelled: readonly string[];
}
