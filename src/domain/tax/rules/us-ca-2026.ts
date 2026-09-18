import type { RuleSource, TaxRuleSet } from "./types";

/**
 * CALIFORNIA — TAX YEAR 2026. REGISTERED, PARTIALLY PUBLISHED.
 *
 * THE SITUATION THIS FILE RECORDS
 *
 * Two 2026 California figures are published and authoritative:
 *
 *   • The Behavioral Health Services Tax — 1% of taxable income over
 *     $1,000,000 — is stated for 2026 in FTB's own 2026 Form 540-ES
 *     instructions. It is statutory and unindexed, so it does not wait on
 *     the annual inflation adjustment.
 *
 *   • The 2026 SDI employee contribution rate — 1.3%, with no taxable wage
 *     ceiling — is published by EDD. It is payroll withholding, not income
 *     tax, and is reachable only through `calculateCaliforniaSdi`.
 *
 * The rest is NOT published. FTB's rate-schedule listing stops at 2025, and
 * FTB's own 2026 Estimated Tax Worksheet tells taxpayers to figure 2026 tax
 * "using the 2025 tax table for Form 540" and to take the exemption credit
 * "from the 2025 instructions for Form 540". The standard deduction the same
 * worksheet prints — $5,706 / $11,412 — is verifiably the 2025 amount: it is
 * identical to the figure in the 2025 Form 540 booklet's standard deduction
 * chart. It is a stand-in for estimating, not a published 2026 amount.
 *
 * WHY THIS FILE EXISTS AT ALL INSTEAD OF SIMPLY BEING ABSENT
 *
 * Leaving 2026 unregistered would make `US_CA` + 2026 indistinguishable from
 * a jurisdiction nobody has ever looked at — "unsupported tax year", which
 * reads as "we don't do California". Registering it with an explicit
 * `pendingPublication` list lets the engine say the true thing: California
 * 2026 is understood, these specific figures have not been released by FTB,
 * and here are the ones that have.
 *
 * WHAT MUST NOT HAPPEN HERE
 *
 * The 2025 brackets must not be copied in under a 2026 label, and the 3.0%
 * CCPI change must not be applied by hand to manufacture thresholds. Either
 * would produce a confident, wrong, unfalsifiable number. When FTB publishes
 * the 2026 schedules: fill in `filingStatuses`, empty `pendingPublication`,
 * and bump `version`. Nothing else in the codebase changes.
 */

/** Primary 2026 source. Establishes the surcharge, and — read together with
 *  the 2025 booklet — establishes that the rate schedules are not yet out. */
const FTB_540_ES_2026: RuleSource = {
  authority: "California Franchise Tax Board",
  citation:
    "2026 Instructions for Form 540-ES, Section D — Behavioral Health Services Tax (previously Mental Health Services Tax): taxable income over $1,000,000, tax rate 1%. The same worksheet directs filers to the 2025 tax table and the 2025 exemption credit, the 2026 figures not having been published.",
  url: "https://www.ftb.ca.gov/forms/2026/2026-540-es-instructions.html",
  retrievedOn: "2026-09-12",
  verification: "VERIFIED_PRIMARY_SOURCE",
};

const FTB_RATE_SCHEDULE_INDEX: RuleSource = {
  authority: "California Franchise Tax Board",
  citation:
    "Tax calculator, tables, rates — the published Tax Rate Schedules and Tax Tables end at tax year 2025; no 2026 schedule is listed. This is a living page, so the observation is dated: it was read on the retrieval date below, and publication of the 2026 schedules is what will make it stale.",
  url: "https://www.ftb.ca.gov/file/personal/tax-calculator-tables-rates.asp",
  retrievedOn: "2026-09-12",
  verification: "VERIFIED_PRIMARY_SOURCE",
};

/**
 * CORRECTED BY THE SOURCE AUDIT.
 *
 * This previously cited EDD's "Contribution Rates, Withholding Schedules, and
 * Meals and Lodging Values" page. That page does NOT state the rate or the
 * absence of a wage ceiling — it defers to Tax-Rated Employers for the SDI
 * rate — so it did not support either claim attributed to it. The page below
 * states both verbatim, and the figures were unchanged by the correction.
 */
const EDD_SDI_2026: RuleSource = {
  authority: "California Employment Development Department",
  citation:
    'Tax-Rated Employers, section "State Disability Insurance (SDI) Rate": "The SDI withholding rate for 2026 is 1.3 percent. Effective January 1, 2024, all wages are subject to SDI contributions." The same section notes the rate is set annually under section 984 of the CUIC. EDD\'s Contribution Rates and Benefit Amounts page independently shows the 2026 rate as 1.3% with a Taxable Wage Ceiling of "$NA" (2025: 1.2%).',
  url: "https://edd.ca.gov/en/payroll_taxes/tax-rated-employers/",
  retrievedOn: "2026-09-12",
  verification: "VERIFIED_PRIMARY_SOURCE",
};

const usd = (dollars: number): number => Math.round(dollars * 100);

export const US_CA_2026: TaxRuleSet = {
  jurisdiction: "US_CA",
  taxYear: 2026,
  // `.0` rather than `.1`: no income-tax figures have been established yet.
  // The first computable revision will be 2026.1.
  version: "2026.0",
  effectiveFrom: "2026-01-01",
  effectiveTo: "2026-12-31",
  currency: "USD",
  roundingNote:
    "Not applicable — no California income tax is computed for 2026 until FTB publishes the rate schedules and standard deduction.",
  sources: [FTB_540_ES_2026, FTB_RATE_SCHEDULE_INDEX, EDD_SDI_2026],

  // EMPTY BY NECESSITY, NOT BY OVERSIGHT. A bracket table cannot be written
  // without published thresholds, and there is no acceptable approximation
  // of one. `pendingPublication` below is what the engine reports.
  filingStatuses: {},

  // California has no state self-employment tax in any year.
  selfEmployment: null,

  surtaxes: [
    {
      key: "ca_behavioral_health_services_tax",
      label: "Behavioral Health Services Tax",
      thresholdMinor: usd(1_000_000),
      rateBasisPoints: 100, // 1.00%
      indexed: false,
      source: FTB_540_ES_2026,
    },
  ],

  payrollContributions: [
    {
      key: "ca_sdi",
      label: "California State Disability Insurance",
      rateBasisPoints: 130, // 1.30%
      // null, and deliberately so. EDD: "Effective January 1, 2024, all
      // wages are subject to SDI contributions." Reintroducing a cap here
      // would understate the withholding on every high earner in the state.
      wageCeilingMinor: null,
      source: EDD_SDI_2026,
    },
  ],

  pendingPublication: [
    "The 2026 California tax rate schedules (Schedule X, Schedule Y) — FTB's published schedules end at 2025",
    "The 2026 California standard deduction — the amount printed in the 2026 Form 540-ES worksheet is the 2025 amount, used there as an estimating stand-in",
    "The 2026 California exemption credit amounts — the 2026 Form 540-ES directs filers to the 2025 instructions",
  ],

  notModelled: [
    "California income tax for 2026 in its entirety, pending publication of the rate schedules and standard deduction by the Franchise Tax Board",
  ],
};
