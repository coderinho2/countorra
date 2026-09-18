import { describe, expect, it } from "vitest";
import { addDependentSchema, recordFactSchema, reviewFactSchema, startTaxPreparationSchema, updateTaxpayerSchema } from "./tax-preparation";

/**
 * The tax preparation form schemas.
 *
 * The most important property is a refusal: a tax identification number typed
 * into a free-text field never gets as far as the database. There is no column
 * for one, and there must be no side door either.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const CASE = "33333333-3333-4333-8333-333333333333";

const fact = (overrides: Record<string, unknown> = {}) => recordFactSchema.safeParse({ organizationId: ORG, caseId: CASE, key: "W2_WAGES", amount: "85000.00", ...overrides });

describe("tax identifiers in free text", () => {
  it("refuses an SSN in an evidence note, however it is written", () => {
    for (const evidenceNote of ["123-45-6789", "SSN 123456789", "id 123 45 6789", "123.45.6789"]) {
      const result = fact({ evidenceNote });
      expect(result.success, evidenceNote).toBe(false);
      if (!result.success) expect(result.error.issues[0].message).toMatch(/never stores the number/);
    }
  });

  it("refuses one in a taxpayer name field", () => {
    expect(updateTaxpayerSchema.safeParse({ organizationId: ORG, caseId: CASE, legalFirstName: "123-45-6789" }).success).toBe(false);
  });

  it("refuses one in a dependent's name", () => {
    expect(addDependentSchema.safeParse({ organizationId: ORG, caseId: CASE, firstName: "Sam 123456789", lastName: "Okafor", relationship: "son" }).success).toBe(false);
  });

  it("accepts an ordinary evidence note", () => {
    expect(fact({ evidenceNote: "W-2 box 1, Acme Corp 2026" }).success).toBe(true);
  });

  it("accepts a ten-digit reference number, which is not an SSN", () => {
    expect(fact({ evidenceNote: "Invoice 1234567890" }).success).toBe(true);
  });
});

describe("amounts", () => {
  it("accepts a plain decimal and a loss", () => {
    expect(fact({ amount: "85000" }).success).toBe(true);
    expect(fact({ key: "CAPITAL_GAIN_OR_LOSS", amount: "-3000.00" }).success).toBe(true);
  });

  it("refuses anything that is not a plain decimal", () => {
    for (const amount of ["1e5", "Infinity", "NaN", "85,000", "85000.001", "$85000", ""]) {
      expect(fact({ amount }).success, amount).toBe(false);
    }
  });

  it("refuses a key outside the vocabulary", () => {
    expect(fact({ key: "TAX_RATE" }).success).toBe(false);
  });

  it("treats a blank document as no document", () => {
    const result = fact({ evidenceDocumentId: "" });
    expect(result.success && result.data.evidenceDocumentId).toBeNull();
  });

  it("refuses a document id that is not a uuid", () => {
    expect(fact({ evidenceDocumentId: "../../etc/passwd" }).success).toBe(false);
  });
});

describe("review", () => {
  it("allows only confirm or reject", () => {
    const base = { organizationId: ORG, caseId: CASE, factId: CASE };
    expect(reviewFactSchema.safeParse({ ...base, decision: "confirm" }).success).toBe(true);
    expect(reviewFactSchema.safeParse({ ...base, decision: "approve_and_file" }).success).toBe(false);
  });
});

describe("taxpayer", () => {
  it("reads a blank filing status as not chosen", () => {
    const result = updateTaxpayerSchema.safeParse({ organizationId: ORG, caseId: CASE, filingStatus: "" });
    expect(result.success && result.data.filingStatus).toBeNull();
  });

  it("refuses an invented filing status", () => {
    expect(updateTaxpayerSchema.safeParse({ organizationId: ORG, caseId: CASE, filingStatus: "exempt" }).success).toBe(false);
  });

  it("normalizes additional states to upper-case codes", () => {
    const result = updateTaxpayerSchema.safeParse({ organizationId: ORG, caseId: CASE, additionalStateRegions: "ny, nj" });
    expect(result.success && result.data.additionalStateRegions).toEqual(["NY", "NJ"]);
  });

  it("refuses a state written out in full", () => {
    expect(updateTaxpayerSchema.safeParse({ organizationId: ORG, caseId: CASE, additionalStateRegions: "New York" }).success).toBe(false);
  });

  it("reads yes as true and anything absent as false", () => {
    const yes = updateTaxpayerSchema.safeParse({ organizationId: ORG, caseId: CASE, taxIdentifierOnFile: "yes" });
    const absent = updateTaxpayerSchema.safeParse({ organizationId: ORG, caseId: CASE });
    expect(yes.success && yes.data.taxIdentifierOnFile).toBe(true);
    expect(absent.success && absent.data.taxIdentifierOnFile).toBe(false);
  });

  it("refuses a malformed date", () => {
    expect(updateTaxpayerSchema.safeParse({ organizationId: ORG, caseId: CASE, dateOfBirth: "12/04/1985" }).success).toBe(false);
  });

  it("has no field through which a tax year or state could be chosen", () => {
    const result = updateTaxpayerSchema.safeParse({ organizationId: ORG, caseId: CASE, taxYear: 2019, primaryStateRegion: "TX" });
    // Unknown keys are dropped: neither reaches the update.
    expect(result.success && "taxYear" in result.data).toBe(false);
    expect(result.success && "primaryStateRegion" in result.data).toBe(false);
  });
});

describe("dependents", () => {
  const base = { organizationId: ORG, caseId: CASE, firstName: "Sam", lastName: "Okafor", relationship: "son" };

  it("accepts a minimal dependent", () => {
    expect(addDependentSchema.safeParse(base).success).toBe(true);
  });

  it("refuses months outside the year", () => {
    expect(addDependentSchema.safeParse({ ...base, monthsLivedWithTaxpayer: "13" }).success).toBe(false);
  });

  it("reads blank months as unknown, not zero", () => {
    const result = addDependentSchema.safeParse({ ...base, monthsLivedWithTaxpayer: "" });
    expect(result.success && result.data.monthsLivedWithTaxpayer).toBeNull();
  });

  it("requires a name", () => {
    expect(addDependentSchema.safeParse({ ...base, firstName: "  " }).success).toBe(false);
  });
});

describe("starting a year", () => {
  it("coerces the posted year", () => {
    const result = startTaxPreparationSchema.safeParse({ organizationId: ORG, taxYear: "2026" });
    expect(result.success && result.data.taxYear).toBe(2026);
  });

  it("refuses a nonsense year", () => {
    expect(startTaxPreparationSchema.safeParse({ organizationId: ORG, taxYear: "20266" }).success).toBe(false);
  });
});
