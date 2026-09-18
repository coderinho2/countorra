import { describe, expect, it } from "vitest";
import { money } from "@/domain/money/money";
import { applyTaxTable } from "./tax-table";
import { US_CA_2025 } from "../rules/us-ca-2025";

/**
 * THE 2025 CALIFORNIA TAX TABLE, CHECKED AGAINST THE PUBLISHED TABLE.
 *
 * The rows below are transcribed VERBATIM from FTB's published
 * `2025-540-taxtable.pdf`. They are the oracle: the implementation derives
 * each row from the interval structure and the rate schedule, and it has to
 * land on exactly the whole-dollar figure FTB prints, for both supported
 * filing statuses.
 *
 * Why a derivation rather than a thousand transcribed rows: FTB builds the
 * table by applying the rate schedule to the midpoint of each interval and
 * rounding to a whole dollar. That construction was checked against ALL 983
 * rows recoverable from the published PDF and reproduced every one of them
 * exactly, in both columns, including the irregular final row. The rows kept
 * here span the whole range and every bracket crossing, so a change to the
 * interval structure, the midpoint rule, the rounding rule or the brackets
 * fails a test with a named dollar figure.
 *
 * A direct rate-schedule calculation would NOT pass these. That is the point:
 * below $100,000 the schedule disagrees with the table, and the table is what
 * a filed Form 540 uses.
 */

const dollars = (amount: number) => Math.round(amount * 100);

const SINGLE = US_CA_2025.filingStatuses.single!;
const JOINT = US_CA_2025.filingStatuses.married_filing_jointly!;
const TABLE = US_CA_2025.taxTable!;

/** [At Least, But Not Over, tax for "1 Or 3", tax for "2 Or 5"] — verbatim. */
const PUBLISHED_ROWS: readonly (readonly [number, number, number, number])[] = [
  [1, 50, 0, 0],
  [51, 150, 1, 1],
  [151, 250, 2, 2],
  [2251, 2350, 23, 23],
  [4551, 4650, 46, 46],
  [6951, 7050, 70, 70],
  [9151, 9250, 92, 92],
  [11051, 11150, 111, 111],
  [11551, 11650, 121, 116],
  [13751, 13850, 165, 138],
  [16051, 16150, 211, 161],
  [18351, 18450, 257, 184],
  [19451, 19550, 279, 195],
  [20551, 20650, 301, 206],
  [22751, 22850, 345, 234],
  [25051, 25150, 391, 280],
  [26251, 26350, 416, 304],
  [27251, 27350, 456, 324],
  [29451, 29550, 544, 368],
  [31751, 31850, 636, 414],
  [33951, 34050, 724, 458],
  [36151, 36250, 812, 502],
  [38451, 38550, 904, 548],
  [40651, 40750, 992, 592],
  [41451, 41550, 1025, 608],
  [42851, 42950, 1109, 636],
  [45051, 45150, 1241, 680],
  [47351, 47450, 1379, 726],
  [49551, 49650, 1511, 770],
  [51751, 51850, 1643, 814],
  [54051, 54150, 1781, 892],
  [56251, 56350, 1913, 980],
  [57451, 57550, 1985, 1028],
  [58451, 58550, 2064, 1068],
  [60751, 60850, 2248, 1160],
  [62951, 63050, 2424, 1248],
  [65151, 65250, 2600, 1336],
  [67451, 67550, 2784, 1428],
  [69651, 69750, 2960, 1516],
  [71851, 71950, 3136, 1604],
  [72651, 72750, 3200, 1636],
  [74151, 74250, 3339, 1696],
  [76351, 76450, 3544, 1784],
  [78551, 78650, 3748, 1872],
  [80851, 80950, 3962, 1964],
  [83051, 83150, 4167, 2056],
  [85251, 85350, 4372, 2188],
  [87551, 87650, 4585, 2326],
  [89751, 89850, 4790, 2458],
  [91951, 92050, 4995, 2590],
  [94251, 94350, 5209, 2728],
  [96451, 96550, 5413, 2860],
  [98651, 98750, 5618, 2992],
  [99951, 100000, 5736, 3068],
];

function tableTax(taxableDollars: number, status: typeof SINGLE) {
  return applyTaxTable(money(dollars(taxableDollars), "USD"), status.brackets, TABLE, "USD");
}

describe("every published row reproduces exactly", () => {
  it.each(PUBLISHED_ROWS)("$%s–$%s: Single pays $%s, Married/RDP jointly pays $%s", (atLeast, notOver, single, joint) => {
    // Checked at BOTH ends of the row, because the defining property of a
    // table is that the whole row pays one figure.
    for (const income of [atLeast, notOver]) {
      expect(tableTax(income, SINGLE)!.tax.amountMinor, `single at $${income}`).toBe(dollars(single));
      expect(tableTax(income, JOINT)!.tax.amountMinor, `joint at $${income}`).toBe(dollars(joint));
    }
  });

  it("reports the published row bounds it used", () => {
    const application = tableTax(94_294, SINGLE)!;
    expect(application.intervalFromMinor).toBe(dollars(94_251));
    expect(application.intervalToMinor).toBe(dollars(94_350));
  });

  it("applies the schedule to the row midpoint, not to the income", () => {
    const application = tableTax(94_294, SINGLE)!;
    expect(application.midpoint.amountMinor).toBe(dollars(94_300.5));
    // $5,208.58 at the midpoint, published as $5,209.
    expect(application.taxAtMidpoint.amountMinor).toBe(dollars(5_208.58));
    expect(application.tax.amountMinor).toBe(dollars(5_209));
  });
});

