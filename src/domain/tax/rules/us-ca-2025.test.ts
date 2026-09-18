import { describe, expect, it } from "vitest";
import { US_CA_2025 } from "./us-ca-2025";
import { US_CA_2026 } from "./us-ca-2026";
import { US_FEDERAL_2026 } from "./us-federal-2026";
import { allRuleSets, findRuleSet, findRuleSetVersion, isSupported, supportedJurisdictions, supportedTaxYears } from "./registry";
import { applyProgressiveBrackets } from "../calculation/brackets";
import { money } from "@/domain/money/money";
import type { TaxBracket } from "./types";

/**
 * THE CALIFORNIA RULE DATA, CHECKED AGAINST ITSELF.
 *
 * These are not tests of code. They are tests of transcription — the one
 * place a tax engine can be wrong in a way no amount of correct arithmetic
 * will reveal, because a mistyped threshold produces a confident, plausible,
 * wrong number for every taxpayer near it.
 *
 * Two independent oracles, both drawn from the published source itself:
 *
 *   1. FTB states every bracket TWICE — as a rate on the excess over a
 *      threshold, and as a cumulative dollar base at that threshold. The
 *      base amounts below are transcribed from the FTB 2025 rate schedules
 *      separately from the thresholds, and recomputing each base from the
 *      thresholds must reproduce it. A single mistyped digit in either
 *      column breaks the reconciliation.
 *
 *   2. R&TC § 17041 builds the joint schedule by doubling the single one.
 *      Every Schedule Y threshold must be exactly twice its Schedule X
 *      counterpart — a check that needs no external figure at all.
 */

const dollars = (amount: number) => Math.round(amount * 100);

/** FTB 2025 Schedule X, "Enter on Form 540, line 31" column — the cumulative
 *  base at the START of each bracket, transcribed independently of the
 *  thresholds encoded in the rule set. */
const SCHEDULE_X_BASE_AT_THRESHOLD: readonly [number, number][] = [
  [11_079, 110.79],
  [26_264, 414.49],
  [41_452, 1_022.01],
  [57_542, 1_987.41],
  [72_724, 3_201.97],
  [371_479, 30_986.19],
  [445_771, 38_638.27],
  [742_953, 72_219.84],
];

/** FTB 2025 Schedule Y, same column. */
const SCHEDULE_Y_BASE_AT_THRESHOLD: readonly [number, number][] = [
  [22_158, 221.58],
  [52_528, 828.98],
  [82_904, 2_044.02],
  [115_084, 3_974.82],
  [145_448, 6_403.94],
  [742_958, 61_972.37],
  [891_542, 77_276.52],
  [1_485_906, 144_439.65],
];

/**
 * The tax at a threshold, computed by the ENGINE from the bracket table.
 *
 * Deliberately the real `applyProgressiveBrackets` rather than a second
 * implementation written for the test: a reimplementation only proves the
 * data is self-consistent, while this proves that the shipping arithmetic
 * reproduces FTB's published figures exactly.
 *
 * And it does — to the cent, on all sixteen rows. That is not a given.
 * FTB's printed base amounts carry accumulated rounding (the 9.3% row lands
 * on a half-cent, and every row above it inherits the rounding of the one
 * below), so a naive exact-rational reconstruction misses the top Schedule X
 * rows by 0.9 and 1.3 cents. The engine rounds each bracket to the cent and
 * sums, which is what FTB does, which is why these match.
 */
function cumulativeTaxAt(brackets: readonly TaxBracket[], thresholdMinor: number): number {
  return applyProgressiveBrackets(money(thresholdMinor, "USD"), brackets, "USD").total.amountMinor;
}

describe("2025 California rate schedules reconcile against FTB's own base amounts", () => {
  const single = US_CA_2025.filingStatuses.single!;
  const joint = US_CA_2025.filingStatuses.married_filing_jointly!;

  it.each(SCHEDULE_X_BASE_AT_THRESHOLD)("Schedule X: tax at $%s is exactly $%s", (threshold, expectedBase) => {
    expect(cumulativeTaxAt(single.brackets, dollars(threshold))).toBe(dollars(expectedBase));
  });

  it.each(SCHEDULE_Y_BASE_AT_THRESHOLD)("Schedule Y: tax at $%s is exactly $%s", (threshold, expectedBase) => {
    expect(cumulativeTaxAt(joint.brackets, dollars(threshold))).toBe(dollars(expectedBase));
  });

  it("builds the joint schedule by doubling the single one, as R&TC § 17041 prescribes", () => {
    expect(joint.brackets).toHaveLength(single.brackets.length);
    for (const [index, singleBracket] of single.brackets.entries()) {
      const jointBracket = joint.brackets[index];
      expect(jointBracket.fromMinor, `bracket ${index} lower bound`).toBe(singleBracket.fromMinor * 2);
      expect(jointBracket.upToMinor, `bracket ${index} upper bound`).toBe(
        singleBracket.upToMinor === null ? null : singleBracket.upToMinor * 2,
      );
      expect(jointBracket.rateBasisPoints, `bracket ${index} rate`).toBe(singleBracket.rateBasisPoints);
    }
  });

  it("doubles the standard deduction for joint filers too", () => {
    expect(joint.standardDeductionMinor).toBe(single.standardDeductionMinor * 2);
  });
});

