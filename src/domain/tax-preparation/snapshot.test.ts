import { describe, expect, it } from "vitest";
import { buildSnapshot, federalPaymentsMinor, has, statePaymentsMinor, toEngineInput, totalFor, type BuildSnapshotInput } from "./snapshot";
import type { TaxFact, TaxFactKey, TaxpayerProfile } from "./types";

/**
 * The immutable snapshot, and the one door from facts into the engines.
 *
 * The rule under test above all others: ONLY CONFIRMED FACTS GET IN. A
 * proposed value is visible to the person and invisible to the engine until
 * someone accepts it.
 */

const TAXPAYER: TaxpayerProfile = {
  legalFirstName: "Dana",
  legalMiddleName: null,
  legalLastName: "Okafor",
  dateOfBirth: "1985-04-12",
  taxIdentifierType: "ssn",
  taxIdentifierOnFile: true,
  primaryStateRegion: "CA",
  additionalStateRegions: [],
  spouseFirstName: null,
  spouseLastName: null,
  spouseDateOfBirth: null,
  spouseTaxIdentifierOnFile: false,
  spouseItemizesDeductions: null,
};

let counter = 0;
function fact(key: TaxFactKey, amountMinor: number, overrides: Partial<TaxFact> = {}): TaxFact {
  counter += 1;
  return {
    id: `fact-${counter}`,
    organizationId: "org-1",
    caseId: "case-1",
    version: 1,
    key,
    amountMinor,
    currency: "USD",
    textValue: null,
    source: "USER_ENTERED",
    state: "CONFIRMED",
    evidenceDocumentId: null,
    evidenceNote: null,
    createdAt: "2026-02-01T00:00:00.000Z",
    createdBy: "user-1",
    ...overrides,
  };
}

