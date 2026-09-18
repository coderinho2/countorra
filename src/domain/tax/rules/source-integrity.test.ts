import { describe, expect, it } from "vitest";
import { allRuleSets } from "./registry";
import type { RuleSource, TaxJurisdiction, TaxRuleSet } from "./types";

/**
 * SOURCE INTEGRITY, ENFORCED RATHER THAN PROMISED.
 *
 * A tax engine's citations are load-bearing: they are how anyone checks a
 * figure, and a citation that is wrong, stale or merely decorative is worse
 * than none, because it invites the reader to stop checking. The source audit
 * that produced this file found three real defects of exactly that kind —
 * a citation pointing at a page that did not contain the claim, a `retrievedOn`
 * date on a document nobody had opened, and a URL that would silently start
 * serving next year's edition. None of them would have failed a calculation
 * test.
 *
 * So the invariants live here, and they fail loudly.
 */

/** Which domains may carry tax law for which jurisdiction. Nothing else may. */
const OFFICIAL_DOMAINS: Record<TaxJurisdiction, readonly string[]> = {
  US_FEDERAL: ["www.irs.gov"],
  US_CA: ["www.ftb.ca.gov", "edd.ca.gov"],
  US_NY: ["www.tax.ny.gov"],
  US_FL: ["floridarevenue.com", "www.leg.state.fl.us"],
  US_TX: ["statutes.capitol.texas.gov", "comptroller.texas.gov"],
  US_AZ: ["www.azleg.gov", "www.azjlbc.gov"],
};

/**
 * Sources this codebase has NOT confirmed first-hand, and why.
 *
 * Pinned exactly. Adding an unverified source anywhere else fails here, which
 * is the point: "we could not check this one" must stay a deliberate,
 * reviewed exception rather than a habit.
 */
const EXPECTED_UNVERIFIED: readonly string[] = [
  // Florida — floridarevenue.com and www.leg.state.fl.us unreachable.
  "https://floridarevenue.com/Forms_library/current/brochure/gt800025.pdf",
  "https://www.leg.state.fl.us/statutes/index.cfm?submenu=3",
  // Texas — every texas.gov domain fails DNS resolution from this environment.
  "https://comptroller.texas.gov/taxes/",
  "https://statutes.capitol.texas.gov/Docs/CN/htm/CN.8.htm",
];

/** Never authoritative for a tax-law constant, however convenient. */
const FORBIDDEN = [
  "turbotax",
  "hrblock",
  "h-r-block",
  "taxfoundation",
  "investopedia",
  "wikipedia",
  "reddit",
  "forbes",
  "nerdwallet",
  "smartasset",
  "bankrate",
  "kiplinger",
  "thebalance",
  "justia",
  "law.cornell.edu",
  "ballotpedia",
];

function everySource(): { ruleSet: TaxRuleSet; source: RuleSource; where: string }[] {
  const out: { ruleSet: TaxRuleSet; source: RuleSource; where: string }[] = [];
  for (const ruleSet of allRuleSets()) {
    const label = `${ruleSet.jurisdiction} ${ruleSet.taxYear}`;
    for (const source of ruleSet.sources) out.push({ ruleSet, source, where: `${label} sources` });
    if (ruleSet.selfEmployment) out.push({ ruleSet, source: ruleSet.selfEmployment.source, where: `${label} selfEmployment` });
    if (ruleSet.taxTable) out.push({ ruleSet, source: ruleSet.taxTable.source, where: `${label} taxTable` });
    if (ruleSet.highIncome) out.push({ ruleSet, source: ruleSet.highIncome.source, where: `${label} highIncome` });
    if (ruleSet.noIndividualIncomeTax) out.push({ ruleSet, source: ruleSet.noIndividualIncomeTax.source, where: `${label} noIndividualIncomeTax` });
    for (const surtax of ruleSet.surtaxes ?? []) out.push({ ruleSet, source: surtax.source, where: `${label} surtax ${surtax.key}` });
    for (const contribution of ruleSet.payrollContributions ?? []) out.push({ ruleSet, source: contribution.source, where: `${label} payroll ${contribution.key}` });
  }
  return out;
}

const ALL = everySource();

