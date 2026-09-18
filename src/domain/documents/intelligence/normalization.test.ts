import { describe, expect, it } from "vitest";
import { containsSsnLike, currencyFromHint, detectDocumentCurrency, findAmounts, findDate, findTaxYear, maskSensitive, sanitizeText, toMinorUnits } from "./normalization";

/** N, O, P: money, dates, currency — and identifiers that must never be kept. */

describe("amounts", () => {
  it("reads US-formatted amounts as exact decimal strings", () => {
    expect(findAmounts("Wages $85,000.00")).toEqual([{ raw: "$85,000.00", decimal: "85000.00", negative: false, currencyHint: "$" }]);
    expect(findAmounts("85000.00")[0].decimal).toBe("85000.00");
    expect(findAmounts("1,234,567.89")[0].decimal).toBe("1234567.89");
  });

  it("recognises negatives written with a minus or in parentheses", () => {
    expect(findAmounts("-12.50")[0]).toMatchObject({ decimal: "-12.50", negative: true });
    expect(findAmounts("(1,234.56)")[0]).toMatchObject({ decimal: "-1234.56", negative: true });
  });

  it("does not treat a bare integer — a box number, a year, a code — as an amount", () => {
    expect(findAmounts("Box 12 2026 code 7")).toEqual([]);
  });

  it("refuses a European-formatted amount rather than reading it a thousand times wrong", () => {
    expect(findAmounts("1.234,56")).toEqual([]);
  });

  it("converts to minor units only with a known, supported currency — never through a float", () => {
    expect(toMinorUnits("85000.00", "USD")).toBe(8_500_000);
    expect(toMinorUnits("0.10", "USD")).toBe(10);
    expect(toMinorUnits("1234567.89", "EUR")).toBe(123_456_789);
    expect(toMinorUnits("85000.00", null)).toBeNull();
    expect(toMinorUnits("85000.00", "XYZ")).toBeNull();
  });
});

describe("currency", () => {
  it("is taken only from what the document states", () => {
    expect(detectDocumentCurrency("Total EUR 1,190.00")).toBe("EUR");
    expect(detectDocumentCurrency("Amount €5.00")).toBe("EUR");
    expect(detectDocumentCurrency("Balance £12.00")).toBe("GBP");
    expect(detectDocumentCurrency("US$ 10.00")).toBe("USD");
  });

  it("is not assumed from a dollar sign, which many currencies use", () => {
    expect(detectDocumentCurrency("Total $12.00")).toBeNull();
    expect(currencyFromHint("$")).toBeNull();
  });

  it("is not chosen when a document states two", () => {
    expect(detectDocumentCurrency("USD 10.00 and EUR 9.00")).toBeNull();
  });
});

describe("dates", () => {
  it("reads unambiguous forms", () => {
    expect(findDate("Issued 2026-04-15", "UNKNOWN")?.iso).toBe("2026-04-15");
    expect(findDate("January 5, 2026", "UNKNOWN")?.iso).toBe("2026-01-05");
    expect(findDate("5 Jan 2026", "UNKNOWN")?.iso).toBe("2026-01-05");
    expect(findDate("13/05/2026", "UNKNOWN")?.iso).toBe("2026-05-13");
  });

  it("does not read a numeric date that could be two different days", () => {
    expect(findDate("04/05/2026", "UNKNOWN")).toEqual({ raw: "04/05/2026", iso: null, ambiguous: true });
  });

  it("reads month-first where the document's convention is known", () => {
    expect(findDate("04/05/2026", "MONTH_FIRST")?.iso).toBe("2026-04-05");
  });

  it("refuses an impossible calendar date", () => {
    expect(findDate("02/30/2026", "MONTH_FIRST")?.iso).toBeNull();
  });
});

describe("tax year", () => {
  const title = /Form\s*W-?2/i;

  it("comes only from the line carrying the form's title", () => {
    expect(findTaxYear(["Form W-2 Wage and Tax Statement 2026"], title)).toEqual({ year: 2026, ambiguous: false });
    expect(findTaxYear(["2026", "Form W-2 Wage and Tax Statement"], title)).toEqual({ year: 2026, ambiguous: false });
  });

  it("is not inferred from a year elsewhere in the document, or from today", () => {
    expect(findTaxYear(["Form W-2 Wage and Tax Statement", "Printed 2025-01-31"], title)).toEqual({ year: null, ambiguous: false });
    expect(findTaxYear(["Something else"], title)).toEqual({ year: null, ambiguous: false });
  });

  it("is not chosen when the title line carries two years", () => {
    expect(findTaxYear(["Form W-2 2025 corrected for 2026"], title)).toEqual({ year: null, ambiguous: true });
  });
});

describe("identifiers are masked before anything is stored", () => {
  it("removes an SSN completely", () => {
    const masked = maskSensitive("Employee SSN 123-45-6789 and 987654321");
    expect(masked.masked).toBe(true);
    expect(masked.text).not.toMatch(/\d{3}-?\d{2}-?\d{4}/);
    expect(masked.text).toContain("•••-••-••••");
    expect(containsSsnLike(masked.text)).toBe(false);
  });

  it("keeps only the last four digits of an EIN, a card or an account number", () => {
    expect(maskSensitive("EIN 12-3456789").text).toBe("EIN ••-•••6789");
    expect(maskSensitive("Visa 4111 1111 1111 1111").text).toBe("Visa •••• 1111");
    expect(maskSensitive("Account 000123456789").text).toBe("Account ••••6789");
  });

  it("leaves formatted amounts alone", () => {
    expect(maskSensitive("Wages 85,000.00").text).toBe("Wages 85,000.00");
  });
});

describe("text as data", () => {
  it("removes control and bidirectional-override characters and bounds length", () => {
    const hostile = `Pay${String.fromCharCode(0)} to${String.fromCharCode(0x202e)} evil${String.fromCharCode(0x200b)}`;
    expect(sanitizeText(hostile)).toBe("Pay to evil");
    expect(sanitizeText("x".repeat(500), 50)).toHaveLength(50);
  });

  it("keeps markup as literal text — escaping is the renderer's job, and nothing here interprets it", () => {
    expect(sanitizeText("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
  });
});
