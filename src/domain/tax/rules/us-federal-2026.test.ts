import { describe, expect, it } from "vitest";
import { money } from "@/domain/money/money";
import { applyProgressiveBrackets } from "../calculation/brackets";
import { US_FEDERAL_2026 } from "./us-federal-2026";
import { allRuleSets, findRuleSet, findRuleSetVersion, isSupported, supportedTaxYears } from "./registry";

/**
 * The 2026 federal rule set, checked against the IRS's own arithmetic.
 *
 * THE ORACLE
 *
 * Rev. Proc. 2025-32 states every bracket twice: once as "X% of the excess
 * over $T", and once as a cumulative base dollar amount at $T. Those two
 * statements are independent, and they must agree. So running this engine's
 * progressive calculation at each threshold and comparing it to the
 * PUBLISHED base amount tests the thresholds, the rates and the bracket
 * arithmetic all at once — against a figure the IRS printed, not against a
 * number this codebase produced.
 *
 * A transcription error in any threshold or rate breaks at least one row.
 */

const usd = (dollars: number) => money(Math.round(dollars * 100), "USD");
const taxAt = (taxableDollars: number, status: "single" | "married_filing_jointly" | "head_of_household" | "married_filing_separately" | "qualifying_surviving_spouse") =>
  applyProgressiveBrackets(usd(taxableDollars), US_FEDERAL_2026.filingStatuses[status]!.brackets, "USD").total.amountMinor;

describe("bracket tables reconcile with the IRS published base amounts", () => {
  // Rev. Proc. 2025-32 § 4.01, Table 3 — Unmarried Individuals.
  it.each([
    [12_400, 1_240],
    [50_400, 5_800],
    [105_700, 17_966],
    [201_775, 41_024],
    [256_225, 58_448],
    [640_600, 192_979.25],
  ])("Single: tax on exactly $%s taxable income is the published $%s", (threshold, publishedBase) => {
    expect(taxAt(threshold, "single")).toBe(Math.round(publishedBase * 100));
  });

  // Rev. Proc. 2025-32 § 4.01, Table 1 — Married Filing Jointly.
  it.each([
    [24_800, 2_480],
    [100_800, 11_600],
    [211_400, 35_932],
    [403_550, 82_048],
    [512_450, 116_896],
    [768_700, 206_583.5],
  ])("MFJ: tax on exactly $%s taxable income is the published $%s", (threshold, publishedBase) => {
    expect(taxAt(threshold, "married_filing_jointly")).toBe(Math.round(publishedBase * 100));
  });

  // Rev. Proc. 2025-32 § 4.01, Table 2 — Heads of Households. Every base
  // amount below is printed in the table; none is derived here.
  it.each([
    [17_700, 1_770],
    [67_450, 7_740],
    [105_700, 16_155],
    [201_750, 39_207],
    [256_200, 56_631],
    [640_600, 191_171],
  ])("Head of household: tax on exactly $%s taxable income is the published $%s", (threshold, publishedBase) => {
    expect(taxAt(threshold, "head_of_household")).toBe(Math.round(publishedBase * 100));
  });

  // Rev. Proc. 2025-32 § 4.01, Table 4 — Married Individuals Filing Separate
  // Returns. The same as Table 3 through $256,225; the 37% rate then starts at
  // $384,350, not $640,600.
  it.each([
    [12_400, 1_240],
    [50_400, 5_800],
    [105_700, 17_966],
    [201_775, 41_024],
    [256_225, 58_448],
    [384_350, 103_291.75],
  ])("Married filing separately: tax on exactly $%s taxable income is the published $%s", (threshold, publishedBase) => {
    expect(taxAt(threshold, "married_filing_separately")).toBe(Math.round(publishedBase * 100));
  });

  // Table 1 is published for "Married Individuals Filing Joint Returns and
  // Surviving Spouses" — the same printed base amounts apply.
  it.each([
    [24_800, 2_480],
    [100_800, 11_600],
    [211_400, 35_932],
    [403_550, 82_048],
    [512_450, 116_896],
    [768_700, 206_583.5],
  ])("Qualifying surviving spouse: tax on exactly $%s taxable income is the published $%s", (threshold, publishedBase) => {
    expect(taxAt(threshold, "qualifying_surviving_spouse")).toBe(Math.round(publishedBase * 100));
  });

  it("matches the published top-bracket formula above the highest threshold", () => {
    // Single: $192,979.25 + 37% of the excess over $640,600.
    const excess = 100_000;
    expect(taxAt(640_600 + excess, "single")).toBe(Math.round((192_979.25 + excess * 0.37) * 100));

    // MFJ: $206,583.50 + 37% of the excess over $768,700.
    expect(taxAt(768_700 + excess, "married_filing_jointly")).toBe(Math.round((206_583.5 + excess * 0.37) * 100));

    // Head of household: $191,171 + 37% of the excess over $640,600.
    expect(taxAt(640_600 + excess, "head_of_household")).toBe(Math.round((191_171 + excess * 0.37) * 100));

    // Married filing separately: $103,291.75 + 37% of the excess over $384,350.
    expect(taxAt(384_350 + excess, "married_filing_separately")).toBe(Math.round((103_291.75 + excess * 0.37) * 100));

    // Qualifying surviving spouse: Table 1's $206,583.50 + 37% over $768,700.
    expect(taxAt(768_700 + excess, "qualifying_surviving_spouse")).toBe(Math.round((206_583.5 + excess * 0.37) * 100));
  });
});

