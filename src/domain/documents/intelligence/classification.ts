import type { Classification, ClassificationConfidence, DocumentType } from "./types";

/**
 * DOCUMENT CLASSIFICATION — from content, never from a name.
 *
 * The input is the text read out of the document and nothing else. The
 * filename is not a parameter, so "W2_final.pdf" containing a restaurant
 * receipt is classified as a receipt, and a W-2 saved as "scan001.pdf" is
 * classified as a W-2.
 *
 * HOW A TYPE IS DECIDED
 *
 * Each type has STRONG signals — the form's own identifier ("Form 1099-INT",
 * "Wage and Tax Statement") — and SUPPORTING signals — box labels and phrases
 * that the form prints. IRS forms require a strong signal: the phrase
 * "interest income" appears on every bank statement, and is not a 1099-INT.
 *
 *   HIGH    a strong signal and at least two supporting ones
 *   MEDIUM  a strong signal and one supporting one
 *   LOW     a strong signal alone, or (for non-IRS documents) supporting
 *           phrases without one
 *
 * When two types score within one point of each other, neither is chosen:
 * the document is UNKNOWN and needs review. A confident wrong type would route
 * a figure into the wrong tax fact.
 */

interface SignalSet {
  type: Exclude<DocumentType, "OTHER_FINANCIAL" | "UNKNOWN">;
  irsForm: boolean;
  strong: readonly [id: string, pattern: RegExp][];
  supporting: readonly [id: string, pattern: RegExp][];
}

