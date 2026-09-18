import { describe, expect, it } from "vitest";
import { money } from "@/domain/money/money";
import { US_NY_2026 } from "./us-ny-2026";
import { US_CA_2025 } from "./us-ca-2025";
import { US_FEDERAL_2026 } from "./us-federal-2026";
import { allRuleSets, findRuleSet, findRuleSetVersion, isSupported, supportedJurisdictions, supportedTaxYears } from "./registry";
import { applyPublishedRateSchedule } from "../calculation/published-rate-schedule";
import type { FilingStatus, HighIncomeWorksheet, TaxBracket } from "./types";

/**
 * THE NEW YORK 2026 RULE DATA, CHECKED AGAINST ITSELF.
 *
 * Two independent oracles, both drawn from the published document:
 *
 *   1. New York prints each bracket as "$X plus R% of the excess over $T", so
 *      the base amounts and the rates check each other. Recomputing any base
 *      from the base below it and the intervening rate must reproduce the
 *      printed figure. All 24 bases across the three schedules reconcile.
 *
 *   2. The recapture constants chain: each worksheet's recapture base equals
 *      the previous worksheet's base plus its incremental benefit, in all
 *      three filing-status groups. That check needs no external figure at all.
 *
 * A single mistyped digit breaks one or both.
 */

const dollars = (amount: number) => Math.round(amount * 100);

/** The published Single/MFS schedule, transcribed independently of the rule
 *  set, as [over, base, rate%]. */
const SCHEDULE_SINGLE: readonly (readonly [number, number, number])[] = [
  [0, 0, 3.9],
  [8_500, 332, 4.4],
  [11_700, 473, 5.15],
  [13_900, 586, 5.4],
  [80_650, 4_191, 5.9],
  [215_400, 12_141, 6.85],
  [1_077_550, 71_198, 9.65],
  [5_000_000, 449_714, 10.3],
  [25_000_000, 2_509_714, 10.9],
];

const SCHEDULE_JOINT: readonly (readonly [number, number, number])[] = [
  [0, 0, 3.9],
  [17_150, 669, 4.4],
  [23_600, 953, 5.15],
  [27_900, 1_174, 5.4],
  [161_550, 8_391, 5.9],
  [323_200, 17_928, 6.85],
  [2_155_350, 143_430, 9.65],
  [5_000_000, 417_939, 10.3],
  [25_000_000, 2_477_939, 10.9],
];

const SCHEDULE_HOH: readonly (readonly [number, number, number])[] = [
  [0, 0, 3.9],
  [12_800, 499, 4.4],
  [17_650, 712, 5.15],
  [20_900, 879, 5.4],
  [107_650, 5_564, 5.9],
  [269_300, 15_101, 6.85],
  [1_616_450, 107_381, 9.65],
  [5_000_000, 433_894, 10.3],
  [25_000_000, 2_493_894, 10.9],
];

const PUBLISHED = [
  ["single", SCHEDULE_SINGLE],
  ["married_filing_separately", SCHEDULE_SINGLE],
  ["married_filing_jointly", SCHEDULE_JOINT],
  ["qualifying_surviving_spouse", SCHEDULE_JOINT],
  ["head_of_household", SCHEDULE_HOH],
] as const;

function bracketsOf(status: FilingStatus): readonly TaxBracket[] {
  return US_NY_2026.filingStatuses[status]!.brackets;
}