describe("the 2026 figures are the 2026 figures", () => {
  it("uses the published standard deductions", () => {
    // Rev. Proc. 2025-32 § 4.14. These are NOT a straight inflation
    // adjustment of 2025 — the One, Big, Beautiful Bill Act changed them.
    expect(US_FEDERAL_2026.filingStatuses.single!.standardDeductionMinor).toBe(16_100_00);
    expect(US_FEDERAL_2026.filingStatuses.married_filing_jointly!.standardDeductionMinor).toBe(32_200_00);
    expect(US_FEDERAL_2026.filingStatuses.head_of_household!.standardDeductionMinor).toBe(24_150_00);
    expect(US_FEDERAL_2026.filingStatuses.married_filing_separately!.standardDeductionMinor).toBe(16_100_00);
    expect(US_FEDERAL_2026.filingStatuses.qualifying_surviving_spouse!.standardDeductionMinor).toBe(32_200_00);
  });

  it("is not silently carrying 2025 values", () => {
    // 2025 was $15,000 single / $30,000 MFJ. If either appears here, the
    // year was not actually updated.
    expect(US_FEDERAL_2026.filingStatuses.single!.standardDeductionMinor).not.toBe(15_000_00);
    expect(US_FEDERAL_2026.filingStatuses.married_filing_jointly!.standardDeductionMinor).not.toBe(30_000_00);
    // Rev. Proc. 2025-32 § 2.08 restates the OBBBA's 2025 amounts: $15,750
    // single and separate, $23,625 head of household, $31,500 joint and
    // surviving spouses. None of them is a 2026 figure.
    expect(US_FEDERAL_2026.filingStatuses.head_of_household!.standardDeductionMinor).not.toBe(23_625_00);
    expect(US_FEDERAL_2026.filingStatuses.married_filing_separately!.standardDeductionMinor).not.toBe(15_750_00);
    expect(US_FEDERAL_2026.filingStatuses.qualifying_surviving_spouse!.standardDeductionMinor).not.toBe(31_500_00);
  });

  it("uses the 2026 Social Security wage base", () => {
    // IRS Topic 751. 2025 was $176,100.
    expect(US_FEDERAL_2026.selfEmployment!.socialSecurityWageBaseMinor).toBe(184_500_00);
    expect(US_FEDERAL_2026.selfEmployment!.socialSecurityWageBaseMinor).not.toBe(176_100_00);
  });

  it("keeps the Additional Medicare thresholds at their statutory, unindexed values", () => {
    // Fixed since 2013 and never inflation-adjusted. Anyone "updating" these
    // for a new tax year would be introducing an error.
    const thresholds = US_FEDERAL_2026.selfEmployment!.additionalMedicareThresholdMinor;
    expect(thresholds.single).toBe(200_000_00);
    expect(thresholds.married_filing_jointly).toBe(250_000_00);
    // IRS Topic 560: $125,000 married filing separately; "$200,000 for all
    // other taxpayers".
    expect(thresholds.married_filing_separately).toBe(125_000_00);
    expect(thresholds.head_of_household).toBe(200_000_00);
    expect(thresholds.qualifying_surviving_spouse).toBe(200_000_00);
  });

  it("uses the statutory self-employment rates", () => {
    const se = US_FEDERAL_2026.selfEmployment!;
    expect(se.netEarningsBasisPoints).toBe(9235);
    expect(se.socialSecurityRateBasisPoints).toBe(1240);
    expect(se.medicareRateBasisPoints).toBe(290);
    // The two halves are the familiar 15.3% combined.
    expect(se.socialSecurityRateBasisPoints + se.medicareRateBasisPoints).toBe(1530);
    expect(se.minimumNetEarningsMinor).toBe(400_00);
    expect(se.deductiblePortionBasisPoints).toBe(5000);
  });
});

