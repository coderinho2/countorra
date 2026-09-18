import { describe, expect, it } from "vitest";
import { classifyDocument } from "./classification";

/** Classification from content, never from a filename. */

const W2 = ["Form W-2 Wage and Tax Statement 2026", "1 Wages, tips, other compensation  2 Federal income tax withheld", "3 Social security wages  5 Medicare wages and tips", "b Employer identification number (EIN)"].join("\n");

describe("classification", () => {
  it("identifies a W-2 from its title and box labels, with high confidence", () => {
    const result = classifyDocument([W2]);
    expect(result).toMatchObject({ documentType: "W2", confidence: "HIGH", method: "CONTENT_SIGNALS", reviewRequired: false });
    expect(result.signals).toEqual(expect.arrayContaining(["form-w2", "wage-and-tax-statement", "box1-wages"]));
  });

  it("takes no filename at all — a document that merely mentions 'W2' is not a W-2", () => {
    expect(classifyDocument.length).toBe(1);
    expect(classifyDocument(["scan_W2_final.pdf", "notes about my W2 from last year"]).documentType).toBe("UNKNOWN");
  });

  it("does not call a bank statement a 1099-INT because it says 'interest income'", () => {
    const statement = ["First Synthetic Bank", "Checking Statement", "Statement Period 01/01/2026 to 01/31/2026", "Beginning Balance 1,000.00", "Interest income 1.23", "Ending Balance 1,001.23"].join("\n");
    expect(classifyDocument([statement]).documentType).toBe("BANK_STATEMENT");
  });

  it("chooses nothing when a document matches two types equally", () => {
    const mixed = ["Form 1099-INT Interest income Tax-exempt interest", "Form 1099-DIV Total ordinary dividends Qualified dividends"].join("\n");
    const result = classifyDocument([mixed]);
    expect(result).toMatchObject({ documentType: "UNKNOWN", confidence: "NONE", reviewRequired: true });
    expect(result.reviewReason).toMatch(/matches both/);
  });

  it("tells 1098-T from 1098", () => {
    expect(classifyDocument(["Form 1098-T Tuition Statement Payments received for qualified tuition"]).documentType).toBe("FORM_1098_T");
    expect(classifyDocument(["Form 1098 Mortgage Interest Statement Mortgage interest received"]).documentType).toBe("FORM_1098");
  });

  it("requires review when only some markings are present", () => {
    const partial = classifyDocument(["Form W-2", "1 Wages, tips, other compensation"]);
    expect(partial).toMatchObject({ documentType: "W2", confidence: "MEDIUM", reviewRequired: true });
    expect(classifyDocument(["Form W-2"])).toMatchObject({ confidence: "LOW", reviewRequired: true });
  });

  it("marks an unrecognised document with several amounts as other-financial, for review", () => {
    expect(classifyDocument(["Club dues 12.00", "Locker 30.00", "Total 42.00"])).toMatchObject({ documentType: "OTHER_FINANCIAL", confidence: "LOW", reviewRequired: true });
  });

  it("returns UNKNOWN when no text was read", () => {
    expect(classifyDocument([])).toMatchObject({ documentType: "UNKNOWN", method: "NO_TEXT", reviewRequired: true });
    expect(classifyDocument(["   "])).toMatchObject({ documentType: "UNKNOWN", method: "NO_TEXT" });
  });
});
