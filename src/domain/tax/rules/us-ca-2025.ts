import type { RuleSource, TaxRuleSet } from "./types";

/**
 * CALIFORNIA INDIVIDUAL INCOME TAX — TAX YEAR 2025.
 *
 * EVERY FIGURE IS TRANSCRIBED FROM THE FTB 2025 PERSONAL INCOME TAX BOOKLET
 * (Form 540 forms and instructions). Nothing here is projected, indexed by
 * hand, or carried over from another year.
 *
 * WHY 2025 EXISTS IN A "CALIFORNIA 2026" ENGINE
 *
 * The engine was built for 2026. As of the date these sources were read, the
 * Franchise Tax Board has published the 2026 Behavioral Health Services Tax
 * and EDD has published the 2026 SDI rate, but FTB has NOT published the
 * 2026 rate schedules or standard deduction — its own 2026 Form 540-ES
 * worksheet directs taxpayers to the 2025 tax table and the 2025 exemption
 * credit. See `us-ca-2026.ts`, which registers 2026 and refuses to compute.
 *
 * 2025 is therefore the most recent California year that CAN be computed
 * from authoritative data, and it is registered under its own tax year so
 * that no 2025 figure can ever be served under a 2026 label. When FTB
 * publishes the 2026 schedules, `us-ca-2026.ts` becomes a data change and
 * nothing else moves.
 *
 * HOW THE BRACKET TABLES WERE VERIFIED
 *
 * The FTB rate schedules state each bracket twice — as a rate on the excess
 * over a threshold, and as a cumulative base dollar amount at that
 * threshold — so the table is self-checking. Worked for Schedule X:
 *
 *   1.00% × $11,079                          =        $110.79 → base ✓
 *   $110.79   + 2.00% × ($26,264 − $11,079)  =        $414.49 → base ✓
 *   $414.49   + 4.00% × ($41,452 − $26,264)  =      $1,022.01 → base ✓
 *   $1,022.01 + 6.00% × ($57,542 − $41,452)  =      $1,987.41 → base ✓
 *   $1,987.41 + 8.00% × ($72,724 − $57,542)  =      $3,201.97 → base ✓
 *   $3,201.97 + 9.30% × ($371,479 − $72,724) =     $30,986.19 → base ✓
 *   $30,986.19 + 10.30% × ($445,771 − $371,479) =  $38,638.27 → base ✓
 *   $38,638.27 + 11.30% × ($742,953 − $445,771) =  $72,219.84 → base ✓
 *
 * and Schedule Y reconciles the same way, ending at $144,439.65 over
 * $1,485,906. A SECOND independent check: every Schedule Y threshold is
 * exactly twice the corresponding Schedule X threshold, which is the
 * structure R&TC § 17041 prescribes. `us-ca-2025.test.ts` re-runs both
 * checks as executable oracles.
 *
 * WHAT THIS IS NOT
 *
 * Not a Form 540, and not California tax preparation or filing. `notModelled`
 * below lists what a real California return includes and this does not, and
 * the engine attaches that list to every result.
 */

const FTB_540_BOOKLET_2025: RuleSource = {
  authority: "California Franchise Tax Board",
  citation:
    "2025 California Personal Income Tax Booklet (Form 540) — section '2025 California Tax Rate Schedules' (Schedule X for Single/Married filing separately; Schedule Y for Married/RDP filing jointly or Qualifying surviving spouse), and the 'California Standard Deduction Chart for Most People' in the Form 540 line 18 instructions ($5,706 / $11,412).",
  url: "https://www.ftb.ca.gov/forms/2025/2025-540-booklet.html",
  retrievedOn: "2026-09-12",
  verification: "VERIFIED_PRIMARY_SOURCE",
};