describe("the California rate ladder is the statutory one", () => {
  const CALIFORNIA_RATES = [100, 200, 400, 600, 800, 930, 1030, 1130, 1230];

  it.each(["single", "married_filing_jointly"] as const)("%s has California's nine rates in order", (status) => {
    const rules = US_CA_2025.filingStatuses[status]!;
    expect(rules.brackets.map((bracket) => bracket.rateBasisPoints)).toEqual(CALIFORNIA_RATES);
  });

  it("has a top bracket rate of 12.3%, NOT 13.3%", () => {
    // 13.3% is the figure everyone quotes, and it is 12.3% plus the
    // Behavioral Health Services Tax. Folding the surcharge into the top
    // bracket would charge it on income between the top threshold and
    // $1,000,000, where it is not owed.
    const brackets = US_CA_2025.filingStatuses.single!.brackets;
    expect(brackets[brackets.length - 1].rateBasisPoints).toBe(1230);
    expect(brackets.some((bracket) => bracket.rateBasisPoints === 1330)).toBe(false);
  });

  it.each(["single", "married_filing_jointly"] as const)("%s brackets are contiguous and open at the top", (status) => {
    const brackets = US_CA_2025.filingStatuses[status]!.brackets;
    expect(brackets[0].fromMinor).toBe(0);
    expect(brackets[brackets.length - 1].upToMinor).toBeNull();

    for (const [index, bracket] of brackets.entries()) {
      if (index === 0) continue;
      expect(bracket.fromMinor, `gap or overlap before bracket ${index}`).toBe(brackets[index - 1].upToMinor);
      expect(bracket.rateBasisPoints, `rates must ascend at ${index}`).toBeGreaterThan(brackets[index - 1].rateBasisPoints);
    }
  });
});

describe("2025 standard deduction", () => {
  it("is $5,706 for Single, from the FTB standard deduction chart", () => {
    expect(US_CA_2025.filingStatuses.single!.standardDeductionMinor).toBe(dollars(5_706));
  });

  it("is $11,412 for Married/RDP Filing Jointly", () => {
    expect(US_CA_2025.filingStatuses.married_filing_jointly!.standardDeductionMinor).toBe(dollars(11_412));
  });

  it("is far below the federal standard deduction, which is the whole reason a state calculation is needed", () => {
    // If someone ever "helpfully" pastes the federal figure in here, this
    // fails. $5,706 vs $16,100 is not a rounding difference.
    expect(US_CA_2025.filingStatuses.single!.standardDeductionMinor).toBeLessThan(
      US_FEDERAL_2026.filingStatuses.single!.standardDeductionMinor / 2,
    );
  });
});

describe("Behavioral Health Services Tax", () => {
  it("is 1% above $1,000,000 of taxable income, in both years", () => {
    for (const ruleSet of [US_CA_2025, US_CA_2026]) {
      const surtax = ruleSet.surtaxes!.find((entry) => entry.key === "ca_behavioral_health_services_tax");
      expect(surtax, `${ruleSet.taxYear}`).toBeDefined();
      expect(surtax!.rateBasisPoints).toBe(100);
      expect(surtax!.thresholdMinor).toBe(dollars(1_000_000));
    }
  });

  it("is marked unindexed, because the threshold is statutory and must not move with inflation", () => {
    expect(US_CA_2025.surtaxes!.every((surtax) => surtax.indexed === false)).toBe(true);
  });

  it("is not present on the federal rule set", () => {
    expect(US_FEDERAL_2026.surtaxes ?? []).toHaveLength(0);
  });
});

describe("California levies no state self-employment tax", () => {
  it.each([US_CA_2025, US_CA_2026])("tax year $taxYear has selfEmployment: null", (ruleSet) => {
    // Not an omission. Social Security and Medicare are federal, and a
    // non-null value here would make the shared engine invent a state
    // liability that does not exist.
    expect(ruleSet.selfEmployment).toBeNull();
  });
});

describe("2026 is registered but refuses to supply figures FTB has not published", () => {
  it("names exactly what is missing", () => {
    expect(US_CA_2026.pendingPublication).toBeDefined();
    expect(US_CA_2026.pendingPublication!.length).toBeGreaterThan(0);
    const joined = US_CA_2026.pendingPublication!.join(" ").toLowerCase();
    expect(joined).toContain("rate schedule");
    expect(joined).toContain("standard deduction");
  });

  it("has no filing statuses, rather than filing statuses holding guessed figures", () => {
    expect(Object.keys(US_CA_2026.filingStatuses)).toHaveLength(0);
  });

  it("does NOT carry the 2025 brackets or deduction forward under a 2026 label", () => {
    // The single most likely wrong thing anyone could do to this file. The
    // 2026 Form 540-ES prints $5,706 / $11,412 as an estimating stand-in and
    // those are verifiably the 2025 amounts, so the temptation is real.
    const serialised = JSON.stringify(US_CA_2026);
    expect(serialised).not.toContain("570600");
    expect(serialised).not.toContain("1141200");
    expect(serialised).not.toContain("1107900"); // the Schedule X 1%/2% boundary
  });

  it("still carries the 2026 figures that ARE published", () => {
    expect(US_CA_2026.surtaxes).toHaveLength(1);
    expect(US_CA_2026.payrollContributions).toHaveLength(1);
  });

  it("uses a version distinguishable from any computable revision", () => {
    expect(US_CA_2026.version).toBe("2026.0");
    expect(US_CA_2025.version).toBe("2025.1");
  });
});

