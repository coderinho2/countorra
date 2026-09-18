import type { HighIncomeWorksheet, RuleSource, TaxRuleSet } from "./types";

/**
 * NEW YORK STATE PERSONAL INCOME TAX — TAX YEAR 2026.
 *
 * EVERY FIGURE IS TRANSCRIBED FROM ONE PRIMARY DOCUMENT: Form IT-2105-I
 * (2026), the New York State Department of Taxation and Finance instructions
 * for the 2026 estimated income tax payment voucher. That document is stamped
 * "IT-2105-I (2026)" on every page and carries, for tax year 2026:
 *
 *   page 2      the New York State standard deduction table
 *   pages 3–7   the sixteen tax computation worksheets
 *   page 9      the estimated tax worksheet — the NYAGI → taxable income path
 *   page 10     the three New York State tax rate schedules
 *
 * 2026 IS GENUINELY DIFFERENT FROM 2025, WHICH IS WHY NONE OF IT WAS COPIED
 *
 * New York enacted rate reductions effective 1 January 2026. The lower five
 * rates fell:
 *
 *     2025:  4.00%  4.50%  5.25%  5.50%  6.00%
 *     2026:  3.90%  4.40%  5.15%  5.40%  5.90%
 *
 * and every published base amount moved with them — the Single schedule's
 * base at $13,900 is $586 for 2026 against $600 for 2025. Carrying 2025's
 * schedule forward under a 2026 label would have overstated the tax for
 * essentially every New Yorker. The top four rates (6.85%, 9.65%, 10.3%,
 * 10.9%) are unchanged, which is a fact about 2026 and not an assumption.
 *
 * The 2025 figures in that comparison are not guesses either. They are read
 * from the 2025 Form IT-201-I, "Single and married filing separately — filing
 * status 1 and 3" rate schedule, at
 * https://www.tax.ny.gov/forms/current-forms/it/it201i.htm — which is quoted
 * here rather than listed under `sources` because it establishes nothing in
 * this rule set; it only shows that 2026 differs.
 *
 * HOW THE SCHEDULES WERE VERIFIED
 *
 * New York prints each bracket as "$X plus R% of the excess over $T", so the
 * base amounts and the rates check each other: recomputing any base from the
 * base below it and the intervening rate must reproduce the printed figure.
 * All 24 published bases across the three schedules reconcile to the dollar.
 * `us-ny-2026.test.ts` re-runs that reconciliation as an executable oracle.
 *
 * The recapture constants are self-checking too, and independently: each
 * worksheet's recapture base equals the previous worksheet's base plus its
 * incremental benefit, in all three filing-status groups. Both checks would
 * fail on a single mistyped digit.
 *
 * WHAT THIS IS NOT
 *
 * Not a Form IT-201, and not New York tax preparation or filing. It models
 * New York STATE tax only — New York City, Yonkers and the MCTMT are
 * separate taxes and are deliberately absent. `notModelled` lists the rest
 * and travels on every result.
 */

const NY_IT2105I_2026: RuleSource = {
  authority: "New York State Department of Taxation and Finance",
  citation:
    "Form IT-2105-I (2026), Instructions for Form IT-2105, Estimated Income Tax Payment Voucher for Individuals — New York State standard deduction table (page 2), tax computation worksheets 1–16 (pages 3–7), estimated tax worksheet (page 9), and New York State tax rates (page 10).",
  // The YEAR-STAMPED url, not /pdf/current_forms/. The source audit caught
  // that "current_forms" is a moving target: it will serve the 2027 edition
  // next year and silently invalidate every citation below. Both paths serve
  // the identical file today (393,296 bytes).
  url: "https://www.tax.ny.gov/pdf/2026/inc/it2105i_2026.pdf",
  retrievedOn: "2026-09-12",
  verification: "VERIFIED_PRIMARY_SOURCE",
};

