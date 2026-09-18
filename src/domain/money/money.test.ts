import { describe, expect, it } from "vitest";
import {
  CurrencyMismatchError,
  add,
  allocate,
  compare,
  format,
  fromMajorUnits,
  isNegative,
  isZero,
  money,
  multiply,
  negate,
  percentageOf,
  subtract,
  sum,
  toMajorUnits,
  zero,
} from "./money";

describe("fromMajorUnits / toMajorUnits", () => {
  it("parses exact decimal strings without float drift", () => {
    expect(fromMajorUnits("10.50", "EUR")).toEqual(money(1050, "EUR"));
    expect(fromMajorUnits("0.01", "USD")).toEqual(money(1, "USD"));
    expect(fromMajorUnits("100", "RON")).toEqual(money(10000, "RON"));
  });

  it("handles the classic float trap correctly via strings", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754 — this must not leak into minor units.
    expect(fromMajorUnits("0.10", "EUR").amountMinor).toBe(10);
    expect(fromMajorUnits("0.20", "EUR").amountMinor).toBe(20);
  });

  it("parses negative amounts", () => {
    expect(fromMajorUnits("-5.25", "GBP")).toEqual(money(-525, "GBP"));
  });

  it("round-trips through toMajorUnits", () => {
    expect(toMajorUnits(money(1050, "EUR"))).toBe(10.5);
  });

  it("rejects malformed input", () => {
    expect(() => fromMajorUnits("not-a-number", "EUR")).toThrow(TypeError);
  });
});

describe("addition and subtraction", () => {
  it("adds same-currency amounts", () => {
    expect(add(money(1000, "EUR"), money(250, "EUR"))).toEqual(money(1250, "EUR"));
  });

  it("subtracts same-currency amounts", () => {
    expect(subtract(money(1000, "EUR"), money(250, "EUR"))).toEqual(money(750, "EUR"));
  });

  it("throws CurrencyMismatchError across currencies", () => {
    expect(() => add(money(100, "EUR"), money(100, "USD"))).toThrow(CurrencyMismatchError);
  });

  it("sums a list of amounts", () => {
    const values = [money(100, "RON"), money(200, "RON"), money(300, "RON")];
    expect(sum(values, "RON")).toEqual(money(600, "RON"));
  });
});

describe("percentageOf (tax/VAT calculations)", () => {
  it("computes a whole-percent rate exactly", () => {
    // 19% VAT on 10000 minor units (€100.00) = 1900 minor units (€19.00)
    expect(percentageOf(money(10_000, "EUR"), 19)).toEqual(money(1_900, "EUR"));
  });

  it("rounds half up on a fractional result", () => {
    // 1% of 50 = 0.5 -> rounds up to 1
    expect(percentageOf(money(50, "EUR"), 1)).toEqual(money(1, "EUR"));
    // 1% of 150 = 1.5 -> rounds up to 2
    expect(percentageOf(money(150, "EUR"), 1)).toEqual(money(2, "EUR"));
  });

  it("supports 2-decimal rates", () => {
    expect(percentageOf(money(100_000, "EUR"), 5.5)).toEqual(money(5_500, "EUR"));
  });

  it("handles 0%", () => {
    expect(percentageOf(money(10_000, "RON"), 0)).toEqual(money(0, "RON"));
  });
});

describe("multiply (quantity * unit price)", () => {
  it("multiplies by a whole number", () => {
    expect(multiply(money(500, "USD"), 3)).toEqual(money(1_500, "USD"));
  });

  it("multiplies by a fractional quantity", () => {
    // 2.5 units at $10.00 = $25.00
    expect(multiply(money(1_000, "USD"), 2.5)).toEqual(money(2_500, "USD"));
  });

  it("rounds half up on a fractional result", () => {
    // 3 units at $0.005 (0.5 minor units each) rounds each computation once, at the end
    expect(multiply(money(1, "USD"), 1.5)).toEqual(money(2, "USD"));
  });
});