describe("every cited source declares how far it was checked", () => {
  it("has at least one source on every rule set", () => {
    for (const ruleSet of allRuleSets()) {
      expect(ruleSet.sources.length, `${ruleSet.jurisdiction} ${ruleSet.taxYear}`).toBeGreaterThan(0);
    }
  });

  it.each(ALL.map((entry) => [entry.where, entry.source.url, entry.source] as const))("%s — %s declares a verification status", (where, _url, source) => {
    expect(["VERIFIED_PRIMARY_SOURCE", "VERIFIED_OFFICIAL_SECONDARY_SOURCE", "SOURCE_UNVERIFIED_ENVIRONMENT"], where).toContain(source.verification);
  });

  it("gives a retrieval date to every VERIFIED source, and to no unverified one", () => {
    for (const { where, source } of ALL) {
      if (source.verification !== "SOURCE_UNVERIFIED_ENVIRONMENT") {
        // Verified means someone opened it. A verified source with no date
        // would be an unfalsifiable claim.
        expect(source.retrievedOn, `${where} (${source.url})`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      } else {
        // And the converse matters more: a date on an unopened document is
        // exactly the false confidence this audit removed.
        expect(source.retrievedOn, `${where} (${source.url}) must not claim a retrieval date`).toBeUndefined();
      }
    }
  });

  it("explains every unverified source", () => {
    for (const { where, source } of ALL) {
      if (source.verification !== "SOURCE_UNVERIFIED_ENVIRONMENT") continue;
      expect(source.verificationNote, `${where} (${source.url})`).toBeTruthy();
      expect(source.verificationNote!.length).toBeGreaterThan(30);
    }
  });

  it("has exactly the expected set of unverified sources, and no others", () => {
    const unverified = [...new Set(ALL.filter((e) => e.source.verification === "SOURCE_UNVERIFIED_ENVIRONMENT").map((e) => e.source.url))].sort();
    expect(unverified).toEqual([...EXPECTED_UNVERIFIED].sort());
  });
});

describe("every cited source is an official government document", () => {
  const ALLOWED_HOSTS = new Set(Object.values(OFFICIAL_DOMAINS).flat());

  it.each(ALL.map((entry) => [entry.where, entry.source.url] as const))("%s — %s is https on an official domain", (where, url) => {
    expect(url.startsWith("https://"), `${where}: ${url}`).toBe(true);
    expect(ALLOWED_HOSTS.has(new URL(url).host), `${where}: ${new URL(url).host} is not an official tax authority domain`).toBe(true);
  });

  it("matches each source's domain to its jurisdiction", () => {
    // A California figure cited to tax.ny.gov would be a cross-wiring no
    // calculation test could catch.
    for (const { ruleSet, source, where } of ALL) {
      const allowed = OFFICIAL_DOMAINS[ruleSet.jurisdiction];
      expect(allowed, `${where}: ${new URL(source.url).host}`).toContain(new URL(source.url).host);
    }
  });

  it("cites no commercial tax site, aggregator, encyclopedia or forum anywhere", () => {
    for (const { where, source } of ALL) {
      const haystack = `${source.url} ${source.authority}`.toLowerCase();
      for (const banned of FORBIDDEN) {
        expect(haystack.includes(banned), `${where} cites ${banned}`).toBe(false);
      }
    }
  });

  it("names a government authority on every source", () => {
    for (const { where, source } of ALL) {
      expect(source.authority.length, where).toBeGreaterThan(2);
      expect(
        /IRS|Franchise Tax Board|Employment Development Department|Department of Taxation and Finance|Department of Revenue|Comptroller of Public Accounts|Constitution|Arizona Revised Statutes|Joint Legislative Budget Committee/.test(source.authority),
        `${where}: ${source.authority}`,
      ).toBe(true);
    }
  });
});

describe("every citation carries a locator", () => {
  it("says WHERE in the document the values are, not just that the document exists", () => {
    // "IRS Topic 751" is a reference. "Topic 751 … 'For earnings in 2026,
    // this base limit is $184,500'" is a locator. Only the second lets
    // someone check a figure without re-reading the whole document.
    for (const { where, source } of ALL) {
      expect(source.citation.length, `${where} citation is too thin to locate a value`).toBeGreaterThan(60);
    }
  });
});

describe("cited URLs are stable, not moving targets", () => {
  it("uses no year-agnostic 'current' path that will serve a different edition later", () => {
    // New York's /pdf/current_forms/ path served the 2026 edition when it was
    // cited and will serve the 2027 edition next year, silently invalidating
    // every value attributed to it. The year-stamped path does not move.
    for (const { where, source } of ALL) {
      expect(source.url.includes("current_forms"), `${where}: ${source.url}`).toBe(false);
    }
  });
});

describe("tax-year labelling is honest", () => {
  it("never cites a source whose stated year contradicts the rule set's year", () => {
    // Catches the copied-forward failure directly: a 2026 rule set citing a
    // document that names only an earlier year.
    for (const ruleSet of allRuleSets()) {
      // The invariant belongs to rule sets that COMPUTE. Two kinds legitimately
      // cite older material:
      //
      //   no-tax jurisdictions cite a standing constitutional prohibition
      //   rather than an annual publication — Texas's dates from 2019 and
      //   Florida's older still;
      //
      //   a PENDING jurisdiction has no complete current-year source yet, which
      //   is the whole reason it is pending. Arizona 2026 rests on the Arizona
      //   Revised Statutes and the 2025 JLBC handbook precisely because the
      //   Department has not published the 2026 figure it is waiting on.
      //
      // Empty `filingStatuses` is exactly "does not compute", so it is the
      // discriminator rather than a list of jurisdiction names.
      if (Object.keys(ruleSet.filingStatuses).length === 0) continue;
      const years = ruleSet.sources.flatMap((s) => (s.citation.match(/\b20\d{2}\b/g) ?? []).map(Number));
      if (years.length === 0) continue;
      expect(Math.max(...years), `${ruleSet.jurisdiction} ${ruleSet.taxYear}`).toBeGreaterThanOrEqual(ruleSet.taxYear);
    }
  });

  it.each([
    ["US_CA", 2026],
    ["US_AZ", 2026],
  ] as const)("keeps %s %s pending rather than relabelling an earlier year", (jurisdiction, taxYear) => {
    const ruleSet = allRuleSets().find((r) => r.jurisdiction === jurisdiction && r.taxYear === taxYear)!;
    expect(ruleSet.pendingPublication!.length).toBeGreaterThan(0);
    expect(Object.keys(ruleSet.filingStatuses)).toHaveLength(0);
  });

  it("keeps every other registered year fully published", () => {
    const pendingByDesign = new Set(["US_CA:2026", "US_AZ:2026"]);
    for (const ruleSet of allRuleSets()) {
      if (pendingByDesign.has(`${ruleSet.jurisdiction}:${ruleSet.taxYear}`)) continue;
      expect(ruleSet.pendingPublication ?? [], `${ruleSet.jurisdiction} ${ruleSet.taxYear}`).toHaveLength(0);
    }
  });

  it("stamps every rule set with a version and a bounded effective period", () => {
    for (const ruleSet of allRuleSets()) {
      const label = `${ruleSet.jurisdiction} ${ruleSet.taxYear}`;
      expect(ruleSet.version, label).toMatch(/^\d{4}\.\d+$/);
      expect(ruleSet.version.startsWith(String(ruleSet.taxYear)), label).toBe(true);
      expect(ruleSet.effectiveFrom, label).toBe(`${ruleSet.taxYear}-01-01`);
      expect(ruleSet.effectiveTo, label).toBe(`${ruleSet.taxYear}-12-31`);
    }
  });
});

describe("a rule set that computes carries the data to compute with", () => {
  it("has filing statuses unless it is pending or levies no tax at all", () => {
    for (const ruleSet of allRuleSets()) {
      const label = `${ruleSet.jurisdiction} ${ruleSet.taxYear}`;
      const excused = (ruleSet.pendingPublication?.length ?? 0) > 0 || ruleSet.noIndividualIncomeTax;
      if (excused) {
        expect(Object.keys(ruleSet.filingStatuses), `${label} must not carry figures it cannot support`).toHaveLength(0);
        continue;
      }
      expect(Object.keys(ruleSet.filingStatuses).length, label).toBeGreaterThan(0);
      for (const [status, rules] of Object.entries(ruleSet.filingStatuses)) {
        expect(rules!.brackets.length, `${label} ${status}`).toBeGreaterThan(0);
        expect(rules!.standardDeductionMinor, `${label} ${status}`).toBeGreaterThan(0);
      }
    }
  });

  it("tells every user what was not modelled", () => {
    for (const ruleSet of allRuleSets()) {
      expect(ruleSet.notModelled.length, `${ruleSet.jurisdiction} ${ruleSet.taxYear}`).toBeGreaterThan(0);
    }
  });
});
