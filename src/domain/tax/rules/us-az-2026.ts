import type { RuleSource, TaxRuleSet } from "./types";

/**
 * ARIZONA INDIVIDUAL INCOME TAX — TAX YEAR 2026. REGISTERED, PARTIALLY
 * PUBLISHED, AND DELIBERATELY NOT COMPUTABLE.
 *
 * WHAT IS SETTLED FOR 2026
 *
 *   The RATE. A.R.S. § 43-1011(A)(9): "the tax is 2.5% of taxable income."
 *   Flat, with no filing-status distinction and no brackets. That paragraph
 *   is conditional on a revenue-trigger notice under § 43-243, so the statute
 *   alone does not prove it governs 2026 — but the Legislature's own Joint
 *   Legislative Budget Committee settles it: "Arizona used a graduated rate
 *   structure through Tax Year (TY) 2022. Beginning in TY 2023, the state
 *   imposes a single tax rate of 2.5% on the taxable income of all filers."
 *   The same publication's summary of statutory changes through 2025 records
 *   no later change to the rate.
 *
 *   The STARTING POINT. Arizona begins from federal adjusted gross income,
 *   modified by the additions and subtractions in §§ 43-1021 and 43-1022.
 *
 *   A NEW-FOR-2026 DEDUCTION RULE. § 43-1041(I)(2) applies "for taxable years
 *   beginning from and after December 31, 2025" — that is, from tax year 2026
 *   — and replaces the old percentage-of-charitable-contributions increase
 *   with the full amount of the taxpayer's charitable contributions under
 *   IRC § 170(c), capped at $1,000 (single or married filing separately) and
 *   $2,000 (married filing jointly). This is a real 2026 change and is
 *   recorded here so it cannot be forgotten when the rest publishes.
 *
 * WHAT IS NOT SETTLED, AND WHY THAT STOPS THE CALCULATION
 *
 *   The STANDARD DEDUCTION. § 43-1041(A) states $15,750 / $23,625 / $31,500 —
 *   and the JLBC handbook, published November 2025, shows exactly those as
 *   Arizona's figures, i.e. the TAX YEAR 2025 amounts. § 43-1041(H) then
 *   requires the Department of Revenue to adjust them for inflation each year
 *   "in the same manner in which the federal basic standard deduction is
 *   adjusted for inflation pursuant to section 63 of the internal revenue
 *   code". The 2026 amounts are therefore an administrative determination the
 *   Department publishes, and azdor.gov could not be reached from this
 *   environment.
 *
 *   It is tempting to derive them: the statutory base amounts are exactly the
 *   2025 FEDERAL standard deductions, indexed the federal way, so the 2026
 *   figures would very likely be the 2026 federal ones ($16,100 / $24,150 /
 *   $32,200 — which this codebase has verified from Rev. Proc. 2025-32).
 *   That is an inference, not a published Arizona value, and § 43-1041 does
 *   not cross-reference the federal amount — it sets its own figures and
 *   indexes them by the federal METHOD. So the derivation is not made here.
 *
 *   Without a standard deduction there is no Arizona taxable income, and
 *   without taxable income the 2.5% has nothing to apply to.
 *
 * WHY THERE IS NO FALLBACK TO 2025
 *
 * California answers a 2026 request with 2025's rules because FTB's own 2026
 * Form 540-ES tells filers to do exactly that. NO EQUIVALENT ARIZONA
 * INSTRUCTION WAS FOUND. Substituting 2025 here would be this codebase's
 * invention rather than the Department's direction, so `resolve-arizona.ts`
 * carries an empty fallback policy and the engine returns a structured
 * refusal naming the missing figures.
 *
 * WHEN THE DEPARTMENT PUBLISHES: fill `filingStatuses` with the 2026 standard
 * deductions and the flat 2.5% bracket, resolve the head-of-household
 * charitable cap, empty `pendingPublication`, and bump `version` to 2026.1.
 */

const ARS_43_1011: RuleSource = {
  authority: "Arizona Revised Statutes",
  citation:
    'A.R.S. § 43-1011 (Taxes and tax rates), subsection A, paragraph 9: "Subject to subsection F of this section, for taxable years beginning from and after December 31 of the year in which notice is provided to the department pursuant to section 43-243, subsection B, paragraph 2, the tax is 2.5% of taxable income." Flat, with no filing-status distinction. Paragraphs 1 through 8 set the superseded graduated schedules for earlier years.',
  url: "https://www.azleg.gov/ars/43/01011.01.htm",
  retrievedOn: "2026-09-12",
  verification: "VERIFIED_PRIMARY_SOURCE",
};

const ARS_43_1041: RuleSource = {
  authority: "Arizona Revised Statutes",
  citation:
    'A.R.S. § 43-1041 (Optional standard deduction): subsection A sets $15,750 (single or married filing separately), $23,625 (head of household) and $31,500 (married filing jointly), each "subject to subsection H"; subsection H requires the department to adjust those amounts for inflation for each taxable year beginning after 31 December 2019 "in the same manner in which the federal basic standard deduction is adjusted for inflation pursuant to section 63 of the internal revenue code"; subsection I, paragraph 2 applies from and after 31 December 2025 and increases the standard deduction by the taxpayer\'s charitable contributions under IRC § 170(c), capped at $1,000 for a single person or married person filing separately and $2,000 for a married couple filing a joint return.',
  url: "https://www.azleg.gov/ars/43/01041.htm",
  retrievedOn: "2026-09-12",
  verification: "VERIFIED_PRIMARY_SOURCE",
};