describe("allocate (exact split, no lost minor units)", () => {
  it("splits evenly when it divides cleanly", () => {
    const parts = allocate(money(900, "EUR"), [1, 1, 1]);
    expect(parts).toEqual([money(300, "EUR"), money(300, "EUR"), money(300, "EUR")]);
  });

  it("distributes the remainder instead of losing it — classic $100/3 case", () => {
    const parts = allocate(money(10_000, "USD"), [1, 1, 1]);
    const total = parts.reduce((acc, p) => acc + p.amountMinor, 0);
    expect(total).toBe(10_000);
    expect(parts.map((p) => p.amountMinor).sort((a, b) => b - a)).toEqual([3_334, 3_333, 3_333]);
  });

  it("respects weighted ratios and still sums exactly", () => {
    const parts = allocate(money(10_001, "RON"), [50, 30, 20]);
    const total = parts.reduce((acc, p) => acc + p.amountMinor, 0);
    expect(total).toBe(10_001);
  });

  it("rejects non-integer or negative ratios", () => {
    expect(() => allocate(money(100, "EUR"), [1.5, 1])).toThrow(RangeError);
    expect(() => allocate(money(100, "EUR"), [-1, 1])).toThrow(RangeError);
  });
});

describe("comparisons and helpers", () => {
  it("compares amounts of the same currency", () => {
    expect(compare(money(100, "EUR"), money(200, "EUR"))).toBe(-1);
    expect(compare(money(200, "EUR"), money(100, "EUR"))).toBe(1);
    expect(compare(money(100, "EUR"), money(100, "EUR"))).toBe(0);
  });

  it("negate and isNegative are consistent", () => {
    const m = money(500, "EUR");
    expect(isNegative(negate(m))).toBe(true);
    expect(isNegative(m)).toBe(false);
  });

  it("isZero treats only exact zero as zero", () => {
    expect(isZero(zero("EUR"))).toBe(true);
    expect(isZero(money(1, "EUR"))).toBe(false);
  });
});

describe("format", () => {
  it("formats using Intl.NumberFormat currency style", () => {
    expect(format(money(1_050, "USD"), "en-US")).toBe("$10.50");
  });
});

/**
 * MON-01. Past 2^53 a JavaScript number is still an "integer" but no longer a
 * distinct one, so `Number.isInteger` accepted values that had already lost
 * precision and let them circulate as plausible figures.
 */
describe("precision bounds", () => {
  it("accepts amounts across the whole realistic range", () => {
    expect(money(0, "USD").amountMinor).toBe(0);
    expect(money(-1_327_440, "USD").amountMinor).toBe(-1_327_440);
    // ~$90 billion in a 2-decimal currency.
    expect(money(9_000_000_000_000, "USD").amountMinor).toBe(9_000_000_000_000);
  });

  it("refuses an amount that has already lost precision", () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 2, "USD")).toThrow(TypeError);
    expect(() => money(Number.MIN_SAFE_INTEGER - 2, "USD")).toThrow(TypeError);
  });

  it("still refuses a non-integer", () => {
    expect(() => money(10.5, "USD")).toThrow(TypeError);
    expect(() => money(NaN, "USD")).toThrow(TypeError);
    expect(() => money(Infinity, "USD")).toThrow(TypeError);
  });

  it("refuses to parse a major-unit amount too large to represent exactly", () => {
    expect(() => fromMajorUnits("99999999999999999.99", "USD")).toThrow(RangeError);
  });

  it("parses the largest amounts that are still exact", () => {
    expect(fromMajorUnits("90000000000.00", "USD").amountMinor).toBe(9_000_000_000_000);
  });

  it("truncates sub-minor-unit precision, as documented", () => {
    // Pinned deliberately: this is the one operation that does not round
    // half-up, and whether it should is an accounting decision, not a bug.
    expect(fromMajorUnits("8.165", "USD").amountMinor).toBe(816);
    expect(fromMajorUnits("8.169", "USD").amountMinor).toBe(816);
    expect(fromMajorUnits("-8.165", "USD").amountMinor).toBe(-816);
  });
});
