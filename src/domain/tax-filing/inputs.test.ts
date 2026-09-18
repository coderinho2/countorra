import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";
import { dependent, fact, scenario, w2Facts } from "./fixtures.test-helpers";
import { inputFingerprintMaterial, liveInputsMatchFrozen } from "./inputs";

describe("canonical JSON", () => {
  it("ignores key order at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }));
  });

  it("keeps array order, because order in an array is meaningful", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("drops undefined properties the way jsonb does", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("refuses values that cannot survive a database round trip", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });
});

describe("whether frozen inputs still describe the case", () => {
  it("matches when nothing changed", () => {
    const input = scenario();
    expect(liveInputsMatchFrozen(input.latest!.snapshot, { preparationCase: input.preparationCase, facts: input.facts, dependents: input.dependents, jurisdictions: input.completeness.jurisdictions })).toBe(
      true,
    );
  });

  it("survives a database round trip of the frozen snapshot", () => {
    const input = scenario({ dependents: [dependent()] });
    const roundTripped = JSON.parse(JSON.stringify(input.latest!.snapshot));
    expect(liveInputsMatchFrozen(roundTripped, { preparationCase: input.preparationCase, facts: input.facts, dependents: input.dependents, jurisdictions: input.completeness.jurisdictions })).toBe(true);
  });

  it("does not match once a confirmed figure is added", () => {
    const input = scenario();
    const facts = [...input.facts, fact("FEDERAL_ESTIMATED_PAYMENTS", 10_000)];
    expect(liveInputsMatchFrozen(input.latest!.snapshot, { preparationCase: input.preparationCase, facts, dependents: input.dependents, jurisdictions: input.completeness.jurisdictions })).toBe(false);
  });

  it("does not match when the filing status or taxpayer changed", () => {
    const input = scenario();
    const live = { facts: input.facts, dependents: input.dependents, jurisdictions: input.completeness.jurisdictions };
    expect(liveInputsMatchFrozen(input.latest!.snapshot, { ...live, preparationCase: { ...input.preparationCase, filingStatus: "married_filing_jointly" } })).toBe(false);
    expect(liveInputsMatchFrozen(input.latest!.snapshot, { ...live, preparationCase: { ...input.preparationCase, taxpayer: { ...input.preparationCase.taxpayer, legalLastName: "Changed" } } })).toBe(false);
  });

  it("does not care about fact row order", () => {
    const facts = w2Facts();
    const input = scenario({ facts });
    expect(
      liveInputsMatchFrozen(input.latest!.snapshot, { preparationCase: input.preparationCase, facts: [...facts].reverse(), dependents: input.dependents, jurisdictions: input.completeness.jurisdictions }),
    ).toBe(true);
  });

  it("fingerprints the preparation snapshot id, inputs and calculation together", () => {
    const input = scenario();
    const material = inputFingerprintMaterial(input.latest!);
    expect(material).toContain(input.latest!.id);
    expect(inputFingerprintMaterial({ ...input.latest!, id: "another-snapshot" })).not.toBe(material);
  });
});
