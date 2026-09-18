import type { RuleSource, TaxRuleSet } from "./types";

/**
 * US FEDERAL INDIVIDUAL INCOME TAX — TAX YEAR 2026.
 *
 * EVERY FIGURE BELOW IS TRANSCRIBED FROM A PRIMARY IRS SOURCE. Nothing here
 * is inferred, projected, or carried over from 2025. The 2026 figures reflect
 * both the annual inflation adjustment and the amendments made by the One,
 * Big, Beautiful Bill Act, which is why several of them are not what a
 * straight inflation adjustment of the 2025 numbers would produce.
 *
 * HOW THE BRACKET TABLES WERE VERIFIED
 *
 * Rev. Proc. 2025-32 states each bracket twice over: once as a rate on the
 * excess over a threshold, and once as a cumulative base dollar amount at
 * that threshold. Those two statements have to agree, which makes every table
 * self-checking. Worked for Single:
 *
 *   10% × $12,400                        =   $1,240   → base at $12,400  ✓
 *   $1,240  + 12% × ($50,400 − $12,400)  =   $5,800   → base at $50,400  ✓
 *   $5,800  + 22% × ($105,700 − $50,400) =  $17,966   → base at $105,700 ✓
 *   $17,966 + 24% × ($201,775 − $105,700)=  $41,024   → base at $201,775 ✓
 *   $41,024 + 32% × ($256,225 − $201,775)=  $58,448   → base at $256,225 ✓
 *   $58,448 + 35% × ($640,600 − $256,225)= $192,979.25 → base at $640,600 ✓
 *
 * and for Head of Household (Table 2):
 *
 *   10% × $17,700                        =   $1,770   → base at $17,700  ✓
 *   $1,770  + 12% × ($67,450 − $17,700)  =   $7,740   → base at $67,450  ✓
 *   $7,740  + 22% × ($105,700 − $67,450) =  $16,155   → base at $105,700 ✓
 *   $16,155 + 24% × ($201,750 − $105,700)=  $39,207   → base at $201,750 ✓
 *   $39,207 + 32% × ($256,200 − $201,750)=  $56,631   → base at $256,200 ✓
 *   $56,631 + 35% × ($640,600 − $256,200)= $191,171   → base at $640,600 ✓
 *
 * MFJ ends at $206,583.50 over $768,700, and Married Filing Separately (Table 4)
 * follows Single exactly until $256,225 and then ends at $103,291.75 over
 * $384,350. Every row of every table reconciles, so the thresholds and the
 * rates are mutually confirmed rather than separately trusted.
 * `us-federal-2026.test.ts` re-runs this reconciliation against the published
 * base amounts as an executable oracle.
 *
 * QUALIFYING SURVIVING SPOUSE IS NOT A TABLE OF ITS OWN
 *
 * Rev. Proc. 2025-32 publishes Table 1 as "Married Individuals Filing Joint
 * Returns and Surviving Spouses", and § 4.14 lists the standard deduction for
 * "Married Individuals Filing Joint Returns and Surviving Spouses" as one
 * amount. So the surviving-spouse entry below is those published figures,
 * stated again under its own key — not a guess that the two happen to match.
 *
 * CALCULATION IS NOT QUALIFICATION
 *
 * Supporting a filing status here means the engine can compute tax under it.
 * It says nothing about whether a taxpayer is entitled to use it. Head of
 * household and qualifying surviving spouse have qualification tests, and
 * married filing separately has consequences (a spouse who itemizes, for one)
 * that this product does not collect. The preparation and filing layers keep
 * those as review items; nothing in this file decides them.
 *
 * SCOPE, STATED HONESTLY
 *
 * This models ordinary income tax and self-employment tax. It is NOT a tax
 * return. `notModelled` below lists what a real 1040 would include and this
 * does not, and the engine attaches that list to every result it produces.
 */

