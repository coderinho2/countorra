import { describe, expect, it } from "vitest";
import { totalInBaseCurrency, describeExclusions } from "./aggregate";
import { money } from "./money";

describe("totalInBaseCurrency (FIN-03)", () => {
  it("returns a zero base-currency total for an empty set", () => {
    const result = totalInBaseCurrency([], "USD");
    expect(result.total).toEqual(money(0, "USD"));
    expect(result.includedCount).toBe(0);
    expect(result.excluded).toEqual([]);
  });

  it("sums a single account", () => {
    const result = totalInBaseCurrency([{ amountMinor: 42_184_60, currency: "USD" }], "USD");
    expect(result.total).toEqual(money(4_218_460, "USD"));
    expect(result.includedCount).toBe(1);
    expect(result.excluded).toEqual([]);
  });

  it("sums multiple accounts in the same currency exactly", () => {
    const result = totalInBaseCurrency(
      [
        { amountMinor: 100_000, currency: "USD" },
        { amountMinor: 25_050, currency: "USD" },
        { amountMinor: 1, currency: "USD" },
      ],
      "USD",
    );
    expect(result.total).toEqual(money(125_051, "USD"));
    expect(result.includedCount).toBe(3);
    expect(result.excluded).toEqual([]);
  });

  it("sums a non-USD base currency the same way", () => {
    const result = totalInBaseCurrency(
      [
        { amountMinor: 500_00, currency: "EUR" },
        { amountMinor: 250_00, currency: "EUR" },
      ],
      "EUR",
    );
    expect(result.total).toEqual(money(750_00, "EUR"));
    expect(result.excluded).toEqual([]);
  });

  it("never adds a foreign amount into the base total", () => {
    const result = totalInBaseCurrency(
      [
        { amountMinor: 100_000, currency: "USD" },
        { amountMinor: 900_000, currency: "EUR" },
      ],
      "USD",
    );

    // The old behaviour produced 1_000_000 "USD". The correct answer is the
    // USD half, plus a statement about the half that was left out.
    expect(result.total).toEqual(money(100_000, "USD"));
    expect(result.total.amountMinor).not.toBe(1_000_000);
    expect(result.includedCount).toBe(1);
    expect(result.excluded).toEqual([{ currency: "EUR", count: 1 }]);
  });

  it("never converts at 1:1, and never at any other rate", () => {
    const onlyForeign = totalInBaseCurrency(
      [
        { amountMinor: 1_000_00, currency: "EUR" },
        { amountMinor: 2_000_00, currency: "GBP" },
      ],
      "USD",
    );
    expect(onlyForeign.total).toEqual(money(0, "USD"));
    expect(onlyForeign.includedCount).toBe(0);
  });

  it("groups and counts every excluded currency, sorted", () => {
    const result = totalInBaseCurrency(
      [
        { amountMinor: 10, currency: "USD" },
        { amountMinor: 20, currency: "GBP" },
        { amountMinor: 30, currency: "EUR" },
        { amountMinor: 40, currency: "GBP" },
      ],
      "USD",
    );
    expect(result.total).toEqual(money(10, "USD"));
    expect(result.excluded).toEqual([
      { currency: "EUR", count: 1 },
      { currency: "GBP", count: 2 },
    ]);
  });

  it("handles negative amounts (credit card balances) exactly", () => {
    const result = totalInBaseCurrency(
      [
        { amountMinor: 500_000, currency: "USD" },
        { amountMinor: -1_327_440, currency: "USD" },
      ],
      "USD",
    );
    expect(result.total).toEqual(money(-827_440, "USD"));
  });
});

describe("describeExclusions", () => {
  it("says nothing when nothing was excluded", () => {
    expect(describeExclusions([], "USD")).toBeNull();
  });

  it("names a single excluded currency and its count", () => {
    const note = describeExclusions([{ currency: "EUR", count: 2 }], "USD");
    expect(note).toContain("USD only");
    expect(note).toContain("2 in EUR");
  });

  it("lists several excluded currencies readably", () => {
    const note = describeExclusions(
      [
        { currency: "EUR", count: 1 },
        { currency: "GBP", count: 3 },
      ],
      "USD",
    );
    expect(note).toContain("1 in EUR and 3 in GBP");
  });

  it("tells the reader the amounts were not converted", () => {
    const note = describeExclusions([{ currency: "EUR", count: 1 }], "USD");
    expect(note).toContain("never converted");
  });
});
