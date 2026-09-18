import { describe, expect, it } from "vitest";
import { calculateCaliforniaSdi } from "./california-sdi";
import { calculateCaliforniaTax } from "../engines/us-ca";

/**
 * California SDI, and the boundary between payroll withholding and income
 * tax that it must never cross.
 */

const dollars = (amount: number) => Math.round(amount * 100);

function run(wages: number, taxYear = 2026) {
  return calculateCaliforniaSdi({ taxYear, wagesMinor: dollars(wages), currency: "USD" });
}

function ok(outcome: ReturnType<typeof run>) {
  if (!outcome.supported) throw new Error(`Expected a supported result, got ${outcome.reason}: ${outcome.message}`);
  return outcome;
}

describe("the 2026 rate", () => {
  it("is 1.3%", () => {
    expect(ok(run(100_000)).rateBasisPoints).toBe(130);
  });

  it("withholds $1,300 on $100,000 of wages", () => {
    expect(ok(run(100_000)).contribution.amountMinor).toBe(dollars(1_300));
  });

  it("withholds nothing on zero wages", () => {
    expect(ok(run(0)).contribution.amountMinor).toBe(0);
  });

  it("rounds half-up at the cent", () => {
    // $1,000.50 × 1.3% = $13.0065 → $13.01.
    expect(ok(run(1_000.5)).contribution.amountMinor).toBe(1301);
  });
});

describe("there is no wage ceiling, and inventing one would be expensive", () => {
  it("reports the ceiling as null rather than as a number", () => {
    expect(ok(run(100_000)).wageCeilingMinor).toBeNull();
  });

  it("exposes every dollar of wages to the rate", () => {
    const result = ok(run(2_000_000));
    expect(result.wagesSubject.amountMinor).toBe(result.wages.amountMinor);
    expect(result.contribution.amountMinor).toBe(dollars(26_000));
  });

  it("stays exactly linear in wages — the signature of an absent cap", () => {
    // If a ceiling were reintroduced anywhere, the ratio would collapse
    // above it. This is the check that catches that regression.
    const low = ok(run(50_000)).contribution.amountMinor;
    const high = ok(run(5_000_000)).contribution.amountMinor;
    expect(high).toBe(low * 100);
  });

  it("says so in the note it hands to the model", () => {
    expect(ok(run(100_000)).note).toContain("no SDI taxable wage ceiling since 1 January 2024");
  });
});

describe("SDI is not income tax, and the two never meet", () => {
  it("uses EDD's own 2026 rate while income tax for 2026 falls back to 2025 rules", () => {
    // The point of separating them. EDD and FTB publish on their own
    // timetables: the 2026 SDI rate is real and current, while the 2026
    // income tax figure is an estimate under 2025 rules. One result must not
    // inherit the other's status.
    const sdi = ok(run(100_000));
    expect(sdi.ruleSetVersion).toBe("2026.0");

    const incomeTax = calculateCaliforniaTax({
      organizationId: "33333333-3333-4333-8333-333333333333",
      taxYear: 2026,
      filingStatus: "single",
      ordinaryIncomeMinor: dollars(100_000),
      federalAdjustedGrossIncomeMinor: dollars(100_000),
      currency: "USD",
    });
    expect(incomeTax.supported).toBe(true);
    if (incomeTax.supported) {
      expect(incomeTax.calculationStatus).toBe("ESTIMATE_USING_LATEST_PUBLISHED_RULES");
      expect(incomeTax.ruleSetVersion).toBe("2025.1");
    }
  });

  it("never appears in a California income tax total or trace", () => {
    const result = calculateCaliforniaTax({
      organizationId: "33333333-3333-4333-8333-333333333333",
      taxYear: 2025,
      filingStatus: "single",
      ordinaryIncomeMinor: dollars(100_000),
      federalAdjustedGrossIncomeMinor: dollars(100_000),
      currency: "USD",
    });
    if (!result.supported) throw new Error("2025 California should be supported");

    expect(result.steps.some((step) => step.key.includes("sdi"))).toBe(false);
    expect(JSON.stringify(result.totals)).not.toContain("sdi");
    // $100,000 of wages would carry $1,300 of SDI. The income tax figure is
    // exactly the published Tax Table row ($5,209), so none of it was folded in.
    expect(result.totals.totalTax.amountMinor).toBe(dollars(5_209));
  });

  it("labels itself payroll withholding administered by EDD", () => {
    const note = ok(run(100_000)).note;
    expect(note).toContain("EDD");
    expect(note).toContain("not California income tax");
  });

  it("cites EDD, not FTB", () => {
    expect(ok(run(100_000)).source.url).toContain("edd.ca.gov");
    expect(ok(run(100_000)).source.authority).toContain("Employment Development Department");
  });
});

describe("refusals", () => {
  it("refuses 2025, whose rate was not established from an EDD source here", () => {
    const outcome = run(100_000, 2025);
    expect(outcome.supported).toBe(false);
    if (outcome.supported) return;
    expect(outcome.reason).toBe("rules_not_published");
  });

  it("refuses a year with no California rule set at all", () => {
    const outcome = run(100_000, 2024);
    expect(outcome.supported).toBe(false);
    if (outcome.supported) return;
    expect(outcome.reason).toBe("unsupported_tax_year");
  });

  it("refuses a currency mismatch rather than converting", () => {
    const outcome = calculateCaliforniaSdi({ taxYear: 2026, wagesMinor: dollars(100_000), currency: "EUR" });
    expect(outcome.supported).toBe(false);
    if (outcome.supported) return;
    expect(outcome.reason).toBe("currency_mismatch");
  });

  it("refuses negative wages, which are a mistake rather than a loss", () => {
    const outcome = run(-1_000);
    expect(outcome.supported).toBe(false);
    if (outcome.supported) return;
    expect(outcome.reason).toBe("invalid_input");
  });

  it("refuses a non-integer amount", () => {
    const outcome = calculateCaliforniaSdi({ taxYear: 2026, wagesMinor: 100.5, currency: "USD" });
    expect(outcome.supported).toBe(false);
    if (outcome.supported) return;
    expect(outcome.reason).toBe("invalid_input");
  });
});

describe("determinism", () => {
  it("stamps the rule-set version, so a stored payroll figure is reproducible", () => {
    expect(ok(run(100_000)).ruleSetVersion).toBe("2026.0");
  });

  it("returns byte-identical output for identical input", () => {
    const input = { taxYear: 2026, wagesMinor: dollars(183_722.41), currency: "USD" as const };
    expect(JSON.stringify(calculateCaliforniaSdi(input))).toBe(JSON.stringify(calculateCaliforniaSdi(input)));
  });

  it("takes no rate from its caller", () => {
    const tampered = calculateCaliforniaSdi({
      taxYear: 2026,
      wagesMinor: dollars(100_000),
      currency: "USD",
      ...({ rateBasisPoints: 9999, wageCeilingMinor: 1 } as unknown as object),
    });
    expect(ok(tampered).contribution.amountMinor).toBe(dollars(1_300));
  });
});