const REV_PROC_2025_32: RuleSource = {
  authority: "IRS Rev. Proc. 2025-32",
  citation:
    'Internal Revenue Bulletin 2025-45 (Rev. Proc. 2025-32 begins at page 695), section 4 "2026 Adjusted Items": .01 Tax Rate Tables — TABLE 1 (Section 1(j)(2)(A), Married Individuals Filing Joint Returns and Surviving Spouses), TABLE 2 (Section 1(j)(2)(B), Heads of Households), TABLE 3 (Section 1(j)(2)(C), Unmarried Individuals other than Surviving Spouses and Heads of Households) and TABLE 4 (Section 1(j)(2)(D), Married Individuals Filing Separate Returns); and .14 Standard Deduction, (1) In general — $32,200 Married Individuals Filing Joint Returns and Surviving Spouses, $24,150 Heads of Households, $16,100 Unmarried Individuals, $16,100 Married Individuals Filing Separate Returns.',
  url: "https://www.irs.gov/irb/2025-45_IRB",
  retrievedOn: "2026-09-13",
  verification: "VERIFIED_PRIMARY_SOURCE",
};

const IRS_NEWSROOM_2026: RuleSource = {
  authority: "IRS Newsroom",
  citation:
    '"IRS releases tax inflation adjustments for tax year 2026, including amendments from the One, Big, Beautiful Bill" — states the 2026 standard deduction as $32,200 married filing jointly, $16,100 single and married filing separately, $24,150 head of household, and points to Rev. Proc. 2025-32 for the detail.',
  url: "https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2026-including-amendments-from-the-one-big-beautiful-bill",
  retrievedOn: "2026-09-12",
  verification: "VERIFIED_PRIMARY_SOURCE",
};

/** The OASDI wage base is set by SSA, not by a Revenue Procedure. Taken from
 *  the IRS restatement of it so the whole rule set has one publisher. */
const IRS_TOPIC_751: RuleSource = {
  authority: "IRS",
  citation:
    'Topic no. 751, Social Security and Medicare withholding rates: "For earnings in 2026, this base limit is $184,500." Social Security 6.2% each side (12.4% total); Medicare 1.45% each side (2.9% total); Additional Medicare Tax 0.9%.',
  url: "https://www.irs.gov/taxtopics/tc751",
  retrievedOn: "2026-09-12",
  verification: "VERIFIED_PRIMARY_SOURCE",
};

const IRS_SE_TAX: RuleSource = {
  authority: "IRS",
  citation:
    'Topic no. 554, Self-employment tax: "the amount subject to self-employment tax is 92.35% of your net earnings from self-employment"; 12.4% Social Security and 2.9% Medicare; "You usually must pay self-employment tax if you had net earnings from self-employment of $400 or more"; one-half deductible when figuring adjusted gross income. It also states the Additional Medicare Tax thresholds — "$250,000 for a married individual filing a joint return, $125,000 for a married individual filing a separate return, and $200,000 for all others" — which are the figures in `additionalMedicareThresholdMinor` below.',
  url: "https://www.irs.gov/taxtopics/tc554",
  retrievedOn: "2026-09-12",
  verification: "VERIFIED_PRIMARY_SOURCE",
};

/**
 * The three-step method the engine implements when a taxpayer has BOTH W-2
 * Medicare wages and self-employment income.
 *
 * Cited because `us-federal.ts` relies on it directly and quotes it. It was
 * missing from this list until the source audit caught it — a rule the engine
 * depends on must be traceable from the rule set, not only from a comment.
 *
 * Re-opened on 2026-09-13 for the three statuses added in version 2026.2: the
 * page states $125,000 for married filing separately and "$200,000 for all
 * other taxpayers", which is what head of household and qualifying surviving
 * spouse receive below.
 */
const IRS_TOPIC_560: RuleSource = {
  authority: "IRS",
  citation:
    'Topic no. 560, Additional Medicare Tax (page last reviewed or updated 01-Jun-2026): "A 0.9% Additional Medicare tax applies to Medicare wages, self-employment income, and railroad retirement (RRTA) compensation that exceed the following threshold amounts based on filing status: $250,000 for married filing jointly; $125,000 for married filing separately; and $200,000 for all other taxpayers." And the three-step computation — calculate the tax on Medicare wages over the threshold, then "Reducing the applicable threshold for the filing status by the total amount of Medicare wages received (but not below zero)", then calculate the tax on self-employment income over the reduced threshold.',
  url: "https://www.irs.gov/taxtopics/tc560",
  retrievedOn: "2026-09-13",
  verification: "VERIFIED_PRIMARY_SOURCE",
};