/** The surcharge is statutory, not indexed, and has its own line on Form 540. */
const FTB_540_BHST_2025: RuleSource = {
  authority: "California Franchise Tax Board",
  citation:
    "2025 Instructions for Form 540, Line 62 — Behavioral Health Services Tax (previously Mental Health Services Tax): \"If your taxable income is more than $1,000,000, compute the Behavioral Health Services Tax using whole dollars only\", at a tax rate of 1%. Renamed by the Behavioral Health Services Act; levied by R&TC § 17043.",
  url: "https://www.ftb.ca.gov/forms/2025/2025-540-booklet.html",
  retrievedOn: "2026-09-12",
  verification: "VERIFIED_PRIMARY_SOURCE",
};

/** The table is a separate publication from the booklet's rate schedules. */
const FTB_TAX_TABLE_2025: RuleSource = {
  authority: "California Franchise Tax Board",
  citation:
    "2025 California Tax Table (Form 540/540NR) — taxable income $1 to $100,000 in $100 intervals (a $50 first row, $1–$50, and a $50 last row, $99,951–$100,000), tax stated in whole dollars for filing statuses 1 or 3, 2 or 5, and 4. All 983 published rows were extracted from this PDF and reproduced exactly by the midpoint construction, in both modelled columns.",
  url: "https://www.ftb.ca.gov/forms/2025/2025-540-taxtable.pdf",
  retrievedOn: "2026-09-12",
  verification: "VERIFIED_PRIMARY_SOURCE",
};

/** Dollars to integer cents, so the tables below read like the source. */
const usd = (dollars: number): number => Math.round(dollars * 100);

