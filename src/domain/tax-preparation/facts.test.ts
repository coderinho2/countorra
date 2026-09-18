import { describe, expect, it } from "vitest";
import { allFactDefinitions, calculatedKeys, factDefinition, isKnownFactKey, notModelledFor, paymentKeys } from "./facts";
import type { TaxFactKey } from "./types";

/**
 * The fact vocabulary.
 *
 * The failure this guards against is not a crash. It is a fact key that
 * quietly has no definition, loses its support level, and so is neither
 * calculated nor disclosed as uncalculated — a figure that looks complete
 * and is not.
 */

/** Every key in the union, written out. A key added to `types.ts` without a
 *  definition must fail here rather than at a call site in production. */
const EVERY_KEY: readonly TaxFactKey[] = [
  "W2_WAGES",
  "W2_SOCIAL_SECURITY_WAGES",
  "W2_MEDICARE_WAGES",
  "W2_FEDERAL_WITHHOLDING",
  "W2_STATE_WITHHOLDING",
  "INTEREST_INCOME",
  "ORDINARY_DIVIDENDS",
  "QUALIFIED_DIVIDENDS",
  "CAPITAL_GAIN_OR_LOSS",
  "SELF_EMPLOYMENT_NET_PROFIT",
  "UNEMPLOYMENT_COMPENSATION",
  "RETIREMENT_INCOME",
  "SOCIAL_SECURITY_BENEFITS",
  "RENTAL_INCOME",
  "K1_INCOME",
  "OTHER_1099_INCOME",
  "OTHER_INCOME",
  "ITEMIZED_DEDUCTIONS_TOTAL",
  "MORTGAGE_INTEREST",
  "CHARITABLE_CONTRIBUTIONS",
  "STATE_ADDITIONS",
  "STATE_SUBTRACTIONS",
  "FEDERAL_ESTIMATED_PAYMENTS",
  "STATE_ESTIMATED_PAYMENTS",
];

describe("the vocabulary is complete", () => {
  it("defines every key in the union", () => {
    for (const key of EVERY_KEY) {
      expect(() => factDefinition(key)).not.toThrow();
    }
  });

  it("has no definition for a key outside the union", () => {
    expect(allFactDefinitions().map((definition) => definition.key).sort()).toEqual([...EVERY_KEY].sort());
  });

  it("defines each key exactly once", () => {
    const keys = allFactDefinitions().map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("throws rather than guessing for an unknown key", () => {
    expect(() => factDefinition("NOT_A_KEY" as TaxFactKey)).toThrow(RangeError);
  });

  it("recognises known keys and rejects invented ones", () => {
    expect(isKnownFactKey("W2_WAGES")).toBe(true);
    expect(isKnownFactKey("CRYPTO_STAKING_REWARDS")).toBe(false);
  });
});

describe("every definition is usable", () => {
  it("gives each fact a label a person could read", () => {
    for (const definition of allFactDefinitions()) {
      expect(definition.label.length).toBeGreaterThan(2);
      // The label is what appears on the package. A raw key there would be
      // an internal identifier leaking into a document about someone's taxes.
      expect(definition.label).not.toBe(definition.key);
    }
  });

  it("explains why every uncalculated fact is uncalculated", () => {
    for (const definition of allFactDefinitions()) {
      if (definition.support !== "COLLECTED_NOT_CALCULATED") continue;
      // Without a reason, the disclosure degrades to "some things weren't
      // included", which tells a person nothing they can act on.
      expect(definition.notModelledReason, `${definition.key} has no reason`).toBeTruthy();
      expect(definition.notModelledReason!.length).toBeGreaterThan(20);
    }
  });

  it("never claims a 2026 form line number", () => {
    for (const definition of allFactDefinitions()) {
      // The 2026 Form 1040 instructions are not published. A line number here
      // would be invented, which is exactly what the source-integrity work
      // exists to prevent.
      expect(definition.formConcept, `${definition.key} names a line number`).not.toMatch(/\bline\s+\d/i);
    }
  });

  it("marks every monetary fact as monetary", () => {
    // Every key in this vocabulary is currently an amount. A non-monetary key
    // added later needs its own validation path, so this fails on purpose
    // when one appears rather than letting it through untested.
    for (const definition of allFactDefinitions()) {
      expect(definition.monetary, `${definition.key}`).toBe(true);
    }
  });
});

describe("what may be negative", () => {
  it("allows a capital loss", () => {
    expect(factDefinition("CAPITAL_GAIN_OR_LOSS").allowsNegative).toBe(true);
  });

  it("does not allow negative wages", () => {
    expect(factDefinition("W2_WAGES").allowsNegative).toBe(false);
  });

  it("does not allow negative withholding", () => {
    expect(factDefinition("W2_FEDERAL_WITHHOLDING").allowsNegative).toBe(false);
  });
});

describe("support levels", () => {
  it("counts wages as calculated", () => {
    expect(calculatedKeys()).toContain("W2_WAGES");
    expect(calculatedKeys()).toContain("SELF_EMPLOYMENT_NET_PROFIT");
  });

  it("counts withholding as payments only, not income", () => {
    expect(paymentKeys()).toContain("W2_FEDERAL_WITHHOLDING");
    expect(calculatedKeys()).not.toContain("W2_FEDERAL_WITHHOLDING");
  });

  it("does not treat rental income as calculated", () => {
    // No engine models it. Claiming otherwise would understate tax on a
    // return that looked finished.
    expect(calculatedKeys()).not.toContain("RENTAL_INCOME");
    expect(factDefinition("RENTAL_INCOME").support).toBe("COLLECTED_NOT_CALCULATED");
  });
});

describe("the not-modelled disclosure", () => {
  it("names an uncalculated fact that is present", () => {
    const disclosed = notModelledFor(["W2_WAGES", "RENTAL_INCOME"]);
    expect(disclosed).toHaveLength(1);
    expect(disclosed[0]).toContain(factDefinition("RENTAL_INCOME").label);
  });

  it("says nothing about categories the person does not have", () => {
    // Burying the two entries that matter in a list of fifteen is how
    // disclosure stops working.
    expect(notModelledFor(["W2_WAGES"])).toEqual([]);
  });

  it("mentions each uncalculated fact once, however many entries there were", () => {
    expect(notModelledFor(["RENTAL_INCOME", "RENTAL_INCOME", "RENTAL_INCOME"])).toHaveLength(1);
  });

  it("says nothing at all for an empty case", () => {
    expect(notModelledFor([])).toEqual([]);
  });

  it("does not disclose payment facts as unmodelled", () => {
    // Withholding is not missing from the calculation; it is not part of it.
    expect(notModelledFor(["W2_FEDERAL_WITHHOLDING"])).toEqual([]);
  });
});
