import { describe, expect, it } from "vitest";
import { dependentStatusFor } from "./dependents";

const COMPLETE = { dateOfBirth: "2015-06-01", monthsLivedWithTaxpayer: 12, hasTaxIdentifier: true, claimedByAnother: false };

describe("dependent information status", () => {
  it("is verified when every field a reviewer needs is present", () => {
    expect(dependentStatusFor(COMPLETE)).toBe("VERIFIED");
  });

  it("is incomplete without a date of birth", () => {
    expect(dependentStatusFor({ ...COMPLETE, dateOfBirth: null })).toBe("INCOMPLETE");
  });

  it("is incomplete without months lived with the taxpayer", () => {
    expect(dependentStatusFor({ ...COMPLETE, monthsLivedWithTaxpayer: null })).toBe("INCOMPLETE");
  });

  it("is incomplete when no identifier is on file", () => {
    expect(dependentStatusFor({ ...COMPLETE, hasTaxIdentifier: false })).toBe("INCOMPLETE");
  });

  it("needs review when someone else may be claiming the same person", () => {
    expect(dependentStatusFor({ ...COMPLETE, claimedByAnother: true })).toBe("NEEDS_REVIEW");
  });

  it("does not apply a residency threshold it has no authority to apply", () => {
    // Zero months is a legitimate, complete answer. Whether it qualifies is a
    // legal question for a reviewer, not a rule for this function.
    expect(dependentStatusFor({ ...COMPLETE, monthsLivedWithTaxpayer: 0 })).toBe("VERIFIED");
  });

  it("never assigns not-supported on its own", () => {
    const combinations = [true, false].flatMap((hasTaxIdentifier) =>
      [true, false].flatMap((claimedByAnother) => [null, "2015-06-01"].map((dateOfBirth) => ({ ...COMPLETE, hasTaxIdentifier, claimedByAnother, dateOfBirth }))),
    );
    for (const dependent of combinations) {
      expect(dependentStatusFor(dependent)).not.toBe("NOT_SUPPORTED");
    }
  });
});