/** Dollars to integer cents, so the table below reads like the source. */
const usd = (dollars: number): number => Math.round(dollars * 100);

/** Rev. Proc. 2025-32 § 4.01, TABLE 1 — shared, as published, by joint
 *  filers and surviving spouses. */
const TABLE_1_JOINT_AND_SURVIVING_SPOUSES = [
  { fromMinor: usd(0), upToMinor: usd(24_800), rateBasisPoints: 1000 },
  { fromMinor: usd(24_800), upToMinor: usd(100_800), rateBasisPoints: 1200 },
  { fromMinor: usd(100_800), upToMinor: usd(211_400), rateBasisPoints: 2200 },
  { fromMinor: usd(211_400), upToMinor: usd(403_550), rateBasisPoints: 2400 },
  { fromMinor: usd(403_550), upToMinor: usd(512_450), rateBasisPoints: 3200 },
  { fromMinor: usd(512_450), upToMinor: usd(768_700), rateBasisPoints: 3500 },
  { fromMinor: usd(768_700), upToMinor: null, rateBasisPoints: 3700 },
] as const;

export const US_FEDERAL_2026: TaxRuleSet = {
  jurisdiction: "US_FEDERAL",
  taxYear: 2026,
  // Bumped when any figure in this file changes. A stored calculation records
  // this string, so a later correction cannot silently restate history.
  // 2026.2: head of household, married filing separately and qualifying
  // surviving spouse added, with their Additional Medicare thresholds. No
  // Single or Married Filing Jointly figure changed.
  version: "2026.2",
  effectiveFrom: "2026-01-01",
  effectiveTo: "2026-12-31",
  currency: "USD",
  roundingNote:
    "Computed in exact integer cents with BigInt throughout; each tax component is rounded half-up to the nearest cent at the point it is produced, never mid-calculation. The IRS permits whole-dollar rounding on a filed return — this engine does not apply it, because an estimate is more useful at cent precision and rounding is the filer's election.",
  sources: [REV_PROC_2025_32, IRS_NEWSROOM_2026, IRS_TOPIC_751, IRS_SE_TAX, IRS_TOPIC_560],

  filingStatuses: {
    // Rev. Proc. 2025-32 § 4.01, TABLE 3: Unmarried Individuals (other than
    // Surviving Spouses and Heads of Households).
    single: {
      standardDeductionMinor: usd(16_100),
      brackets: [
        { fromMinor: usd(0), upToMinor: usd(12_400), rateBasisPoints: 1000 },
        { fromMinor: usd(12_400), upToMinor: usd(50_400), rateBasisPoints: 1200 },
        { fromMinor: usd(50_400), upToMinor: usd(105_700), rateBasisPoints: 2200 },
        { fromMinor: usd(105_700), upToMinor: usd(201_775), rateBasisPoints: 2400 },
        { fromMinor: usd(201_775), upToMinor: usd(256_225), rateBasisPoints: 3200 },
        { fromMinor: usd(256_225), upToMinor: usd(640_600), rateBasisPoints: 3500 },
        { fromMinor: usd(640_600), upToMinor: null, rateBasisPoints: 3700 },
      ],
    },

    // Rev. Proc. 2025-32 § 4.01, TABLE 1: Married Individuals Filing Joint
    // Returns and Surviving Spouses.
    married_filing_jointly: {
      standardDeductionMinor: usd(32_200),
      brackets: [...TABLE_1_JOINT_AND_SURVIVING_SPOUSES],
    },

    // Rev. Proc. 2025-32 § 4.01, TABLE 2: Heads of Households; § 4.14 $24,150.
    head_of_household: {
      standardDeductionMinor: usd(24_150),
      brackets: [
        { fromMinor: usd(0), upToMinor: usd(17_700), rateBasisPoints: 1000 },
        { fromMinor: usd(17_700), upToMinor: usd(67_450), rateBasisPoints: 1200 },
        { fromMinor: usd(67_450), upToMinor: usd(105_700), rateBasisPoints: 2200 },
        { fromMinor: usd(105_700), upToMinor: usd(201_750), rateBasisPoints: 2400 },
        { fromMinor: usd(201_750), upToMinor: usd(256_200), rateBasisPoints: 3200 },
        { fromMinor: usd(256_200), upToMinor: usd(640_600), rateBasisPoints: 3500 },
        { fromMinor: usd(640_600), upToMinor: null, rateBasisPoints: 3700 },
      ],
    },

    // Rev. Proc. 2025-32 § 4.01, TABLE 4: Married Individuals Filing Separate
    // Returns; § 4.14 $16,100. Identical to TABLE 3 until the 35% bracket,
    // which ends at $384,350 rather than $640,600 — transcribed, not derived.
    married_filing_separately: {
      standardDeductionMinor: usd(16_100),
      brackets: [
        { fromMinor: usd(0), upToMinor: usd(12_400), rateBasisPoints: 1000 },
        { fromMinor: usd(12_400), upToMinor: usd(50_400), rateBasisPoints: 1200 },
        { fromMinor: usd(50_400), upToMinor: usd(105_700), rateBasisPoints: 2200 },
        { fromMinor: usd(105_700), upToMinor: usd(201_775), rateBasisPoints: 2400 },
        { fromMinor: usd(201_775), upToMinor: usd(256_225), rateBasisPoints: 3200 },
        { fromMinor: usd(256_225), upToMinor: usd(384_350), rateBasisPoints: 3500 },
        { fromMinor: usd(384_350), upToMinor: null, rateBasisPoints: 3700 },
      ],
    },

    // Rev. Proc. 2025-32 § 4.01, TABLE 1 and § 4.14 — both published for
    // "Married Individuals Filing Joint Returns and Surviving Spouses".
    qualifying_surviving_spouse: {
      standardDeductionMinor: usd(32_200),
      brackets: [...TABLE_1_JOINT_AND_SURVIVING_SPOUSES],
    },
  },

  selfEmployment: {
    netEarningsBasisPoints: 9235, // 92.35%
    socialSecurityRateBasisPoints: 1240, // 12.4%
    socialSecurityWageBaseMinor: usd(184_500), // 2026, IRS Topic 751
    medicareRateBasisPoints: 290, // 2.9%, uncapped
    minimumNetEarningsMinor: usd(400), // IRC § 6017
    deductiblePortionBasisPoints: 5000, // one-half, IRC § 164(f)
    additionalMedicareRateBasisPoints: 90, // 0.9%, IRC § 1401(b)(2)
    additionalMedicareThresholdMinor: {
      // Fixed in statute since 2013 and never indexed — so these are NOT
      // 2026 inflation figures, and must not be "updated" next year.
      // IRS Topic 560: MFJ $250,000; MFS $125,000; "$200,000 for all other
      // taxpayers".
      single: usd(200_000),
      married_filing_jointly: usd(250_000),
      married_filing_separately: usd(125_000),
      head_of_household: usd(200_000),
      qualifying_surviving_spouse: usd(200_000),
    },
    source: IRS_SE_TAX,
  },

  /**
   * What a real 1040 includes and this engine does not.
   *
   * Attached to every result. A figure presented without this list would
   * read as "your federal tax", when it is "your federal tax on ordinary
   * income, before everything below".
   */
  notModelled: [
    "Itemized deductions (Schedule A) — the standard deduction is always applied",
    "Whether a filing status is available to the taxpayer — head of household and qualifying surviving spouse have qualification tests, and a married person filing separately cannot take the standard deduction if their spouse itemizes; none of these is determined",
    "Qualified Business Income deduction (§ 199A), which commonly reduces self-employment tax bills",
    "Tax credits of any kind, including the Child Tax Credit and Earned Income Tax Credit",
    "Preferential rates on long-term capital gains and qualified dividends",
    "Alternative Minimum Tax",
    "Net Investment Income Tax (§ 1411)",
    "Additional Medicare Tax on W-2 wages above the threshold — a real liability, but withheld by the employer rather than paid as self-employment tax",
    "Additional standard deduction for taxpayers aged 65 or over, or blind",
    "The 2025–2028 deductions for tips, overtime, car loan interest and the senior deduction",
    "Withholding already paid, and estimated-tax payments already made",
    "State and local income tax of any kind",
  ],
};