/** Establishes that the RETURN tax tables stop at 2025 — see `notModelled`. */
const NY_TAX_TABLES_INDEX: RuleSource = {
  authority: "New York State Department of Taxation and Finance",
  citation:
    "Tax rates and tables — the published New York tax rate and tax table pages list 2025 as the most recent year; no 2026 tax table is published. Page last reviewed or updated: November 18, 2025.",
  url: "https://www.tax.ny.gov/pit/file/tax-tables/",
  retrievedOn: "2026-09-12",
  verification: "VERIFIED_PRIMARY_SOURCE",
};

/** Dollars to integer cents, so the tables below read like the source. */
const usd = (dollars: number): number => Math.round(dollars * 100);

/** New York's rates, as basis points. Unchanged across all three schedules. */
const R = { t390: 390, t440: 440, t515: 515, t540: 540, t590: 590, t685: 685, t965: 965, t1030: 1030, t1090: 1090 } as const;

const PHASE_IN_RANGE = usd(50_000);
const RECAPTURE_STARTS_AT = usd(107_650);
const PHASE_IN_COMPLETE_AT = usd(157_650); // 107,650 + 50,000, and NY prints it
const TOP_BAND_AGI = usd(25_000_000);

/**
 * Married filing jointly and qualifying surviving spouse — worksheets 1–6.
 */
const WORKSHEETS_JOINT: readonly HighIncomeWorksheet[] = [
  {
    kind: "phase_in",
    id: 1,
    agiOverMinor: RECAPTURE_STARTS_AT,
    agiUpToMinor: TOP_BAND_AGI,
    taxableIncomeUpToMinor: usd(161_550),
    flatRateBasisPoints: R.t540,
    phaseInFromMinor: RECAPTURE_STARTS_AT,
    phaseInRangeMinor: PHASE_IN_RANGE,
    phaseInCompleteAtAgiMinor: PHASE_IN_COMPLETE_AT,
  },
  {
    kind: "recapture",
    id: 2,
    agiOverMinor: usd(161_550),
    agiUpToMinor: TOP_BAND_AGI,
    taxableIncomeOverMinor: usd(161_550),
    taxableIncomeUpToMinor: usd(323_200),
    recaptureBaseMinor: usd(333),
    incrementalBenefitMinor: usd(807),
    phaseInFromMinor: usd(161_550),
    phaseInRangeMinor: PHASE_IN_RANGE,
  },
  {
    kind: "recapture",
    id: 3,
    agiOverMinor: usd(323_200),
    agiUpToMinor: TOP_BAND_AGI,
    taxableIncomeOverMinor: usd(323_200),
    taxableIncomeUpToMinor: usd(2_155_350),
    recaptureBaseMinor: usd(1_140), // 333 + 807
    incrementalBenefitMinor: usd(3_071),
    phaseInFromMinor: usd(323_200),
    phaseInRangeMinor: PHASE_IN_RANGE,
  },
  {
    kind: "recapture",
    id: 4,
    agiOverMinor: usd(2_155_350),
    agiUpToMinor: TOP_BAND_AGI,
    taxableIncomeOverMinor: usd(2_155_350),
    taxableIncomeUpToMinor: usd(5_000_000),
    recaptureBaseMinor: usd(4_211), // 1,140 + 3,071
    incrementalBenefitMinor: usd(60_350),
    phaseInFromMinor: usd(2_155_350),
    phaseInRangeMinor: PHASE_IN_RANGE,
  },
  {
    kind: "recapture",
    id: 5,
    agiOverMinor: usd(5_000_000),
    agiUpToMinor: TOP_BAND_AGI,
    taxableIncomeOverMinor: usd(5_000_000),
    taxableIncomeUpToMinor: null,
    recaptureBaseMinor: usd(64_561), // 4,211 + 60,350
    incrementalBenefitMinor: usd(32_500),
    phaseInFromMinor: usd(5_000_000),
    phaseInRangeMinor: PHASE_IN_RANGE,
  },
  { kind: "flat_top_rate", id: 6, agiOverMinor: TOP_BAND_AGI, topRateBasisPoints: R.t1090 },
];

