import { describe, expect, it } from "vitest";
import { CASE_ID, ORG, fact, scenario, w2Facts, type ScenarioOptions } from "./fixtures.test-helpers";
import { EXPORT_NOTICE, decimal, exportFileName, toCsvExport, toJsonExport, toTextSummary } from "./export";
import { buildFilingPackage } from "./package";
import { assessFilingReadiness } from "./readiness";

function pkg(options: ScenarioOptions = {}) {
  const input = scenario(options);
  const readiness = assessFilingReadiness(input);
  return buildFilingPackage({
    organizationId: ORG,
    currency: "USD",
    filingCaseId: "55555555-5555-4555-8555-555555555555",
    filingVersion: 2,
    preparationCaseId: CASE_ID,
    preparation: input.latest!,
    readiness,
    scope: readiness.finalizableScope ?? "FULL",
    generatedAt: "2026-09-13T12:00:00.000Z",
  });
}

describe("filing package exports", () => {
  it("are deterministic in every format", () => {
    for (const render of [toJsonExport, toCsvExport, toTextSummary]) {
      expect(render(pkg({ state: "AZ" }))).toBe(render(pkg({ state: "AZ" })));
    }
  });

  it("open with the notice that this is not a filing form", () => {
    expect(JSON.parse(toJsonExport(pkg())).notice).toBe(EXPORT_NOTICE);
    expect(toCsvExport(pkg()).split("\r\n")[1]).toContain(EXPORT_NOTICE);
    expect(toTextSummary(pkg()).split("\n")[0]).toBe(EXPORT_NOTICE);
    expect(EXPORT_NOTICE).toBe("Preparation summary — not an IRS or state filing form. Countorra has not filed or submitted this return.");
  });

  it("carry the stored package verbatim in JSON", () => {
    const filingPackage = pkg();
    expect(JSON.parse(toJsonExport(filingPackage)).package).toEqual(JSON.parse(JSON.stringify(filingPackage)));
  });

  it("render no official form, line number, secret or confirmation number", () => {
    // The engines' verified disclosures are carried verbatim, and some NAME a
    // form — New York's notes that a filed Form IT-201 uses a tax table. Naming
    // a form in a disclosure is not rendering one. What must never appear is a
    // form's structure: its title as a heading, or line numbers.
    for (const body of [toJsonExport(pkg({ state: "NY" })), toCsvExport(pkg({ state: "NY" })), toTextSummary(pkg({ state: "NY" }))]) {
      expect(body).not.toMatch(/\bline\s*\d+[a-z]?\b/i);
      expect(body).not.toMatch(/^\s*(U\.S\. Individual Income Tax Return|Form \S+ \(20\d\d\))/m);
      expect(body).not.toMatch(/confirmation (number|#)|submission id|accepted by|e-?filed/i);
      expect(body).not.toMatch(/service_role|SUPABASE|eyJhbGci|password/i);
    }
  });

  it("render amounts as exact decimals from integer minor units", () => {
    expect(decimal(0)).toBe("0.00");
    expect(decimal(5)).toBe("0.05");
    expect(decimal(1_234_567)).toBe("12345.67");
    expect(decimal(-100)).toBe("-1.00");
    expect(toCsvExport(pkg())).toContain("W-2 wages,85000.00,USD");
  });

  it("neutralise spreadsheet formulas from text a user controls", () => {
    const body = toCsvExport(pkg({ facts: [...w2Facts(), fact("OTHER_INCOME", 1_000)] }));
    expect(body).not.toMatch(/(^|,)=/m);
  });

  it("name files by year and version only", () => {
    expect(exportFileName(pkg(), "csv")).toBe("countorra-filing-package-2026-v2.csv");
  });

  it("state a refund only when it is determinable", () => {
    const text = toTextSummary(pkg({ facts: [fact("W2_WAGES", 8_500_000), fact("W2_SOCIAL_SECURITY_WAGES", 8_500_000), fact("W2_MEDICARE_WAGES", 8_500_000)] }));
    expect(text).toContain("Federal refund or balance due: not determinable");
  });
});