const SIGNALS: readonly SignalSet[] = [
  {
    type: "W2",
    irsForm: true,
    strong: [
      ["form-w2", /\bForm\s*W-?2\b(?!\s*c)/i],
      ["wage-and-tax-statement", /Wage\s+and\s+Tax\s+Statement/i],
    ],
    supporting: [
      ["box1-wages", /Wages,?\s*tips,?\s*other\s*comp/i],
      ["box2-federal-withholding", /Federal\s+income\s+tax\s+withheld/i],
      ["box3-ss-wages", /Social\s+security\s+wages/i],
      ["box5-medicare-wages", /Medicare\s+wages\s+and\s+tips/i],
      ["employer-ein", /Employer\s+identification\s+number/i],
    ],
  },
  {
    type: "FORM_1099_NEC",
    irsForm: true,
    strong: [["form-1099-nec", /\b1099-NEC\b/i]],
    supporting: [
      ["nonemployee-compensation", /Nonemployee\s+compensation/i],
      ["payer", /PAYER['’]?S\s+(name|TIN)/i],
      ["recipient", /RECIPIENT['’]?S\s+(name|TIN)/i],
    ],
  },
  {
    type: "FORM_1099_MISC",
    irsForm: true,
    strong: [["form-1099-misc", /\b1099-MISC\b/i]],
    supporting: [
      ["miscellaneous-information", /Miscellaneous\s+Information/i],
      ["rents", /\bRents\b/i],
      ["royalties", /\bRoyalties\b/i],
      ["other-income", /\bOther\s+income\b/i],
    ],
  },
  {
    type: "FORM_1099_INT",
    irsForm: true,
    strong: [["form-1099-int", /\b1099-INT\b/i]],
    supporting: [
      ["interest-income", /\bInterest\s+income\b/i],
      ["early-withdrawal-penalty", /Early\s+withdrawal\s+penalty/i],
      ["tax-exempt-interest", /Tax-exempt\s+interest/i],
      ["savings-bonds", /U\.?\s?S\.?\s+Savings\s+Bonds/i],
    ],
  },
  {
    type: "FORM_1099_DIV",
    irsForm: true,
    strong: [["form-1099-div", /\b1099-DIV\b/i]],
    supporting: [
      ["dividends-and-distributions", /Dividends\s+and\s+Distributions/i],
      ["ordinary-dividends", /Total\s+ordinary\s+dividends/i],
      ["qualified-dividends", /Qualified\s+dividends/i],
      ["capital-gain-distributions", /Total\s+capital\s+gain\s+distr/i],
    ],
  },
  {
    type: "FORM_1099_B",
    irsForm: true,
    strong: [["form-1099-b", /\b1099-B\b/i]],
    supporting: [
      ["proceeds-from-broker", /Proceeds\s+From\s+Broker/i],
      ["cost-basis", /Cost\s+or\s+other\s+basis/i],
      ["date-sold", /Date\s+(sold|acquired)/i],
    ],
  },
  {
    type: "FORM_1099_R",
    irsForm: true,
    strong: [["form-1099-r", /\b1099-R\b/i]],
    supporting: [
      ["pension-distributions", /Distributions\s+From\s+Pensions/i],
      ["gross-distribution", /Gross\s+distribution/i],
      ["taxable-amount", /Taxable\s+amount/i],
      ["distribution-code", /Distribution\s+code/i],
    ],
  },
  {
    type: "FORM_1098",
    irsForm: true,
    strong: [["form-1098", /\bForm\s*1098\b(?!-)/i]],
    supporting: [
      ["mortgage-interest-statement", /Mortgage\s+Interest\s+Statement/i],
      ["mortgage-interest-received", /Mortgage\s+interest\s+received/i],
      ["outstanding-principal", /Outstanding\s+mortgage\s+principal/i],
    ],
  },
  {
    type: "FORM_1098_T",
    irsForm: true,
    strong: [["form-1098-t", /\b1098-T\b/i]],
    supporting: [
      ["tuition-statement", /Tuition\s+Statement/i],
      ["payments-received", /Payments\s+received\s+for\s+qualified\s+tuition/i],
      ["scholarships", /Scholarships\s+or\s+grants/i],
    ],
  },
  {
    type: "FORM_1095_A",
    irsForm: true,
    strong: [["form-1095-a", /\b1095-A\b/i]],
    supporting: [
      ["marketplace-statement", /Health\s+Insurance\s+Marketplace\s+Statement/i],
      ["enrollment-premiums", /Monthly\s+enrollment\s+premiums/i],
      ["slcsp", /Second\s+lowest\s+cost\s+silver\s+plan/i],
    ],
  },
  {
    type: "PAY_STUB",
    irsForm: false,
    strong: [["earnings-statement", /\b(Earnings\s+Statement|Pay\s+Stub|Pay\s+Statement|Payslip)\b/i]],
    supporting: [
      ["net-pay", /\bNet\s+Pay\b/i],
      ["gross-pay", /\bGross\s+Pay\b/i],
      ["year-to-date", /\bYTD\b|Year[-\s]to[-\s]Date/i],
      ["pay-period", /\bPay\s+(Period|Date)\b/i],
    ],
  },
  {
    type: "BANK_STATEMENT",
    irsForm: false,
    strong: [
      ["account-statement", /\b(Account|Bank|Checking|Savings)\s+Statement\b/i],
      ["statement-period", /\bStatement\s+Period\b/i],
    ],
    supporting: [
      ["opening-balance", /\b(Beginning|Opening|Previous)\s+Balance\b/i],
      ["closing-balance", /\b(Ending|Closing|New)\s+Balance\b/i],
      ["deposits", /\bDeposits\b/i],
      ["withdrawals", /\bWithdrawals\b/i],
    ],
  },
  {
    type: "INVOICE",
    irsForm: false,
    strong: [["invoice", /\bInvoice\b/i]],
    supporting: [
      ["invoice-number", /\bInvoice\s*(Number|No\.?|#)/i],
      ["bill-to", /\bBill\s+To\b/i],
      ["due-date", /\bDue\s+Date\b/i],
      ["amount-due", /\b(Amount|Balance)\s+Due\b/i],
      ["subtotal", /\bSubtotal\b/i],
    ],
  },
  {
    type: "RECEIPT",
    irsForm: false,
    strong: [["receipt", /\bReceipt\b/i]],
    supporting: [
      ["subtotal", /\bSubtotal\b/i],
      ["total", /\bTotal\b/i],
      ["change", /\bChange\s+(Due)?\b/i],
      ["tender", /\b(Visa|Mastercard|Amex|American\s+Express|Discover|Cash|Debit)\b/i],
      ["thank-you", /\bThank\s+you\b/i],
    ],
  },
];

interface Scored {
  type: SignalSet["type"];
  irsForm: boolean;
  strong: string[];
  supporting: string[];
  score: number;
}

function confidenceOf(scored: Scored): ClassificationConfidence {
  const strong = scored.strong.length;
  const supporting = scored.supporting.length;
  if (strong >= 1 && supporting >= 2) return "HIGH";
  if (strong >= 1 && supporting >= 1) return "MEDIUM";
  if (strong >= 1) return "LOW";
  if (!scored.irsForm && supporting >= 2) return "LOW";
  return "NONE";
}

/** Formatted amounts anywhere in the text — the evidence that an unrecognised
 *  document is at least financial. */
function countFormattedAmounts(text: string): number {
  return (text.match(/(?<![\w.])\$?\d{1,3}(?:,\d{3})*\.\d{2}(?!\d)/g) ?? []).length;
}

export function classifyDocument(pagesText: readonly string[]): Classification {
  const text = pagesText.join("\n");
  if (text.trim().length === 0) {
    return { documentType: "UNKNOWN", confidence: "NONE", method: "NO_TEXT", signals: [], reviewRequired: true, reviewReason: "No text could be read, so the type is not known." };
  }

  const scored: Scored[] = SIGNALS.map((set) => {
    const strong = set.strong.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
    const supporting = set.supporting.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
    return { type: set.type, irsForm: set.irsForm, strong, supporting, score: strong.length * 3 + supporting.length };
  })
    .filter((candidate) => confidenceOf(candidate) !== "NONE")
    .sort((a, b) => b.score - a.score || a.type.localeCompare(b.type));

  if (scored.length === 0) {
    if (countFormattedAmounts(text) >= 3) {
      return {
        documentType: "OTHER_FINANCIAL",
        confidence: "LOW",
        method: "CONTENT_SIGNALS",
        signals: ["formatted-amounts"],
        reviewRequired: true,
        reviewReason: "The document contains amounts but doesn't match any supported type.",
      };
    }
    return { documentType: "UNKNOWN", confidence: "NONE", method: "CONTENT_SIGNALS", signals: [], reviewRequired: true, reviewReason: "The document doesn't match any supported type." };
  }

  const [best, runnerUp] = scored;
  if (runnerUp && runnerUp.score >= best.score - 1) {
    return {
      documentType: "UNKNOWN",
      confidence: "NONE",
      method: "CONTENT_SIGNALS",
      signals: [...best.strong, ...best.supporting, ...runnerUp.strong, ...runnerUp.supporting].map((id) => `ambiguous:${id}`),
      reviewRequired: true,
      reviewReason: `The document matches both ${best.type} and ${runnerUp.type}, so no type was chosen.`,
    };
  }

  const confidence = confidenceOf(best);
  return {
    documentType: best.type,
    confidence,
    method: "CONTENT_SIGNALS",
    signals: [...best.strong, ...best.supporting],
    reviewRequired: confidence !== "HIGH",
    reviewReason: confidence === "HIGH" ? null : "Only some of this document type's markings were found, so the type needs review.",
  };
}