/** Single and married filing separately — worksheets 7–11. */
const WORKSHEETS_SINGLE: readonly HighIncomeWorksheet[] = [
  {
    kind: "phase_in",
    id: 7,
    agiOverMinor: RECAPTURE_STARTS_AT,
    agiUpToMinor: TOP_BAND_AGI,
    taxableIncomeUpToMinor: usd(215_400),
    flatRateBasisPoints: R.t590,
    phaseInFromMinor: RECAPTURE_STARTS_AT,
    phaseInRangeMinor: PHASE_IN_RANGE,
    phaseInCompleteAtAgiMinor: PHASE_IN_COMPLETE_AT,
  },
  {
    kind: "recapture",
    id: 8,
    agiOverMinor: usd(215_400),
    agiUpToMinor: TOP_BAND_AGI,
    taxableIncomeOverMinor: usd(215_400),
    taxableIncomeUpToMinor: usd(1_077_550),
    recaptureBaseMinor: usd(567),
    incrementalBenefitMinor: usd(2_047),
    phaseInFromMinor: usd(215_400),
    phaseInRangeMinor: PHASE_IN_RANGE,
  },
  {
    kind: "recapture",
    id: 9,
    agiOverMinor: usd(1_077_550),
    agiUpToMinor: TOP_BAND_AGI,
    taxableIncomeOverMinor: usd(1_077_550),
    taxableIncomeUpToMinor: usd(5_000_000),
    recaptureBaseMinor: usd(2_614), // 567 + 2,047
    incrementalBenefitMinor: usd(30_172),
    phaseInFromMinor: usd(1_077_550),
    phaseInRangeMinor: PHASE_IN_RANGE,
  },
  {
    kind: "recapture",
    id: 10,
    agiOverMinor: usd(5_000_000),
    agiUpToMinor: TOP_BAND_AGI,
    taxableIncomeOverMinor: usd(5_000_000),
    taxableIncomeUpToMinor: null,
    recaptureBaseMinor: usd(32_786), // 2,614 + 30,172
    incrementalBenefitMinor: usd(32_500),
    phaseInFromMinor: usd(5_000_000),
    phaseInRangeMinor: PHASE_IN_RANGE,
  },
  { kind: "flat_top_rate", id: 11, agiOverMinor: TOP_BAND_AGI, topRateBasisPoints: R.t1090 },
];

/** Head of household — worksheets 12–16. */
const WORKSHEETS_HEAD_OF_HOUSEHOLD: readonly HighIncomeWorksheet[] = [
  {
    kind: "phase_in",
    id: 12,
    agiOverMinor: RECAPTURE_STARTS_AT,
    agiUpToMinor: TOP_BAND_AGI,
    taxableIncomeUpToMinor: usd(269_300),
    flatRateBasisPoints: R.t590,
    phaseInFromMinor: RECAPTURE_STARTS_AT,
    phaseInRangeMinor: PHASE_IN_RANGE,
    phaseInCompleteAtAgiMinor: PHASE_IN_COMPLETE_AT,
  },
  {
    kind: "recapture",
    id: 13,
    agiOverMinor: usd(269_300),
    agiUpToMinor: TOP_BAND_AGI,
    taxableIncomeOverMinor: usd(269_300),
    taxableIncomeUpToMinor: usd(1_616_450),
    recaptureBaseMinor: usd(787),
    incrementalBenefitMinor: usd(2_559),
    phaseInFromMinor: usd(269_300),
    phaseInRangeMinor: PHASE_IN_RANGE,
  },
  {
    kind: "recapture",
    id: 14,
    agiOverMinor: usd(1_616_450),
    agiUpToMinor: TOP_BAND_AGI,
    taxableIncomeOverMinor: usd(1_616_450),
    taxableIncomeUpToMinor: usd(5_000_000),
    recaptureBaseMinor: usd(3_346), // 787 + 2,559
    incrementalBenefitMinor: usd(45_260),
    phaseInFromMinor: usd(1_616_450),
    phaseInRangeMinor: PHASE_IN_RANGE,
  },
  {
    kind: "recapture",
    id: 15,
    agiOverMinor: usd(5_000_000),
    agiUpToMinor: TOP_BAND_AGI,
    taxableIncomeOverMinor: usd(5_000_000),
    taxableIncomeUpToMinor: null,
    recaptureBaseMinor: usd(48_606), // 3,346 + 45,260
    incrementalBenefitMinor: usd(32_500),
    phaseInFromMinor: usd(5_000_000),
    phaseInRangeMinor: PHASE_IN_RANGE,
  },
  { kind: "flat_top_rate", id: 16, agiOverMinor: TOP_BAND_AGI, topRateBasisPoints: R.t1090 },
];