describe("rule metadata", () => {
  it("is New York, 2026, versioned", () => {
    expect(US_NY_2026.jurisdiction).toBe("US_NY");
    expect(US_NY_2026.taxYear).toBe(2026);
    expect(US_NY_2026.version).toBe("2026.1");
    expect(US_NY_2026.effectiveFrom).toBe("2026-01-01");
    expect(US_NY_2026.effectiveTo).toBe("2026-12-31");
    expect(US_NY_2026.currency).toBe("USD");
  });

  it("declares no pending publication — the 2026 figures are out", () => {
    // If this ever becomes non-empty, the resolver refuses New York rather
    // than substituting, because its fallback policy is empty by design.
    expect(US_NY_2026.pendingPublication ?? []).toHaveLength(0);
  });

  it("cites the New York State Department of Taxation and Finance, with URLs and a retrieval date", () => {
    expect(US_NY_2026.sources.length).toBeGreaterThan(0);
    for (const source of US_NY_2026.sources) {
      expect(source.authority).toContain("New York State Department of Taxation and Finance");
      expect(source.url).toMatch(/^https:\/\/www\.tax\.ny\.gov\//);
      expect(source.citation.length).toBeGreaterThan(20);
      expect(source.retrievedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("cites the 2026 form specifically, not a prior-year document", () => {
    expect(US_NY_2026.sources[0].citation).toContain("IT-2105-I (2026)");
  });

  it("states what is not modelled, including the unpublished 2026 tax table and New York City", () => {
    const joined = US_NY_2026.notModelled.join(" ");
    expect(US_NY_2026.notModelled.length).toBeGreaterThan(5);
    expect(joined).toContain("tax table");
    expect(joined).toContain("New York City");
    expect(joined).toContain("Yonkers");
    expect(joined).toContain("MCTMT");
    expect(joined).toContain("IT-196");
  });

  it("levies no state self-employment tax", () => {
    expect(US_NY_2026.selfEmployment).toBeNull();
  });

  it("has no tax table, because New York has not published one for 2026", () => {
    expect(US_NY_2026.taxTable).toBeNull();
  });
});

describe("the published rate schedules reconcile against their own base amounts", () => {
  it.each(PUBLISHED)("%s: every printed base is reproduced by the rate below it", (status, schedule) => {
    for (let i = 1; i < schedule.length; i += 1) {
      const [threshold, base] = schedule[i];
      const [previousThreshold, previousBase, previousRate] = schedule[i - 1];
      const rebuilt = previousBase + ((threshold - previousThreshold) * previousRate) / 100;
      // New York prints whole dollars, so the rebuild may differ by less than
      // a dollar of rounding — but never more.
      expect(Math.abs(rebuilt - base), `${status} base at $${threshold}`).toBeLessThan(1);
    }
  });

  it.each(PUBLISHED)("%s: the rule set carries exactly the published thresholds, bases and rates", (status, schedule) => {
    const brackets = bracketsOf(status as FilingStatus);
    expect(brackets).toHaveLength(schedule.length);
    for (const [index, [threshold, base, rate]] of schedule.entries()) {
      expect(brackets[index].fromMinor, `${status} bracket ${index} floor`).toBe(dollars(threshold));
      expect(brackets[index].baseTaxMinor, `${status} bracket ${index} base`).toBe(dollars(base));
      expect(brackets[index].rateBasisPoints, `${status} bracket ${index} rate`).toBe(Math.round(rate * 100));
    }
  });

  it.each(PUBLISHED)("%s: the engine lands within a dollar of the printed base AT each threshold", (status, schedule) => {
    // At exactly a threshold the filer is still in the row BELOW — New York's
    // rows read "over $12,800 but not over $17,650" — so the engine returns
    // the exact figure ($499.20 for head of household at $12,800) that the
    // printed whole-dollar base ($499) approximates. Anything more than a
    // dollar apart would mean a mistyped threshold, base or rate.
    const brackets = bracketsOf(status as FilingStatus);
    for (const [threshold, base] of schedule) {
      if (threshold === 0) continue;
      const computed = applyPublishedRateSchedule(money(dollars(threshold), "USD"), brackets, "USD").total.amountMinor;
      expect(Math.abs(computed - dollars(base)), `${status} at $${threshold}`).toBeLessThan(dollars(1));
    }
  });

  it.each(PUBLISHED)("%s: just ABOVE each threshold the engine uses the printed base verbatim", (status, schedule) => {
    // This is the assertion that proves the published base is used rather
    // than a per-bracket sum: one dollar into a row, the tax must be exactly
    // the printed base plus that row's rate on one dollar.
    const brackets = bracketsOf(status as FilingStatus);
    for (const [threshold, base, rate] of schedule) {
      if (threshold === 0) continue;
      const computed = applyPublishedRateSchedule(money(dollars(threshold) + 100, "USD"), brackets, "USD").total.amountMinor;
      expect(computed, `${status} just over $${threshold}`).toBe(dollars(base) + Math.round(rate));
    }
  });

  it.each(PUBLISHED)("%s: brackets are contiguous with an open top and ascending rates", (status) => {
    const brackets = bracketsOf(status as FilingStatus);
    expect(brackets[0].fromMinor).toBe(0);
    expect(brackets.at(-1)!.upToMinor).toBeNull();
    for (const [index, bracket] of brackets.entries()) {
      if (index === 0) continue;
      expect(bracket.fromMinor, `gap before ${index}`).toBe(brackets[index - 1].upToMinor);
      expect(bracket.rateBasisPoints).toBeGreaterThan(brackets[index - 1].rateBasisPoints);
    }
  });
});

describe("2026 is not 2025 — the rate reduction is encoded", () => {
  it("uses the reduced lower rates, not the 2025 ones", () => {
    // 2025: 4.00 / 4.50 / 5.25 / 5.50 / 6.00. 2026 cut each by 0.10 points.
    // Copying 2025 forward would have overstated the tax for almost every
    // New Yorker, so this is asserted rather than trusted.
    expect(bracketsOf("single").map((b) => b.rateBasisPoints)).toEqual([390, 440, 515, 540, 590, 685, 965, 1030, 1090]);
  });

  it("does not contain the 2025 rates anywhere", () => {
    const rates = new Set(Object.values(US_NY_2026.filingStatuses).flatMap((s) => s!.brackets.map((b) => b.rateBasisPoints)));
    for (const stale of [400, 450, 525, 550, 600]) expect(rates.has(stale), `${stale} bp is a 2025 rate`).toBe(false);
  });

  it("does not contain the 2025 published base amounts", () => {
    const serialised = JSON.stringify(US_NY_2026);
    // 2025 Single bases at the same thresholds: $340, $484, $600, $4,271.
    for (const stale of ["34000", "48400", "427100"]) expect(serialised).not.toContain(`"baseTaxMinor":${stale}`);
  });

  it("keeps the top four rates, which New York did not change", () => {
    expect(bracketsOf("single").slice(-4).map((b) => b.rateBasisPoints)).toEqual([685, 965, 1030, 1090]);
  });
});

describe("standard deductions and the dependent exemption", () => {
  it.each([
    ["single", 8_000],
    ["married_filing_jointly", 16_050],
    ["married_filing_separately", 8_000],
    ["head_of_household", 11_200],
    ["qualifying_surviving_spouse", 16_050],
  ] as const)("%s is $%s", (status, amount) => {
    expect(US_NY_2026.filingStatuses[status]!.standardDeductionMinor).toBe(dollars(amount));
  });

  it("publishes a smaller Single deduction for someone claimed as a dependent", () => {
    expect(US_NY_2026.filingStatuses.single!.standardDeductionIfClaimedAsDependentMinor).toBe(dollars(3_100));
  });

  it("grants $1,000 per dependent", () => {
    expect(US_NY_2026.dependentExemptionMinor).toBe(dollars(1_000));
  });

  it("uses New York's own figures, not the federal or California ones", () => {
    expect(US_NY_2026.filingStatuses.single!.standardDeductionMinor).not.toBe(US_FEDERAL_2026.filingStatuses.single!.standardDeductionMinor);
    expect(US_NY_2026.filingStatuses.single!.standardDeductionMinor).not.toBe(US_CA_2025.filingStatuses.single!.standardDeductionMinor);
  });

  it("supports all five filing statuses, which is what the 2026 source publishes", () => {
    expect(Object.keys(US_NY_2026.filingStatuses).sort()).toEqual(
      ["head_of_household", "married_filing_jointly", "married_filing_separately", "qualifying_surviving_spouse", "single"].sort(),
    );
  });
});

describe("the high-income worksheets", () => {
  const high = US_NY_2026.highIncome!;

  it("kicks in above $107,650 of New York adjusted gross income", () => {
    expect(high.ordinaryScheduleUpToAgiMinor).toBe(dollars(107_650));
  });

  it("rounds the phase-in fraction to four decimal places, as the form directs", () => {
    expect(high.phaseInFractionDecimalPlaces).toBe(4);
  });

  it("covers every supported filing status", () => {
    for (const status of Object.keys(US_NY_2026.filingStatuses) as FilingStatus[]) {
      expect(high.worksheets[status], status).toBeDefined();
      expect(high.worksheets[status]!.length).toBeGreaterThan(0);
    }
  });

  it("transcribes all sixteen published worksheets exactly once", () => {
    const ids = new Set<number>();
    for (const list of [high.worksheets.married_filing_jointly!, high.worksheets.single!, high.worksheets.head_of_household!]) {
      for (const w of list) ids.add(w.id);
    }
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it.each([
    ["married_filing_jointly", [1, 2, 3, 4, 5, 6]],
    ["qualifying_surviving_spouse", [1, 2, 3, 4, 5, 6]],
    ["single", [7, 8, 9, 10, 11]],
    ["married_filing_separately", [7, 8, 9, 10, 11]],
    ["head_of_household", [12, 13, 14, 15, 16]],
  ] as const)("%s uses worksheets %j", (status, expected) => {
    expect(high.worksheets[status]!.map((w) => w.id)).toEqual(expected);
  });

  it.each([
    ["married_filing_jointly", [333, 1_140, 4_211, 64_561], [807, 3_071, 60_350, 32_500]],
    ["single", [567, 2_614, 32_786], [2_047, 30_172, 32_500]],
    ["head_of_household", [787, 3_346, 48_606], [2_559, 45_260, 32_500]],
  ] as const)("%s: each recapture base is the previous base plus its incremental benefit", (status, bases, increments) => {
    // New York's own internal consistency, and an oracle that needs no
    // external figure. It would fail on any single mistyped digit.
    const recaptures = US_NY_2026.highIncome!.worksheets[status]!.filter((w): w is Extract<HighIncomeWorksheet, { kind: "recapture" }> => w.kind === "recapture");
    expect(recaptures.map((w) => w.recaptureBaseMinor)).toEqual(bases.map(dollars));
    expect(recaptures.map((w) => w.incrementalBenefitMinor)).toEqual(increments.map(dollars));

    for (let i = 1; i < recaptures.length; i += 1) {
      expect(recaptures[i].recaptureBaseMinor, `${status} base ${i}`).toBe(recaptures[i - 1].recaptureBaseMinor + recaptures[i - 1].incrementalBenefitMinor);
    }
  });

  it("phases in over $50,000 of adjusted gross income everywhere", () => {
    for (const list of Object.values(high.worksheets)) {
      for (const w of list!) {
        if (w.kind === "flat_top_rate") continue;
        expect(w.phaseInRangeMinor).toBe(dollars(50_000));
      }
    }
  });

  it("completes the phase-in at $157,650, which is the threshold plus the range", () => {
    for (const list of Object.values(high.worksheets)) {
      for (const w of list!) {
        if (w.kind !== "phase_in") continue;
        expect(w.phaseInCompleteAtAgiMinor).toBe(w.phaseInFromMinor + w.phaseInRangeMinor);
        expect(w.phaseInCompleteAtAgiMinor).toBe(dollars(157_650));
      }
    }
  });

  it("taxes everything at 10.9% above $25,000,000 of adjusted gross income", () => {
    for (const list of Object.values(high.worksheets)) {
      const top = list!.at(-1)!;
      expect(top.kind).toBe("flat_top_rate");
      if (top.kind !== "flat_top_rate") continue;
      expect(top.agiOverMinor).toBe(dollars(25_000_000));
      expect(top.topRateBasisPoints).toBe(1090);
    }
  });

  it("uses the flat rate that matches the top of each phase-in band", () => {
    // Worksheet 1 (joint) phases to 5.40%, the rate at $161,550; worksheets 7
    // and 12 phase to 5.90%. A swapped rate here would be invisible in the
    // output but wrong by hundreds of dollars.
    const rateFor = (status: FilingStatus) => {
      const w = high.worksheets[status]!.find((x) => x.kind === "phase_in");
      return w && w.kind === "phase_in" ? w.flatRateBasisPoints : null;
    };
    expect(rateFor("married_filing_jointly")).toBe(540);
    expect(rateFor("single")).toBe(590);
    expect(rateFor("head_of_household")).toBe(590);
  });

  it("bounds each recapture band by the bracket threshold it sits on", () => {
    // The taxable-income floor of each recapture worksheet is also a bracket
    // threshold in the same schedule. If they ever diverged, a band of income
    // would be taxed under the wrong worksheet.
    for (const status of ["single", "married_filing_jointly", "head_of_household"] as const) {
      const thresholds = new Set(bracketsOf(status).map((b) => b.fromMinor));
      for (const w of high.worksheets[status]!) {
        if (w.kind !== "recapture") continue;
        expect(thresholds.has(w.taxableIncomeOverMinor), `${status} worksheet ${w.id}`).toBe(true);
        expect(w.phaseInFromMinor).toBe(w.taxableIncomeOverMinor);
      }
    }
  });
});

describe("the registry keeps New York separate", () => {
  it("registers 2026 only", () => {
    expect(isSupported("US_NY", 2026)).toBe(true);
    expect(supportedTaxYears("US_NY")).toEqual([2026]);
  });

  it("lists US_NY alongside the others", () => {
    expect(supportedJurisdictions()).toEqual(expect.arrayContaining(["US_FEDERAL", "US_CA", "US_NY"]));
  });

  it("never returns another jurisdiction's rule set for a New York lookup", () => {
    for (const year of [2024, 2025, 2026, 2027]) {
      const found = findRuleSet("US_NY", year);
      if (found) expect(found.jurisdiction).toBe("US_NY");
    }
  });

  it("returns null for a New York year nobody has modelled", () => {
    expect(findRuleSet("US_NY", 2025)).toBeNull();
    expect(findRuleSet("US_NY", 2027)).toBeNull();
  });

  it("keys versions per jurisdiction", () => {
    expect(findRuleSetVersion("US_NY", 2026, "2026.1")).toBe(US_NY_2026);
    expect(findRuleSetVersion("US_NY", 2026, "2025.1")).toBeNull();
  });

  it("has no two rule sets sharing a jurisdiction and year", () => {
    const keys = allRuleSets().map((r) => `${r.jurisdiction}:${r.taxYear}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not disturb California or federal", () => {
    expect(findRuleSet("US_CA", 2025)!.jurisdiction).toBe("US_CA");
    expect(findRuleSet("US_FEDERAL", 2026)!.jurisdiction).toBe("US_FEDERAL");
  });
});
