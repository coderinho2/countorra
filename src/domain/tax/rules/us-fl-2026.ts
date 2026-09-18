import type { RuleSource, TaxRuleSet } from "./types";

/**
 * FLORIDA INDIVIDUAL STATE INCOME TAX — TAX YEAR 2026.
 *
 * FLORIDA LEVIES NONE. That is the whole rule, and it is a rule rather than a
 * gap: the Florida Constitution forbids an income tax on natural persons, and
 * the Department of Revenue says so in its own publications.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN
 *
 * No brackets. No standard deduction. No filing-status table. Modelling
 * Florida as a single 0% bracket would be a fabricated rate schedule — there
 * is no published schedule to transcribe — and it would invite someone to
 * "correct" the rate later. `filingStatuses` is empty, and
 * `noIndividualIncomeTax` carries the positive statement instead.
 *
 * FLORIDA DOES TAX THINGS. NONE OF THEM ARE THIS.
 *
 * Corporate income/franchise tax (Fla. Stat. ch. 220), sales and use tax,
 * documentary stamp tax and reemployment tax are all real Florida taxes and
 * all out of scope here. A $0 result means "no Florida tax on your individual
 * income", never "you owe Florida nothing" — `notModelled` says so, and it
 * travels on every result.
 *
 * HOW THESE SOURCES WERE ESTABLISHED, STATED HONESTLY
 *
 * THE CITED DOCUMENTS HAVE NOT BEEN OPENED. Both sources below are marked
 * `SOURCE_UNVERIFIED_ENVIRONMENT` and neither carries a `retrievedOn` date,
 * because nobody retrieved them.
 *
 * Re-checked during the source integrity audit, by three independent methods,
 * with these exact results:
 *
 *   floridarevenue.com     DNS resolution failure (curl: "Could not resolve
 *                          host"; nslookup times out)
 *   www.flsenate.gov       DNS resolution failure
 *   www.leg.state.fl.us    resolves to 207.126.30.18, then the connection
 *                          times out
 *
 * So the rule below rests on the Florida Department of Revenue's own
 * publication AS INDEXED BY SEARCH, plus the constitutional and statutory
 * citations — which are long-standing and not in dispute, but which this
 * codebase has not confirmed first-hand. A search-engine snippet quoting a
 * document is not the same as reading it.
 *
 * The rule is implemented because it is independently well established. The
 * CITATION is not verified, and nothing in this codebase may describe it as
 * though it were. Re-verify from an environment that can reach the Florida
 * Department of Revenue.
 */

const FL_DOR_NEW_RESIDENTS: RuleSource = {
  authority: "Florida Department of Revenue",
  citation:
    'Publication GT-800025, "Tax Information for New Residents", reported to state: "Florida does not impose personal income tax, inheritance tax, gift taxes, or tax on intangible personal property." Florida residents may still owe other Florida taxes, including corporate income tax and sales and use tax. NOTE: this wording comes from a search-engine index of the document, not from reading the document.',
  url: "https://floridarevenue.com/Forms_library/current/brochure/gt800025.pdf",
  // No `retrievedOn`: it was never retrieved.
  verification: "SOURCE_UNVERIFIED_ENVIRONMENT",
  verificationNote:
    "floridarevenue.com does not resolve from this environment (DNS failure on both curl and nslookup), so the publication could not be opened and the quoted wording could not be confirmed against it.",
};

/** The constitutional bar, which is why no schedule exists to transcribe. */
const FL_CONSTITUTION_ART_VII_S5: RuleSource = {
  authority: "Constitution of the State of Florida",
  citation:
    "Article VII, Section 5 — the provision barring a tax upon the income of natural persons. Florida Statutes § 220.02 (legislative intent) restates it: the Legislature acknowledges the mandate in s. 5, Art. VII of the State Constitution that no income tax be levied upon natural persons, and the income tax code in chapter 220 is not intended to tax natural persons. Cited by legal reference rather than by page: the URL is the Legislature's statutes and constitution entry point, not a deep link, because no deep link could be confirmed.",
  url: "https://www.leg.state.fl.us/statutes/index.cfm?submenu=3",
  // No `retrievedOn`: it was never retrieved.
  verification: "SOURCE_UNVERIFIED_ENVIRONMENT",
  verificationNote:
    "www.leg.state.fl.us resolves to 207.126.30.18 but the connection times out from this environment, and www.flsenate.gov does not resolve, so neither the constitutional text nor Florida Statutes § 220.02 could be read first-hand.",
};

export const US_FL_2026: TaxRuleSet = {
  jurisdiction: "US_FL",
  taxYear: 2026,
  // Bumped only if the underlying legal position changes — which for Florida
  // would take a constitutional amendment, not an annual indexing release.
  version: "2026.1",
  effectiveFrom: "2026-01-01",
  effectiveTo: "2026-12-31",
  currency: "USD",
  roundingNote: "Not applicable. Florida levies no individual income tax, so there is no amount to round.",
  sources: [FL_DOR_NEW_RESIDENTS, FL_CONSTITUTION_ART_VII_S5],

  // EMPTY BECAUSE NONE EXIST — not because none were transcribed. Florida
  // publishes no individual rate schedule, no standard deduction and no
  // filing-status table, because it imposes no individual income tax. The
  // engine never reads this for Florida; `noIndividualIncomeTax` answers.
  filingStatuses: {},

  // Social Security and Medicare are federal. Florida levies no state
  // self-employment tax either.
  selfEmployment: null,

  noIndividualIncomeTax: {
    // The RULE is well established independently of the citation; the
    // CITATION is unverified. Those are different things, and the sources
    // above say which is which.
    basis:
      "Florida imposes no individual personal income tax. The Florida Constitution (Article VII, Section 5) bars a tax upon the income of natural persons, and Florida's income tax code (Florida Statutes chapter 220) applies to corporations rather than to individuals.",
    source: FL_CONSTITUTION_ART_VII_S5,
  },

  /**
   * What a $0 Florida individual income tax result does NOT mean.
   *
   * The most expensive way to misread this jurisdiction is to take "$0" as
   * "no Florida tax at all". Each of these is a real Florida tax, and none of
   * them is modelled anywhere in Countorra.
   */
  notModelled: [
    "Florida corporate income/franchise tax (Florida Statutes chapter 220) — a real tax on corporations, and unrelated to an individual's income tax",
    "Florida sales and use tax, and county discretionary sales surtaxes",
    "Florida documentary stamp tax",
    "Florida reemployment tax",
    "Florida property tax, which is levied locally rather than by the state",
    "Any other Florida state or local tax or fee — a $0 individual income tax does not mean no Florida tax is owed",
    "Federal income tax and self-employment tax, which Florida residents owe in full",
  ],
};