describe("rule set integrity", () => {
  const statuses = ["single", "married_filing_jointly", "head_of_household", "married_filing_separately", "qualifying_surviving_spouse"] as const;

  it.each(statuses)("%s brackets are contiguous, ascending and end open", (status) => {
    const brackets = US_FEDERAL_2026.filingStatuses[status]!.brackets;

    expect(brackets[0].fromMinor).toBe(0);
    for (const [i, bracket] of brackets.entries()) {
      if (i > 0) expect(bracket.fromMinor, `${status} bracket ${i}`).toBe(brackets[i - 1].upToMinor);
      if (i < brackets.length - 1) expect(bracket.upToMinor, `${status} bracket ${i}`).not.toBeNull();
    }
    expect(brackets.at(-1)!.upToMinor).toBeNull();
  });

  it.each(statuses)("%s rates only ever increase", (status) => {
    const rates = US_FEDERAL_2026.filingStatuses[status]!.brackets.map((b) => b.rateBasisPoints);
    expect(rates).toEqual([...rates].sort((a, b) => a - b));
    expect(rates).toEqual([1000, 1200, 2200, 2400, 3200, 3500, 3700]);
  });

  it("holds every amount as an integer in minor units", () => {
    // No float may appear in an authoritative figure.
    for (const status of statuses) {
      const rules = US_FEDERAL_2026.filingStatuses[status]!;
      expect(Number.isInteger(rules.standardDeductionMinor)).toBe(true);
      for (const bracket of rules.brackets) {
        expect(Number.isInteger(bracket.fromMinor)).toBe(true);
        expect(Number.isInteger(bracket.rateBasisPoints)).toBe(true);
        if (bracket.upToMinor !== null) expect(Number.isInteger(bracket.upToMinor)).toBe(true);
      }
    }
  });

  it("models all five federal filing statuses, each with an Additional Medicare threshold", () => {
    expect(Object.keys(US_FEDERAL_2026.filingStatuses).sort()).toEqual([...statuses].sort());
    for (const status of statuses) {
      expect(US_FEDERAL_2026.selfEmployment!.additionalMedicareThresholdMinor[status], status).toBeGreaterThan(0);
    }
  });

  it("gives a surviving spouse Table 1's published figures without sharing the array itself", () => {
    const joint = US_FEDERAL_2026.filingStatuses.married_filing_jointly!;
    const survivor = US_FEDERAL_2026.filingStatuses.qualifying_surviving_spouse!;
    expect(survivor.brackets).toEqual(joint.brackets);
    expect(survivor.brackets).not.toBe(joint.brackets);
    expect(survivor.standardDeductionMinor).toBe(joint.standardDeductionMinor);
  });

  it("does not let head of household or married filing separately borrow another status's table", () => {
    const table = (status: (typeof statuses)[number]) => JSON.stringify(US_FEDERAL_2026.filingStatuses[status]!.brackets);
    expect(table("head_of_household")).not.toBe(table("single"));
    expect(table("head_of_household")).not.toBe(table("married_filing_jointly"));
    expect(table("married_filing_separately")).not.toBe(table("single"));
  });

  it("cites the Revenue Procedure by the section that actually holds the tables", () => {
    const revProc = US_FEDERAL_2026.sources.find((source) => source.authority === "IRS Rev. Proc. 2025-32")!;
    expect(revProc.citation).toMatch(/section 4/);
    expect(revProc.citation).toContain(".01 Tax Rate Tables");
    expect(revProc.citation).toContain(".14 Standard Deduction");
    for (const table of ["TABLE 1", "TABLE 2", "TABLE 3", "TABLE 4"]) expect(revProc.citation).toContain(table);
  });

  it("carries a version, an effective window and real sources", () => {
    expect(US_FEDERAL_2026.version).toBe("2026.2");
    expect(US_FEDERAL_2026.effectiveFrom).toBe("2026-01-01");
    expect(US_FEDERAL_2026.effectiveTo).toBe("2026-12-31");
    expect(US_FEDERAL_2026.sources.length).toBeGreaterThanOrEqual(3);

    for (const source of US_FEDERAL_2026.sources) {
      expect(source.url).toMatch(/^https:\/\/(www\.)?(irs|ssa)\.gov\//);
      expect(source.authority.length).toBeGreaterThan(0);
      expect(source.citation.length).toBeGreaterThan(0);
    }
  });

  it("names what it does not model, so no result reads as a full return", () => {
    const text = US_FEDERAL_2026.notModelled.join(" ").toLowerCase();
    for (const omission of ["itemized", "199a", "credit", "capital gains", "alternative minimum", "state"]) {
      expect(text, omission).toContain(omission);
    }
  });
});

describe("registry: no fallback, ever", () => {
  it("finds the 2026 federal rules", () => {
    expect(findRuleSet("US_FEDERAL", 2026)?.version).toBe("2026.2");
    expect(isSupported("US_FEDERAL", 2026)).toBe(true);
  });

  it.each([2024, 2025, 2027, 2030, 1999])("has nothing for %s, rather than the nearest year", (year) => {
    expect(findRuleSet("US_FEDERAL", year)).toBeNull();
    expect(isSupported("US_FEDERAL", year)).toBe(false);
  });

  it.each(["US_CA", "US_NY", "US_FL", "US_TX", "US_AZ"] as const)("returns %s's own rules, never the federal ones", (jurisdiction) => {
    // Every jurisdiction is registered now, so "has nothing for it" can no
    // longer carry this invariant. The invariant itself is unchanged and is
    // asserted directly: a state key must never resolve to a federal rule
    // set. That failure would tax someone twice at federal rates while
    // looking entirely normal.
    const found = findRuleSet(jurisdiction, 2026);
    expect(found, `${jurisdiction} 2026 should be registered`).not.toBeNull();
    expect(found!.jurisdiction).toBe(jurisdiction);
    expect(found).not.toBe(US_FEDERAL_2026);
  });

  it("reports only the years each jurisdiction actually has", () => {
    expect(supportedTaxYears("US_FEDERAL")).toEqual([2026]);
    expect(supportedTaxYears("US_CA")).toEqual([2025, 2026]);
    expect(supportedTaxYears("US_NY")).toEqual([2026]);
    expect(supportedTaxYears("US_FL")).toEqual([2026]);
    expect(supportedTaxYears("US_TX")).toEqual([2026]);
    // Federal has no 2025 even though California does — the years are per
    // jurisdiction, and a shared year list would have leaked one into the
    // other.
    expect(findRuleSet("US_FEDERAL", 2025)).toBeNull();
    expect(supportedTaxYears("US_AZ")).toEqual([2026]);
    // New York has 2026 but no 2025; California has both. Neither leaks.
    expect(findRuleSet("US_NY", 2025)).toBeNull();
    expect(findRuleSet("US_AZ", 2025)).toBeNull();
  });

  it("resolves a stored version only when this build still has it", () => {
    expect(findRuleSetVersion("US_FEDERAL", 2026, "2026.2")?.version).toBe("2026.2");
    // 2026.1 carried two filing statuses. It is not kept, so a result stored
    // under it is recalculated rather than restated under different tables.
    expect(findRuleSetVersion("US_FEDERAL", 2026, "2026.1")).toBeNull();
    // A stored result computed under a version this build no longer carries
    // cannot be reproduced. Returning null says so; recomputing under the
    // current figures would present a different number as the original.
    expect(findRuleSetVersion("US_FEDERAL", 2026, "2026.0")).toBeNull();
  });

  it("registers every rule set under a unique jurisdiction and year", () => {
    const keys = allRuleSets().map((s) => `${s.jurisdiction}:${s.taxYear}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