describe("2026 SDI, from EDD", () => {
  const sdi = US_CA_2026.payrollContributions!.find((contribution) => contribution.key === "ca_sdi")!;

  it("is 1.3%", () => {
    expect(sdi.rateBasisPoints).toBe(130);
  });

  it("has NO wage ceiling — removed effective 1 January 2024", () => {
    // `null`, not a large number standing in for infinity. A numeric cap
    // here would silently understate withholding for every high earner.
    expect(sdi.wageCeilingMinor).toBeNull();
  });

  it("is not published for 2025 in this codebase, and is therefore absent rather than guessed", () => {
    expect(US_CA_2025.payrollContributions).toBeUndefined();
  });
});

describe("every California figure is sourced", () => {
  it.each([US_CA_2025, US_CA_2026])("tax year $taxYear cites authorities with URLs and a retrieval date", (ruleSet) => {
    expect(ruleSet.sources.length).toBeGreaterThan(0);
    for (const source of ruleSet.sources) {
      expect(source.authority).toMatch(/California/);
      expect(source.url).toMatch(/^https:\/\/(www\.)?(ftb|edd)\.ca\.gov\//);
      expect(source.citation.length).toBeGreaterThan(20);
      expect(source.retrievedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("cites FTB for the income tax figures and EDD for the payroll rate", () => {
    expect(US_CA_2025.sources.every((source) => source.url.includes("ftb.ca.gov"))).toBe(true);
    expect(US_CA_2026.payrollContributions![0].source.url).toContain("edd.ca.gov");
  });

  it("attaches a non-empty notModelled list to every year", () => {
    for (const ruleSet of [US_CA_2025, US_CA_2026]) {
      expect(ruleSet.notModelled.length, `${ruleSet.taxYear}`).toBeGreaterThan(0);
    }
  });

  it("says plainly that QBI is not modelled and does not assert a California treatment for it", () => {
    const qbi = US_CA_2025.notModelled.find((entry) => entry.includes("199A"));
    expect(qbi).toBeDefined();
    expect(qbi).toContain("not asserted");
  });
});

describe("the registry keeps California separate from federal", () => {
  it("registers both California years", () => {
    expect(isSupported("US_CA", 2025)).toBe(true);
    expect(isSupported("US_CA", 2026)).toBe(true);
    expect(supportedTaxYears("US_CA")).toEqual([2025, 2026]);
  });

  it("lists US_CA alongside US_FEDERAL", () => {
    expect(supportedJurisdictions()).toEqual(expect.arrayContaining(["US_FEDERAL", "US_CA"]));
  });

  it("never returns a federal rule set for a California lookup", () => {
    for (const year of [2024, 2025, 2026, 2027]) {
      const found = findRuleSet("US_CA", year);
      if (found) expect(found.jurisdiction).toBe("US_CA");
    }
  });

  it("returns null for a California year nobody has modelled, rather than the nearest one", () => {
    expect(findRuleSet("US_CA", 2024)).toBeNull();
    expect(findRuleSet("US_CA", 2027)).toBeNull();
  });

  it("returns null for a federal year California happens to have", () => {
    expect(findRuleSet("US_FEDERAL", 2025)).toBeNull();
  });

  it("keys versions per jurisdiction, so a California version cannot reproduce a federal result", () => {
    expect(findRuleSetVersion("US_CA", 2025, "2025.1")).toBe(US_CA_2025);
    expect(findRuleSetVersion("US_CA", 2025, "2026.1")).toBeNull();
    expect(findRuleSetVersion("US_FEDERAL", 2026, "2025.1")).toBeNull();
  });

  it("has no two rule sets sharing a jurisdiction and year", () => {
    const keys = allRuleSets().map((ruleSet) => `${ruleSet.jurisdiction}:${ruleSet.taxYear}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("declares USD for every California year, matching the federal currency check", () => {
    expect(US_CA_2025.currency).toBe("USD");
    expect(US_CA_2026.currency).toBe("USD");
  });

  it("bounds each year to its own calendar year", () => {
    expect(US_CA_2025.effectiveFrom).toBe("2025-01-01");
    expect(US_CA_2025.effectiveTo).toBe("2025-12-31");
    expect(US_CA_2026.effectiveFrom).toBe("2026-01-01");
  });
});
