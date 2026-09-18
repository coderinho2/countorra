import type { RuleSource, TaxRuleSet } from "./types";

/**
 * TEXAS INDIVIDUAL STATE INCOME TAX — TAX YEAR 2026.
 *
 * TEXAS LEVIES NONE. As with Florida, that is a rule rather than a gap — but
 * the rule is Texas's own, established on a different basis, at a different
 * time, by a different instrument, and nothing here is inherited from
 * Florida's rule set.
 *
 * THE BASIS IS RECENT, AND SPECIFIC
 *
 * Texas Constitution, Article VIII, Section 24-a: "The legislature may not
 * impose a tax on the net incomes of individuals, including an individual's
 * share of partnership and unincorporated association income."
 *
 * That section did not always exist. It was added by Proposition 4 (H.J.R. 38,
 * 86th Legislature), approved at the election of 5 November 2019, which
 * REPEALED the former Section 24. The old Section 24 did not prohibit an
 * individual income tax at all — it merely required that one be approved by
 * the voters before taking effect. So Texas moved from "permitted subject to
 * a referendum" to "prohibited" within living memory, which is precisely why
 * this rule set cites the current section rather than assuming a timeless
 * position.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN
 *
 * No brackets. No standard deduction. No filing-status table. A single 0%
 * bracket would be a fabricated rate schedule: Texas publishes no individual
 * rate schedule because the legislature may not impose the tax that would
 * need one. `filingStatuses` is empty and `noIndividualIncomeTax` carries the
 * positive statement instead.
 *
 * TEXAS TAXES A GREAT DEAL. NONE OF IT IS THIS.
 *
 * The Comptroller of Public Accounts administers scores of taxes and fees —
 * the franchise tax on business margin, sales and use tax, and many others —
 * and property tax is levied locally. A $0 result here means "no Texas tax on
 * your individual income", never "you owe Texas nothing". `notModelled` says
 * so and travels on every result.
 *
 * SOURCE VERIFICATION, STATED HONESTLY
 *
 * THE CITED DOCUMENTS HAVE NOT BEEN OPENED. Every Texas government domain
 * fails DNS resolution from this environment — comptroller.texas.gov,
 * statutes.capitol.texas.gov, capitol.texas.gov, tlc.texas.gov,
 * fmx.cpa.texas.gov, star.comptroller.texas.gov, www.sos.state.tx.us and
 * texas.gov were all tried, by curl, nslookup, WebFetch and a browser, and
 * all failed to resolve.
 *
 * A reachable federal corroboration was looked for and NOT found: the IRS's
 * Texas page links to the Comptroller without mentioning an individual income
 * tax (a weak negative), and the Census Bureau's State Government Tax
 * Collections technical documentation mentions Texas only for its 31 August
 * fiscal year end. Neither establishes the rule, so neither is cited.
 *
 * The rule is implemented because it is independently well established. The
 * CITATIONS are not verified, and nothing in this codebase may describe them
 * as though they were. Re-verify from an environment that can reach Texas
 * government sites.
 */

/**
 * The operative prohibition. Cited by legal reference with the URL of the
 * Legislature's own copy of Article 8 — not a deep link to a subsection,
 * because no deep link could be confirmed.
 */
const TX_CONSTITUTION_ART_VIII_S24A: RuleSource = {
  authority: "Constitution of the State of Texas",
  citation:
    'Article VIII (Taxation and Revenue), Section 24-a: "The legislature may not impose a tax on the net incomes of individuals, including an individual\'s share of partnership and unincorporated association income." Added by Proposition 4 (H.J.R. 38, 86th Legislature), approved at the election of 5 November 2019, which repealed the former Section 24 — under which an individual income tax was permitted if approved by the voters.',
  url: "https://statutes.capitol.texas.gov/Docs/CN/htm/CN.8.htm",
  // No `retrievedOn`: it was never retrieved.
  verification: "SOURCE_UNVERIFIED_ENVIRONMENT",
  verificationNote:
    "statutes.capitol.texas.gov does not resolve from this environment (DNS resolution failure on curl, nslookup, WebFetch and the browser), so the constitutional text could not be read first-hand and the quoted wording could not be confirmed against it.",
};

/** The department that would administer such a tax, and does not. */
const TX_COMPTROLLER_TAXES: RuleSource = {
  authority: "Texas Comptroller of Public Accounts",
  citation:
    'Taxes — the Comptroller\'s index of the taxes it administers. Reported to state that "Texas does not have a personal income tax", while the office administers scores of other separate taxes, fees and assessments. NOTE: this wording comes from a search-engine index of the page, not from reading the page.',
  url: "https://comptroller.texas.gov/taxes/",
  // No `retrievedOn`: it was never retrieved.
  verification: "SOURCE_UNVERIFIED_ENVIRONMENT",
  verificationNote:
    "comptroller.texas.gov does not resolve from this environment (DNS resolution failure on curl, nslookup, WebFetch and the browser), so the index could not be opened and the quoted wording could not be confirmed against it.",
};

export const US_TX_2026: TaxRuleSet = {
  jurisdiction: "US_TX",
  taxYear: 2026,
  // Bumped only if the underlying legal position changes — which for Texas
  // would take another constitutional amendment, not an annual release.
  version: "2026.1",
  effectiveFrom: "2026-01-01",
  effectiveTo: "2026-12-31",
  currency: "USD",
  roundingNote: "Not applicable. Texas levies no individual income tax, so there is no amount to round.",
  sources: [TX_CONSTITUTION_ART_VIII_S24A, TX_COMPTROLLER_TAXES],

  // EMPTY BECAUSE NONE EXIST — not because none were transcribed. Texas
  // publishes no individual rate schedule, no standard deduction and no
  // filing-status table, because the legislature may not impose the tax that
  // would require them.
  filingStatuses: {},

  // Social Security and Medicare are federal. Texas levies no state
  // self-employment tax either.
  selfEmployment: null,

  noIndividualIncomeTax: {
    // The RULE is well established independently of the citation; the
    // CITATION is unverified. Those are different things, and the sources
    // above say which is which.
    basis:
      "Texas imposes no individual personal income tax. The Texas Constitution (Article VIII, Section 24-a) forbids the legislature from imposing a tax on the net incomes of individuals, including an individual's share of partnership and unincorporated association income. With no such tax, there is no Texas individual income tax return to file.",
    source: TX_CONSTITUTION_ART_VIII_S24A,
  },

  /**
   * What a $0 Texas individual income tax result does NOT mean.
   *
   * Named without rates or thresholds on purpose: those figures were not
   * verified, and an unverified rate is worse than no rate. Each of these is
   * a real Texas tax, and none is modelled anywhere in Countorra.
   */
  notModelled: [
    "Texas franchise tax — the tax on taxable margin that Texas levies on businesses, and which is not an individual income tax",
    "Texas sales and use tax, and the local sales taxes collected on behalf of Texas cities, counties and other local jurisdictions",
    "Texas property tax, which is levied by local taxing units rather than by the state",
    "Texas unemployment/employment taxes administered by the Texas Workforce Commission",
    "Every other tax, fee and assessment administered by the Texas Comptroller of Public Accounts — a $0 individual income tax does not mean no Texas tax is owed",
    "Federal income tax and self-employment tax, which Texas residents owe in full",
  ],
};