/**
 * Official Arizona, but the Legislature's budget analysts rather than the
 * taxing authority — hence SECONDARY. It is what establishes that the
 * § 43-243 revenue trigger was met and the 2.5% rate is actually in force.
 */
const JLBC_TAX_HANDBOOK_2025: RuleSource = {
  authority: "Arizona Joint Legislative Budget Committee",
  citation:
    'Tax Handbook 2025 (dated 4 November 2025), Individual Income Tax, Description: "The starting point for Arizona individual income tax is the federal adjusted gross income. Arizona used a graduated rate structure through Tax Year (TY) 2022. Beginning in TY 2023, the state imposes a single tax rate of 2.5% on the taxable income of all filers." The same section records the standard deduction as equal to the federal amount (Laws 2019, Chapter 273) and inflation-adjusted annually, notes that qualifying surviving spouses take the married-filing-jointly amount, and its summary of statutory changes through the 2025 session records no change to the individual income tax rate.',
  url: "https://www.azjlbc.gov/revenues/25taxbk.pdf",
  retrievedOn: "2026-09-12",
  verification: "VERIFIED_OFFICIAL_SECONDARY_SOURCE",
};

export const US_AZ_2026: TaxRuleSet = {
  jurisdiction: "US_AZ",
  taxYear: 2026,
  // `.0` rather than `.1`, matching the convention US_CA 2026 set: no
  // computable figures have been established yet. The first computable
  // revision will be 2026.1.
  version: "2026.0",
  effectiveFrom: "2026-01-01",
  effectiveTo: "2026-12-31",
  currency: "USD",
  roundingNote:
    "Not applicable — no Arizona income tax is computed for 2026 until the Department of Revenue publishes the inflation-adjusted standard deduction that Arizona taxable income depends on.",
  sources: [ARS_43_1011, ARS_43_1041, JLBC_TAX_HANDBOOK_2025],

  // EMPTY BY NECESSITY, NOT BY OVERSIGHT. The 2.5% rate is settled, but a
  // rate with no standard deduction cannot produce taxable income, and there
  // is no acceptable approximation of the missing amounts.
  filingStatuses: {},

  // Arizona levies no state self-employment tax. Social Security and
  // Medicare are federal — and Arizona does not tax Social Security income
  // at all, which is a subtraction rather than a self-employment rule.
  selfEmployment: null,

  // No tax table: Arizona's flat rate needs none.
  taxTable: null,

  pendingPublication: [
    "The 2026 Arizona standard deduction amounts — A.R.S. § 43-1041(A) states the pre-adjustment figures ($15,750 / $23,625 / $31,500, which are Arizona's tax year 2025 amounts) and § 43-1041(H) leaves the annual inflation adjustment to the Department of Revenue, whose published 2026 figures could not be reached",
    "The head-of-household cap on the new § 43-1041(I)(2) charitable increase — the statute states $1,000 for single or married filing separately and $2,000 for married filing jointly, and names no head-of-household amount",
  ],

  /**
   * What a real Arizona Form 140 includes and this rule set does not.
   *
   * Recorded now rather than later: several of these can change an Arizona
   * result materially, and a figure published without them would read as more
   * than it is.
   */
  notModelled: [
    "Arizona income tax for 2026 in its entirety, pending publication of the standard deduction by the Arizona Department of Revenue",
    "Arizona itemized deductions (A.R.S. § 43-1042), which taxpayers may elect instead of the standard deduction",
    "The additions to Arizona gross income under A.R.S. § 43-1021 and the subtractions under § 43-1022 — including the subtraction for Social Security income, which Arizona does not tax, and the exemption for military retirement benefits. These would be taken as supplied and are not derived",
    "The exemptions under A.R.S. § 43-1023 — $1,500 for a blind taxpayer or spouse, $2,100 for a taxpayer or spouse aged 65 or over, $2,300 for a stillborn child, and $10,000 for qualifying parents and ancestors",
    "Every Arizona tax credit, including the dependent tax credit and the credits for contributions to Qualifying Charitable Organizations, Qualifying Foster Care Charitable Organizations, public schools and school tuition organizations. Any future Arizona figure from this engine is therefore tax BEFORE credits, not a final filing liability",
    "The Arizona small business income tax election (Form 140-SBI), which is taxed separately from the tax modelled here",
    "Arizona nonresident and part-year resident computations — this models full-year residents only",
    "Arizona transaction privilege tax, use tax, corporate income tax and property tax, none of which is an individual income tax",
    "Arizona withholding already suffered and estimated payments already made",
    "Federal income tax and self-employment tax, which Arizona residents owe in full",
  ],
};