describe("the table is flat inside a row and steps at its edge", () => {
  it("charges the same tax at every income in a row", () => {
    // $94,251 through $94,350 all pay $5,209 — this is what makes the table
    // a different calculation from the rate schedule, not a rounding of it.
    const taxes = new Set<number>();
    for (let income = 94_251; income <= 94_350; income += 1) taxes.add(tableTax(income, SINGLE)!.tax.amountMinor);
    expect([...taxes]).toEqual([dollars(5_209)]);
  });

  it("charges a different tax one dollar past the row edge", () => {
    expect(tableTax(94_350, SINGLE)!.tax.amountMinor).toBe(dollars(5_209));
    expect(tableTax(94_351, SINGLE)!.tax.amountMinor).not.toBe(dollars(5_209));
  });

  it("disagrees with the rate schedule applied directly, which is the whole reason it exists", () => {
    // The schedule on $94,294 gives $5,207.98; the table gives $5,209. A
    // filed Form 540 shows the table figure.
    const application = tableTax(94_294, SINGLE)!;
    expect(application.tax.amountMinor).not.toBe(dollars(5_207.98));
  });
});

describe("the first interval", () => {
  it("charges nothing on the first $50, as published", () => {
    for (const income of [1, 25, 50]) {
      expect(tableTax(income, SINGLE)!.tax.amountMinor, `$${income}`).toBe(0);
    }
  });

  it("charges nothing on zero taxable income", () => {
    expect(tableTax(0, SINGLE)!.tax.amountMinor).toBe(0);
  });

  it("charges nothing below the first published row", () => {
    // Taxable income under $1 has no row. Zero is the honest answer, and it
    // is what the same construction would produce anyway.
    expect(applyTaxTable(money(50, "USD"), SINGLE.brackets, TABLE, "USD")!.tax.amountMinor).toBe(0);
  });

  it("charges $1 in the second row, so the first step is real", () => {
    expect(tableTax(51, SINGLE)!.tax.amountMinor).toBe(dollars(1));
  });
});

describe("the $100,000 boundary between table and schedule", () => {
  it("governs income just below $100,000", () => {
    expect(tableTax(99_999, SINGLE)).not.toBeNull();
  });

  it("governs income at exactly $100,000", () => {
    // "$100,000 or less" — the cap is inclusive, and an off-by-one here would
    // switch method for the single most commonly typed figure in the range.
    const application = tableTax(100_000, SINGLE);
    expect(application).not.toBeNull();
    expect(application!.tax.amountMinor).toBe(dollars(5_736));
  });

  it("does NOT govern income one cent above $100,000", () => {
    expect(applyTaxTable(money(dollars(100_000) + 1, "USD"), SINGLE.brackets, TABLE, "USD")).toBeNull();
  });

  it("does NOT govern income one dollar above $100,000", () => {
    expect(tableTax(100_001, SINGLE)).toBeNull();
  });

  it("uses the short final row for the last $50, as published", () => {
    const application = tableTax(99_975, SINGLE)!;
    expect(application.intervalFromMinor).toBe(dollars(99_951));
    expect(application.intervalToMinor).toBe(dollars(100_000));
    expect(application.midpoint.amountMinor).toBe(dollars(99_975.5));
  });
});

describe("the construction is data, not a constant in the code", () => {
  it("declares the method and rounding rule it used", () => {
    expect(TABLE.method).toBe("midpoint_of_interval");
    expect(TABLE.rounding).toBe("whole_dollar_half_up");
  });

  it("declares the $100,000 cap rather than hard-coding it", () => {
    expect(TABLE.appliesUpToMinor).toBe(dollars(100_000));
  });

  it("declares the two published bands", () => {
    expect(TABLE.bands).toEqual([
      { fromMinor: dollars(1), toMinor: dollars(50), intervalWidthMinor: dollars(50) },
      { fromMinor: dollars(51), toMinor: dollars(100_000), intervalWidthMinor: dollars(100) },
    ]);
  });

  it("cites the published table itself, not the booklet's rate schedules", () => {
    expect(TABLE.source.url).toContain("taxtable");
    expect(TABLE.source.authority).toContain("Franchise Tax Board");
  });

  it("always prints a whole dollar", () => {
    for (let income = 0; income <= 100_000; income += 311) {
      expect(tableTax(income, SINGLE)!.tax.amountMinor % 100, `$${income}`).toBe(0);
      expect(tableTax(income, JOINT)!.tax.amountMinor % 100, `$${income}`).toBe(0);
    }
  });

  it("never decreases as income rises", () => {
    let previous = -1;
    for (let income = 0; income <= 100_000; income += 53) {
      const tax = tableTax(income, SINGLE)!.tax.amountMinor;
      expect(tax, `$${income}`).toBeGreaterThanOrEqual(previous);
      previous = tax;
    }
  });

  it("is deterministic", () => {
    const first = JSON.stringify(tableTax(63_000, JOINT));
    for (let attempt = 0; attempt < 50; attempt += 1) expect(JSON.stringify(tableTax(63_000, JOINT))).toBe(first);
  });
});