export const US_CA_2025: TaxRuleSet = {
  jurisdiction: "US_CA",
  taxYear: 2025,
  // Bumped when any figure in this file changes. A stored calculation records
  // this string, so a later correction cannot silently restate history.
  version: "2025.1",
  effectiveFrom: "2025-01-01",
  effectiveTo: "2025-12-31",
  currency: "USD",
  roundingNote:
    "Follows FTB's own two-method rule: the published 2025 California Tax Table for taxable income of $100,000 or less, and the 2025 California Tax Rate Schedules above it. The Table is discrete — every income inside an interval pays the same whole-dollar amount, computed by applying the rate schedule to the interval midpoint and rounding to a whole dollar. Rate-schedule figures are computed in exact integer cents with BigInt throughout, each bracket rounded half-up to the nearest cent as it is produced, never mid-calculation.",
  sources: [FTB_540_BOOKLET_2025, FTB_TAX_TABLE_2025, FTB_540_BHST_2025],

  filingStatuses: {
    // Schedule X — "Use if your filing status is Single or Married/RDP Filing
    // Separately". Only Single is registered: married/RDP filing separately
    // shares this schedule but differs elsewhere on the return, and shipping
    // a status half-modelled is worse than refusing it.
    single: {
      standardDeductionMinor: usd(5_706),
      brackets: [
        { fromMinor: usd(0), upToMinor: usd(11_079), rateBasisPoints: 100 },
        { fromMinor: usd(11_079), upToMinor: usd(26_264), rateBasisPoints: 200 },
        { fromMinor: usd(26_264), upToMinor: usd(41_452), rateBasisPoints: 400 },
        { fromMinor: usd(41_452), upToMinor: usd(57_542), rateBasisPoints: 600 },
        { fromMinor: usd(57_542), upToMinor: usd(72_724), rateBasisPoints: 800 },
        { fromMinor: usd(72_724), upToMinor: usd(371_479), rateBasisPoints: 930 },
        { fromMinor: usd(371_479), upToMinor: usd(445_771), rateBasisPoints: 1030 },
        { fromMinor: usd(445_771), upToMinor: usd(742_953), rateBasisPoints: 1130 },
        { fromMinor: usd(742_953), upToMinor: null, rateBasisPoints: 1230 },
      ],
    },

    // Schedule Y — "Use if your filing status is Married/RDP Filing Jointly or
    // Qualifying Surviving Spouse/RDP". California registered domestic
    // partners file under this status on the same terms as married couples,
    // which is why the product calls it Married/RDP Filing Jointly.
    married_filing_jointly: {
      standardDeductionMinor: usd(11_412),
      brackets: [
        { fromMinor: usd(0), upToMinor: usd(22_158), rateBasisPoints: 100 },
        { fromMinor: usd(22_158), upToMinor: usd(52_528), rateBasisPoints: 200 },
        { fromMinor: usd(52_528), upToMinor: usd(82_904), rateBasisPoints: 400 },
        { fromMinor: usd(82_904), upToMinor: usd(115_084), rateBasisPoints: 600 },
        { fromMinor: usd(115_084), upToMinor: usd(145_448), rateBasisPoints: 800 },
        { fromMinor: usd(145_448), upToMinor: usd(742_958), rateBasisPoints: 930 },
        { fromMinor: usd(742_958), upToMinor: usd(891_542), rateBasisPoints: 1030 },
        { fromMinor: usd(891_542), upToMinor: usd(1_485_906), rateBasisPoints: 1130 },
        { fromMinor: usd(1_485_906), upToMinor: null, rateBasisPoints: 1230 },
      ],
    },

    // married_filing_separately, head_of_household and
    // qualifying_surviving_spouse are DELIBERATELY absent. FTB publishes
    // Schedule Z for head of household and its standard deduction is
    // $11,412, but the status carries qualification tests this engine does
    // not apply. The engine reports them unsupported rather than
    // approximating with a neighbouring schedule.
  },

  /**
   * THE PUBLISHED 2025 CALIFORNIA TAX TABLE.
   *
   * Structure, transcribed from the published table:
   *
   *   $1 – $50            one $50-wide interval (tax $0 in every column)
   *   $51 – $100,000      $100-wide intervals, the last one truncated to
   *                       $99,951 – $100,000
   *
   * FTB requires this table for taxable income of $100,000 or less; above it
   * the rate schedules apply. See `roundingNote`.
   */
  taxTable: {
    appliesUpToMinor: usd(100_000),
    bands: [
      { fromMinor: usd(1), toMinor: usd(50), intervalWidthMinor: usd(50) },
      { fromMinor: usd(51), toMinor: usd(100_000), intervalWidthMinor: usd(100) },
    ],
    method: "midpoint_of_interval",
    rounding: "whole_dollar_half_up",
    source: FTB_TAX_TABLE_2025,
  },

  // California has NO state self-employment tax. Social Security and
  // Medicare are federal. `null` here is the accurate statement, and it is
  // what stops the shared engine from inventing a state SE liability.
  selfEmployment: null,

  surtaxes: [
    {
      key: "ca_behavioral_health_services_tax",
      label: "Behavioral Health Services Tax",
      thresholdMinor: usd(1_000_000),
      rateBasisPoints: 100, // 1.00%
      // Fixed in statute at $1,000,000 since Proposition 63 (2004) and never
      // indexed — so this is NOT an inflation figure and must not be moved
      // when the bracket table is refreshed.
      indexed: false,
      source: FTB_540_BHST_2025,
    },
  ],

  /**
   * What a real California return includes and this engine does not.
   *
   * Attached to every result. A figure presented without this list would read
   * as "your California tax", when it is "your California tax on the income
   * supplied, before everything below".
   */
  notModelled: [
    "California itemized deductions (Schedule CA (540), Part II) — the standard deduction is always applied",
    "Exemption credits for personal, blind, senior and dependent exemptions, and the AGI limitation that phases them out",
    "Every other California credit, including the renter's credit, the California EITC, the Young Child Tax Credit and the other state tax credit",
    "The specific California adjustments on Schedule CA (540) — additions and subtractions are taken as supplied and are not derived, checked, or enumerated",
    "The Qualified Business Income deduction (IRC § 199A): it is a below-the-line federal deduction, so it never reaches federal AGI, and the Form 540 computation has no line that would apply one. California's treatment of it is not asserted here",
    "California Alternative Minimum Tax (Schedule P)",
    "Preferential rates on capital gains — California taxes them as ordinary income, which this engine does, but no other capital-gain treatment is modelled",
    "Tax on accumulation distributions of trusts, and the other taxes reported on Form 540 line 63",
    "California withholding already suffered and estimated payments already made",
    "State Disability Insurance, which is payroll withholding rather than income tax and is calculated separately",
    "Federal income tax and self-employment tax of any kind",
  ],
};