export const US_NY_2026: TaxRuleSet = {
  jurisdiction: "US_NY",
  taxYear: 2026,
  // Bumped when any figure in this file changes. A stored calculation records
  // this string, so a later correction cannot silently restate history.
  version: "2026.1",
  effectiveFrom: "2026-01-01",
  effectiveTo: "2026-12-31",
  currency: "USD",
  roundingNote:
    "Follows Form IT-2105-I (2026): the New York State tax rate schedules, applied as New York publishes them — a printed whole-dollar base plus the rate on the excess over the threshold, NOT a sum of per-bracket amounts, which would disagree with the schedule by up to a dollar at every income. Above $107,650 of New York adjusted gross income the prescribed tax computation worksheet is applied instead, with the phase-in fraction rounded to four decimal places exactly as the worksheet directs. Everything is computed in integer cents; New York's own forms are completed in whole dollars, and that final rounding is the filer's to apply.",
  sources: [NY_IT2105I_2026, NY_TAX_TABLES_INDEX],

  filingStatuses: {
    // Page 10, first schedule — the $161,550 and $323,200 thresholds are the
    // ones worksheets 1–6 key on, which is what ties this schedule to the
    // joint filing statuses.
    married_filing_jointly: {
      standardDeductionMinor: usd(16_050),
      brackets: [
        { fromMinor: usd(0), upToMinor: usd(17_150), rateBasisPoints: R.t390, baseTaxMinor: usd(0) },
        { fromMinor: usd(17_150), upToMinor: usd(23_600), rateBasisPoints: R.t440, baseTaxMinor: usd(669) },
        { fromMinor: usd(23_600), upToMinor: usd(27_900), rateBasisPoints: R.t515, baseTaxMinor: usd(953) },
        { fromMinor: usd(27_900), upToMinor: usd(161_550), rateBasisPoints: R.t540, baseTaxMinor: usd(1_174) },
        { fromMinor: usd(161_550), upToMinor: usd(323_200), rateBasisPoints: R.t590, baseTaxMinor: usd(8_391) },
        { fromMinor: usd(323_200), upToMinor: usd(2_155_350), rateBasisPoints: R.t685, baseTaxMinor: usd(17_928) },
        { fromMinor: usd(2_155_350), upToMinor: usd(5_000_000), rateBasisPoints: R.t965, baseTaxMinor: usd(143_430) },
        { fromMinor: usd(5_000_000), upToMinor: usd(25_000_000), rateBasisPoints: R.t1030, baseTaxMinor: usd(417_939) },
        { fromMinor: usd(25_000_000), upToMinor: null, rateBasisPoints: R.t1090, baseTaxMinor: usd(2_477_939) },
      ],
    },

    // Qualifying surviving spouse shares the joint schedule and the joint
    // standard deduction. Duplicated rather than aliased so that a future
    // year in which New York separates them is a data change here and not a
    // silent inheritance.
    qualifying_surviving_spouse: {
      standardDeductionMinor: usd(16_050),
      brackets: [
        { fromMinor: usd(0), upToMinor: usd(17_150), rateBasisPoints: R.t390, baseTaxMinor: usd(0) },
        { fromMinor: usd(17_150), upToMinor: usd(23_600), rateBasisPoints: R.t440, baseTaxMinor: usd(669) },
        { fromMinor: usd(23_600), upToMinor: usd(27_900), rateBasisPoints: R.t515, baseTaxMinor: usd(953) },
        { fromMinor: usd(27_900), upToMinor: usd(161_550), rateBasisPoints: R.t540, baseTaxMinor: usd(1_174) },
        { fromMinor: usd(161_550), upToMinor: usd(323_200), rateBasisPoints: R.t590, baseTaxMinor: usd(8_391) },
        { fromMinor: usd(323_200), upToMinor: usd(2_155_350), rateBasisPoints: R.t685, baseTaxMinor: usd(17_928) },
        { fromMinor: usd(2_155_350), upToMinor: usd(5_000_000), rateBasisPoints: R.t965, baseTaxMinor: usd(143_430) },
        { fromMinor: usd(5_000_000), upToMinor: usd(25_000_000), rateBasisPoints: R.t1030, baseTaxMinor: usd(417_939) },
        { fromMinor: usd(25_000_000), upToMinor: null, rateBasisPoints: R.t1090, baseTaxMinor: usd(2_477_939) },
      ],
    },

    // Page 10, second schedule — Single and married filing separately.
    single: {
      standardDeductionMinor: usd(8_000),
      // New York publishes a separate, smaller amount for someone another
      // taxpayer can claim as a dependent.
      standardDeductionIfClaimedAsDependentMinor: usd(3_100),
      brackets: [
        { fromMinor: usd(0), upToMinor: usd(8_500), rateBasisPoints: R.t390, baseTaxMinor: usd(0) },
        { fromMinor: usd(8_500), upToMinor: usd(11_700), rateBasisPoints: R.t440, baseTaxMinor: usd(332) },
        { fromMinor: usd(11_700), upToMinor: usd(13_900), rateBasisPoints: R.t515, baseTaxMinor: usd(473) },
        { fromMinor: usd(13_900), upToMinor: usd(80_650), rateBasisPoints: R.t540, baseTaxMinor: usd(586) },
        { fromMinor: usd(80_650), upToMinor: usd(215_400), rateBasisPoints: R.t590, baseTaxMinor: usd(4_191) },
        { fromMinor: usd(215_400), upToMinor: usd(1_077_550), rateBasisPoints: R.t685, baseTaxMinor: usd(12_141) },
        { fromMinor: usd(1_077_550), upToMinor: usd(5_000_000), rateBasisPoints: R.t965, baseTaxMinor: usd(71_198) },
        { fromMinor: usd(5_000_000), upToMinor: usd(25_000_000), rateBasisPoints: R.t1030, baseTaxMinor: usd(449_714) },
        { fromMinor: usd(25_000_000), upToMinor: null, rateBasisPoints: R.t1090, baseTaxMinor: usd(2_509_714) },
      ],
    },

    married_filing_separately: {
      standardDeductionMinor: usd(8_000),
      brackets: [
        { fromMinor: usd(0), upToMinor: usd(8_500), rateBasisPoints: R.t390, baseTaxMinor: usd(0) },
        { fromMinor: usd(8_500), upToMinor: usd(11_700), rateBasisPoints: R.t440, baseTaxMinor: usd(332) },
        { fromMinor: usd(11_700), upToMinor: usd(13_900), rateBasisPoints: R.t515, baseTaxMinor: usd(473) },
        { fromMinor: usd(13_900), upToMinor: usd(80_650), rateBasisPoints: R.t540, baseTaxMinor: usd(586) },
        { fromMinor: usd(80_650), upToMinor: usd(215_400), rateBasisPoints: R.t590, baseTaxMinor: usd(4_191) },
        { fromMinor: usd(215_400), upToMinor: usd(1_077_550), rateBasisPoints: R.t685, baseTaxMinor: usd(12_141) },
        { fromMinor: usd(1_077_550), upToMinor: usd(5_000_000), rateBasisPoints: R.t965, baseTaxMinor: usd(71_198) },
        { fromMinor: usd(5_000_000), upToMinor: usd(25_000_000), rateBasisPoints: R.t1030, baseTaxMinor: usd(449_714) },
        { fromMinor: usd(25_000_000), upToMinor: null, rateBasisPoints: R.t1090, baseTaxMinor: usd(2_509_714) },
      ],
    },

    // Page 10, third schedule — explicitly headed "Head of household".
    head_of_household: {
      standardDeductionMinor: usd(11_200),
      brackets: [
        { fromMinor: usd(0), upToMinor: usd(12_800), rateBasisPoints: R.t390, baseTaxMinor: usd(0) },
        { fromMinor: usd(12_800), upToMinor: usd(17_650), rateBasisPoints: R.t440, baseTaxMinor: usd(499) },
        { fromMinor: usd(17_650), upToMinor: usd(20_900), rateBasisPoints: R.t515, baseTaxMinor: usd(712) },
        { fromMinor: usd(20_900), upToMinor: usd(107_650), rateBasisPoints: R.t540, baseTaxMinor: usd(879) },
        { fromMinor: usd(107_650), upToMinor: usd(269_300), rateBasisPoints: R.t590, baseTaxMinor: usd(5_564) },
        { fromMinor: usd(269_300), upToMinor: usd(1_616_450), rateBasisPoints: R.t685, baseTaxMinor: usd(15_101) },
        { fromMinor: usd(1_616_450), upToMinor: usd(5_000_000), rateBasisPoints: R.t965, baseTaxMinor: usd(107_381) },
        { fromMinor: usd(5_000_000), upToMinor: usd(25_000_000), rateBasisPoints: R.t1030, baseTaxMinor: usd(433_894) },
        { fromMinor: usd(25_000_000), upToMinor: null, rateBasisPoints: R.t1090, baseTaxMinor: usd(2_493_894) },
      ],
    },
  },

  // New York levies no state self-employment tax. Social Security and
  // Medicare are federal.
  selfEmployment: null,

  /** Page 9, line 4: "multiply $1,000 by number of dependents". */
  dependentExemptionMinor: usd(1_000),

  highIncome: {
    ordinaryScheduleUpToAgiMinor: RECAPTURE_STARTS_AT,
    worksheets: {
      married_filing_jointly: WORKSHEETS_JOINT,
      qualifying_surviving_spouse: WORKSHEETS_JOINT,
      single: WORKSHEETS_SINGLE,
      married_filing_separately: WORKSHEETS_SINGLE,
      head_of_household: WORKSHEETS_HEAD_OF_HOUSEHOLD,
    },
    phaseInFractionDecimalPlaces: 4,
    source: NY_IT2105I_2026,
  },

  // New York publishes no tax TABLE for 2026. Its return tax tables end at
  // 2025, and the 2026 estimated-tax instructions direct filers to the rate
  // schedules at every income. So the schedule is what runs — and that is
  // New York's own 2026 instruction, not a substitution. See `notModelled`.
  taxTable: null,

  /**
   * What a real Form IT-201 includes and this engine does not.
   *
   * Attached to every result. A figure presented without this list would read
   * as "your New York tax", when it is "your New York State tax on the income
   * supplied, before everything below".
   */
  notModelled: [
    "New York itemized deductions (Form IT-196), including the limitation that applies above $100,000 of NYAGI — the standard deduction is always applied",
    "The New York State tax table, which a filed Form IT-201 uses below $65,000 of taxable income. New York has not published a 2026 table; its 2026 estimated-tax instructions use the rate schedules at every income, and so does this engine. A filed 2026 return may differ by a small amount once that table is published",
    "Every New York credit, including the household credit, the Empire State child credit, the earned income credit, the college tuition credit and the child and dependent care credit",
    "The specific New York additions and subtractions on Form IT-225 and Form IT-201 — they are taken as supplied and are not derived, checked, or enumerated",
    "New York City resident tax, the NYC school tax credit and the other NYC credits — a separate tax on a separate base, and out of scope for this jurisdiction",
    "Yonkers resident income tax surcharge and Yonkers nonresident earnings tax",
    "The metropolitan commuter transportation mobility tax (MCTMT)",
    "Other New York taxes reported on Form IT-201-ATT, including the tax on the ordinary income portion of a lump-sum distribution",
    "Nonresident and part-year resident computations (Form IT-203) — this engine models full-year residents only",
    "New York withholding already suffered and estimated payments already made",
    "Federal income tax and self-employment tax of any kind",
  ],
};