function snapshot(facts: TaxFact[], overrides: Partial<BuildSnapshotInput> = {}) {
  return buildSnapshot({
    organizationId: "org-1",
    caseId: "case-1",
    version: 1,
    taxYear: 2026,
    filingStatus: "single",
    taxpayer: TAXPAYER,
    dependents: [],
    facts,
    jurisdictions: ["US_FEDERAL", "US_CA"],
    createdBy: "user-1",
    createdAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("only confirmed facts get in", () => {
  it("leaves out a proposed value", () => {
    const frozen = snapshot([fact("W2_WAGES", 8_500_000), fact("W2_WAGES", 99_999_999, { state: "PROPOSED", source: "AI_PROPOSED" })]);
    expect(frozen.facts).toHaveLength(1);
    expect(totalFor(frozen, "W2_WAGES")).toBe(8_500_000);
  });

  it("leaves out a rejected value", () => {
    const frozen = snapshot([fact("W2_WAGES", 8_500_000), fact("W2_WAGES", 1_000_000, { state: "REJECTED" })]);
    expect(totalFor(frozen, "W2_WAGES")).toBe(8_500_000);
  });

  it("is empty when nothing is confirmed", () => {
    expect(snapshot([fact("W2_WAGES", 8_500_000, { state: "PROPOSED" })]).facts).toEqual([]);
  });

  it("keeps an AI-proposed value once a person has confirmed it, with its provenance intact", () => {
    const frozen = snapshot([fact("W2_WAGES", 8_500_000, { source: "AI_PROPOSED", state: "CONFIRMED" })]);
    // Accepted, and still labelled as having come from a model. The snapshot
    // does not launder where a figure came from.
    expect(frozen.facts[0].source).toBe("AI_PROPOSED");
  });
});

describe("determinism", () => {
  it("serializes the same facts identically whatever order they arrive in", () => {
    const a = fact("W2_WAGES", 5_000_000);
    const b = fact("INTEREST_INCOME", 20_000);
    const c = fact("W2_WAGES", 3_500_000);
    // A snapshot whose bytes depend on row order is not comparable to itself.
    expect(JSON.stringify(snapshot([a, b, c]).facts)).toBe(JSON.stringify(snapshot([c, a, b]).facts));
  });

  it("carries no database row ids or timestamps per fact", () => {
    const frozen = snapshot([fact("W2_WAGES", 8_500_000)]);
    expect(Object.keys(frozen.facts[0]).sort()).toEqual(["amountMinor", "currency", "evidenceDocumentId", "evidenceNote", "key", "source", "textValue"]);
  });

  it("ties its id to the case version", () => {
    expect(snapshot([fact("W2_WAGES", 1)], { version: 3 }).id).toBe("case-1:3");
  });
});

describe("totals", () => {
  it("adds two W-2s together", () => {
    expect(totalFor(snapshot([fact("W2_WAGES", 5_000_000), fact("W2_WAGES", 3_500_000)]), "W2_WAGES")).toBe(8_500_000);
  });

  it("distinguishes absent from zero", () => {
    const frozen = snapshot([fact("W2_WAGES", 0)]);
    expect(has(frozen, "W2_WAGES")).toBe(true);
    expect(has(frozen, "SELF_EMPLOYMENT_NET_PROFIT")).toBe(false);
  });
});

describe("toEngineInput — the only door into the engines", () => {
  it("passes wages and self-employment profit", () => {
    const input = toEngineInput(snapshot([fact("W2_WAGES", 8_500_000), fact("SELF_EMPLOYMENT_NET_PROFIT", 2_000_000)]), "USD");
    expect(input.ordinaryIncomeMinor).toBe(8_500_000);
    expect(input.selfEmploymentNetProfitMinor).toBe(2_000_000);
  });

  it("takes the tax year and filing status from the frozen snapshot, nowhere else", () => {
    const input = toEngineInput(snapshot([fact("W2_WAGES", 1)], { taxYear: 2026, filingStatus: "married_filing_jointly" }), "USD");
    expect(input.taxYear).toBe(2026);
    expect(input.filingStatus).toBe("married_filing_jointly");
  });

  it("leaves W-2 boxes 3 and 5 undefined when they were never entered, rather than zero", () => {
    // Zero box-5 wages would tell the federal engine there were no Medicare
    // wages at all. Undefined lets it apply its own documented rule.
    const input = toEngineInput(snapshot([fact("W2_WAGES", 8_500_000)]), "USD");
    expect(input.w2SocialSecurityWagesMinor).toBeUndefined();
    expect(input.w2MedicareWagesMinor).toBeUndefined();
  });

  it("does not let an uncalculated fact reach the engine", () => {
    const withRental = toEngineInput(snapshot([fact("W2_WAGES", 8_500_000), fact("RENTAL_INCOME", 5_000_000)]), "USD");
    const without = toEngineInput(snapshot([fact("W2_WAGES", 8_500_000)]), "USD");
    // Rental income is collected and disclosed, never quietly added to wages.
    expect(withRental).toEqual(without);
  });

  it("does not let payments reach the engine as income", () => {
    const withWithholding = toEngineInput(snapshot([fact("W2_WAGES", 8_500_000), fact("W2_FEDERAL_WITHHOLDING", 900_000)]), "USD");
    expect(withWithholding.ordinaryIncomeMinor).toBe(8_500_000);
  });

  it("passes a dependent count only when there are dependents", () => {
    expect(toEngineInput(snapshot([fact("W2_WAGES", 1)]), "USD").dependentCount).toBeUndefined();
  });
});

describe("payments", () => {
  it("is null — not zero — when no federal payment is recorded", () => {
    // The absence of withholding data is not zero withholding. Treating it as
    // zero would turn every un-entered W-2 box 2 into a fictitious bill.
    expect(federalPaymentsMinor(snapshot([fact("W2_WAGES", 8_500_000)]))).toBeNull();
  });

  it("adds withholding and estimated payments", () => {
    const frozen = snapshot([fact("W2_FEDERAL_WITHHOLDING", 900_000), fact("FEDERAL_ESTIMATED_PAYMENTS", 100_000)]);
    expect(federalPaymentsMinor(frozen)).toBe(1_000_000);
  });

  it("is zero, not null, when zero withholding was actually entered", () => {
    expect(federalPaymentsMinor(snapshot([fact("W2_FEDERAL_WITHHOLDING", 0)]))).toBe(0);
  });

  it("keeps state and federal payments apart", () => {
    const frozen = snapshot([fact("W2_STATE_WITHHOLDING", 300_000)]);
    expect(statePaymentsMinor(frozen)).toBe(300_000);
    expect(federalPaymentsMinor(frozen)).toBeNull();
  });
});
