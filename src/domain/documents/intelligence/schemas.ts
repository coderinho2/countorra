import type { TaxFactKey } from "@/domain/tax-preparation/types";
import type { DateConvention } from "./normalization";
import type { DocumentType, FieldReviewState, FieldSection, FieldValueKind } from "./types";

/**
 * TYPED EXTRACTION SCHEMAS — what is read from each kind of document.
 *
 * Declared as data so every field has one definition: its label on the form,
 * its box, what kind of value it holds, whether the document is incomplete
 * without it, and — for a small, deliberately conservative set — which Tax
 * preparation fact it may be PROPOSED as.
 *
 * WHAT IS NOT HERE
 *
 * Identifiers are never extracted as values. An SSN, EIN or account number is
 * a PRESENCE field: the stored result says one is printed, and at most its
 * last four digits (never any digit of an SSN or ITIN).
 *
 * FACT MAPPINGS ARE THE NARROW PART
 *
 * A mapping is added only where the form box and the fact mean the same thing.
 * 1099-NEC box 1 is gross nonemployee compensation, and the only related fact
 * — self-employment NET profit — needs expenses no form carries, so it is not
 * mapped. 1099-MISC rents and royalties are gross amounts and not mapped
 * either. Anything unmapped is still extracted, shown and explainable; it just
 * cannot become a proposal automatically.
 */

export type ValueStrategy =
  /** The value follows the label on its line, or sits in the same column on
   *  the line below. */
  | "LABELLED"
  /** The first line of the first page — a letterhead. Always low confidence. */
  | "FIRST_LINE"
  /** Rows with a date and an amount (bank transactions) or a description and
   *  an amount (invoice lines). Always low confidence. */
  | "ROWS"
  /** W-2 box 12: "12a D 1,500.00". */
  | "BOX_12";

export interface FieldDefinition {
  key: string;
  label: string;
  box: string | null;
  section: FieldSection;
  kind: FieldValueKind;
  strategy: ValueStrategy;
  /** Patterns for the printed label. The first match on a line wins. */
  labels?: readonly RegExp[];
  /** When several amounts share one label (a table row), which one. */
  column?: number;
  /** For PRESENCE: an identifier token, or any text at all. */
  presence?: "IDENTIFIER" | "TEXT";
  /** For CODE: what a valid code looks like. */
  codePattern?: RegExp;
  /** For DATE: how numeric dates are written. */
  dateConvention?: DateConvention;
  /** For ROWS and multi-date fields: which occurrence. */
  occurrence?: number;
  /** The document is incomplete without it. */
  required?: boolean;
  /** The best review state this field can ever receive — for layouts that
   *  vary too much between issuers to read with more certainty. */
  ceiling?: FieldReviewState;
  /** The Tax preparation fact it may be proposed as. */
  factKey?: TaxFactKey;
}

export interface DocumentSchema {
  /** Stored on every field, so a later schema change is visible in history. */
  id: string;
  documentType: DocumentType;
  /** "FORM_USD": a US federal information return, in dollars by definition.
   *  "DETECT": only a currency printed in the document counts. */
  currency: "FORM_USD" | "DETECT";
  /** Where the tax year is printed, for forms that have one. */
  taxYearTitle?: RegExp;
  /** Numeric dates on this document. */
  dateConvention: DateConvention;
  fields: readonly FieldDefinition[];
}

const US_STATE = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/;

const money = (key: string, label: string, box: string | null, section: FieldSection, labels: readonly RegExp[], extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  key,
  label,
  box,
  section,
  kind: "MONEY",
  strategy: "LABELLED",
  labels,
  ...extra,
});

const federalWithholding = (box: string) => money("federal_withholding", "Federal income tax withheld", box, "WITHHOLDING", [/Federal\s+income\s+tax\s+withheld/i]);

const payerName = (label = "Payer's name"): FieldDefinition => ({
  key: "payer_name",
  label,
  box: null,
  section: "PARTIES",
  kind: "TEXT",
  strategy: "LABELLED",
  labels: [/PAYER['’]?S\s+name(,\s*street\s+address[^\n]*)?/i],
  ceiling: "MEDIUM_CONFIDENCE",
});

const tinPresence = (key: string, label: string, pattern: RegExp): FieldDefinition => ({
  key,
  label,
  box: null,
  section: "PARTIES",
  kind: "PRESENCE",
  strategy: "LABELLED",
  labels: [pattern],
  presence: "IDENTIFIER",
});

export const DOCUMENT_SCHEMAS: Readonly<Partial<Record<DocumentType, DocumentSchema>>> = {
  W2: {
    id: "w2.2026.1",
    documentType: "W2",
    currency: "FORM_USD",
    taxYearTitle: /Form\s*W-?2|Wage\s+and\s+Tax\s+Statement/i,
    dateConvention: "MONTH_FIRST",
    fields: [
      tinPresence("employee_ssn_present", "Employee's SSN printed", /Employee['’]?s\s+social\s+security\s+number/i),
      tinPresence("employer_ein_present", "Employer's EIN printed", /Employer\s+identification\s+number(\s*\(EIN\))?/i),
      { key: "employer_name", label: "Employer", box: "c", section: "PARTIES", kind: "TEXT", strategy: "LABELLED", labels: [/Employer['’]?s\s+name,?\s*address,?\s*and\s+ZIP\s+code/i], ceiling: "MEDIUM_CONFIDENCE" },
      { key: "employee_name_present", label: "Employee's name printed", box: "e", section: "PARTIES", kind: "PRESENCE", strategy: "LABELLED", labels: [/Employee['’]?s\s+first\s+name(\s+and\s+initial)?/i], presence: "TEXT" },
      money("box1_wages", "Wages, tips, other compensation", "1", "INCOME", [/Wages,?\s*tips,?\s*other\s*comp(ensation)?\.?/i], { required: true, factKey: "W2_WAGES" }),
      money("box2_federal_withholding", "Federal income tax withheld", "2", "WITHHOLDING", [/Federal\s+income\s+tax\s+withheld/i], { required: true, factKey: "W2_FEDERAL_WITHHOLDING" }),
      money("box3_social_security_wages", "Social Security wages", "3", "INCOME", [/Social\s+security\s+wages/i], { required: true, factKey: "W2_SOCIAL_SECURITY_WAGES" }),
      money("box4_social_security_tax", "Social Security tax withheld", "4", "WITHHOLDING", [/Social\s+security\s+tax\s+withheld/i]),
      money("box5_medicare_wages", "Medicare wages and tips", "5", "INCOME", [/Medicare\s+wages\s+and\s+tips/i], { required: true, factKey: "W2_MEDICARE_WAGES" }),
      money("box6_medicare_tax", "Medicare tax withheld", "6", "WITHHOLDING", [/Medicare\s+tax\s+withheld/i]),
      { key: "box12", label: "Box 12 code and amount", box: "12", section: "INCOME", kind: "MONEY", strategy: "BOX_12", ceiling: "LOW_CONFIDENCE" },
      { key: "box14_other", label: "Box 14 (other)", box: "14", section: "INCOME", kind: "TEXT", strategy: "LABELLED", labels: [/\b14\s+Other\b/i], ceiling: "LOW_CONFIDENCE" },
      { key: "box15_state", label: "State", box: "15", section: "STATE", kind: "CODE", strategy: "LABELLED", labels: [/\b15\s+State\b/i], codePattern: US_STATE },
      money("box16_state_wages", "State wages, tips, etc.", "16", "STATE", [/State\s+wages,?\s*tips/i]),
      money("box17_state_income_tax", "State income tax", "17", "STATE", [/\bState\s+income\s+tax\b/i], { factKey: "W2_STATE_WITHHOLDING" }),
      money("box18_local_wages", "Local wages, tips, etc.", "18", "LOCAL", [/Local\s+wages,?\s*tips/i]),
      money("box19_local_income_tax", "Local income tax", "19", "LOCAL", [/\bLocal\s+income\s+tax\b/i]),
      { key: "box20_locality", label: "Locality name", box: "20", section: "LOCAL", kind: "TEXT", strategy: "LABELLED", labels: [/Locality\s+name/i], ceiling: "LOW_CONFIDENCE" },
    ],
  },

  FORM_1099_NEC: {
    id: "1099nec.2026.1",
    documentType: "FORM_1099_NEC",
    currency: "FORM_USD",
    taxYearTitle: /1099-NEC|Nonemployee\s+Compensation/i,
    dateConvention: "MONTH_FIRST",
    fields: [
      payerName(),
      tinPresence("payer_tin_present", "Payer's TIN printed", /PAYER['’]?S\s+TIN/i),
      tinPresence("recipient_tin_present", "Recipient's TIN printed", /RECIPIENT['’]?S\s+TIN/i),
      { key: "recipient_name_present", label: "Recipient's name printed", box: null, section: "PARTIES", kind: "PRESENCE", strategy: "LABELLED", labels: [/RECIPIENT['’]?S\s+name/i], presence: "TEXT" },
      money("box1_nonemployee_compensation", "Nonemployee compensation", "1", "INCOME", [/Nonemployee\s+compensation/i], { required: true }),
      federalWithholding("4"),
      money("box5_state_tax_withheld", "State tax withheld", "5", "STATE", [/State\s+tax\s+withheld/i]),
      { key: "box6_state", label: "State", box: "6", section: "STATE", kind: "CODE", strategy: "LABELLED", labels: [/State\s*\/\s*Payer['’]?s\s+state\s+no/i], codePattern: US_STATE },
      money("box7_state_income", "State income", "7", "STATE", [/\bState\s+income\b(?!\s+tax)/i]),
    ],
  },

  FORM_1099_MISC: {
    id: "1099misc.2026.1",
    documentType: "FORM_1099_MISC",
    currency: "FORM_USD",
    taxYearTitle: /1099-MISC|Miscellaneous\s+Information/i,
    dateConvention: "MONTH_FIRST",
    fields: [
      payerName(),
      tinPresence("recipient_tin_present", "Recipient's TIN printed", /RECIPIENT['’]?S\s+TIN/i),
      money("box1_rents", "Rents", "1", "INCOME", [/\b1\s+Rents\b|\bRents\b/i]),
      money("box2_royalties", "Royalties", "2", "INCOME", [/\bRoyalties\b/i]),
      money("box3_other_income", "Other income", "3", "INCOME", [/\bOther\s+income\b/i], { factKey: "OTHER_1099_INCOME" }),
      federalWithholding("4"),
    ],
  },

  FORM_1099_INT: {
    id: "1099int.2026.1",
    documentType: "FORM_1099_INT",
    currency: "FORM_USD",
    taxYearTitle: /1099-INT|Interest\s+Income/i,
    dateConvention: "MONTH_FIRST",
    fields: [
      payerName(),
      tinPresence("recipient_tin_present", "Recipient's TIN printed", /RECIPIENT['’]?S\s+TIN/i),
      money("box1_interest_income", "Interest income", "1", "INCOME", [/\b1\s+Interest\s+income\b|\bInterest\s+income\b/i], { required: true, factKey: "INTEREST_INCOME" }),
      money("box3_savings_bond_interest", "Interest on U.S. Savings Bonds and Treasury obligations", "3", "INCOME", [/Interest\s+on\s+U\.?\s?S\.?\s+Savings\s+Bonds/i]),
      federalWithholding("4"),
      money("box8_tax_exempt_interest", "Tax-exempt interest", "8", "INCOME", [/Tax-exempt\s+interest/i]),
    ],
  },

  FORM_1099_DIV: {
    id: "1099div.2026.1",
    documentType: "FORM_1099_DIV",
    currency: "FORM_USD",
    taxYearTitle: /1099-DIV|Dividends\s+and\s+Distributions/i,
    dateConvention: "MONTH_FIRST",
    fields: [
      payerName(),
      money("box1a_ordinary_dividends", "Total ordinary dividends", "1a", "INCOME", [/Total\s+ordinary\s+dividends/i], { required: true, factKey: "ORDINARY_DIVIDENDS" }),
      money("box1b_qualified_dividends", "Qualified dividends", "1b", "INCOME", [/Qualified\s+dividends/i], { factKey: "QUALIFIED_DIVIDENDS" }),
      money("box2a_capital_gain_distributions", "Total capital gain distributions", "2a", "INCOME", [/Total\s+capital\s+gain\s+distr/i]),
      federalWithholding("4"),
      money("box5_section_199a_dividends", "Section 199A dividends", "5", "INCOME", [/Section\s+199A\s+dividends/i]),
      money("box12_exempt_interest_dividends", "Exempt-interest dividends", "12", "INCOME", [/Exempt-interest\s+dividends/i]),
    ],
  },

  FORM_1099_B: {
    id: "1099b.2026.1",
    documentType: "FORM_1099_B",
    currency: "FORM_USD",
    taxYearTitle: /1099-B|Proceeds\s+From\s+Broker/i,
    dateConvention: "MONTH_FIRST",
    // Consolidated broker statements lay these out in many ways. Nothing on a
    // 1099-B is read above low confidence, and nothing is mapped.
    fields: [
      payerName("Broker"),
      money("box1d_proceeds", "Proceeds", "1d", "INCOME", [/\bProceeds\b(?!\s+From)/i], { ceiling: "LOW_CONFIDENCE" }),
      money("box1e_cost_basis", "Cost or other basis", "1e", "INCOME", [/Cost\s+or\s+other\s+basis/i], { ceiling: "LOW_CONFIDENCE" }),
      money("federal_withholding", "Federal income tax withheld", "4", "WITHHOLDING", [/Federal\s+income\s+tax\s+withheld/i], { ceiling: "LOW_CONFIDENCE" }),
    ],
  },

  FORM_1099_R: {
    id: "1099r.2026.1",
    documentType: "FORM_1099_R",
    currency: "FORM_USD",
    taxYearTitle: /1099-R|Distributions\s+From\s+Pensions/i,
    dateConvention: "MONTH_FIRST",
    fields: [
      payerName(),
      money("box1_gross_distribution", "Gross distribution", "1", "INCOME", [/Gross\s+distribution/i], { required: true }),
      money("box2a_taxable_amount", "Taxable amount", "2a", "INCOME", [/Taxable\s+amount(?!\s+not)/i], { factKey: "RETIREMENT_INCOME" }),
      federalWithholding("4"),
      { key: "box7_distribution_code", label: "Distribution code", box: "7", section: "INCOME", kind: "CODE", strategy: "LABELLED", labels: [/Distribution\s+code\(?s?\)?/i], codePattern: /\b([0-9A-HJ-NP-Z]{1,2})\b/ },
    ],
  },

  FORM_1098: {
    id: "1098.2026.1",
    documentType: "FORM_1098",
    currency: "FORM_USD",
    taxYearTitle: /Form\s*1098\b|Mortgage\s+Interest\s+Statement/i,
    dateConvention: "MONTH_FIRST",
    fields: [
      { key: "lender_name", label: "Lender", box: null, section: "PARTIES", kind: "TEXT", strategy: "LABELLED", labels: [/RECIPIENT['’]?S\s*\/\s*LENDER['’]?S\s+name/i], ceiling: "MEDIUM_CONFIDENCE" },
      money("box1_mortgage_interest", "Mortgage interest received", "1", "DEDUCTIONS", [/Mortgage\s+interest\s+received/i], { required: true, factKey: "MORTGAGE_INTEREST" }),
      money("box2_outstanding_principal", "Outstanding mortgage principal", "2", "DEDUCTIONS", [/Outstanding\s+mortgage\s+principal/i]),
      money("box5_mortgage_insurance_premiums", "Mortgage insurance premiums", "5", "DEDUCTIONS", [/Mortgage\s+insurance\s+premiums/i]),
    ],
  },

  FORM_1098_T: {
    id: "1098t.2026.1",
    documentType: "FORM_1098_T",
    currency: "FORM_USD",
    taxYearTitle: /1098-T|Tuition\s+Statement/i,
    dateConvention: "MONTH_FIRST",
    fields: [
      { key: "filer_name", label: "Institution", box: null, section: "PARTIES", kind: "TEXT", strategy: "LABELLED", labels: [/FILER['’]?S\s+name/i], ceiling: "MEDIUM_CONFIDENCE" },
      money("box1_payments_received", "Payments received for qualified tuition and related expenses", "1", "DEDUCTIONS", [/Payments\s+received\s+for\s+qualified\s+tuition/i], { required: true }),
      money("box5_scholarships", "Scholarships or grants", "5", "DEDUCTIONS", [/Scholarships\s+or\s+grants/i]),
    ],
  },

  FORM_1095_A: {
    id: "1095a.2026.1",
    documentType: "FORM_1095_A",
    currency: "FORM_USD",
    taxYearTitle: /1095-A|Health\s+Insurance\s+Marketplace\s+Statement/i,
    dateConvention: "MONTH_FIRST",
    fields: [
      tinPresence("policy_number_present", "Marketplace policy number printed", /Marketplace-assigned\s+policy\s+number/i),
      money("annual_enrollment_premiums", "Annual enrollment premiums (column A)", "33A", "TOTALS", [/Annual\s+Totals/i], { column: 0, ceiling: "MEDIUM_CONFIDENCE" }),
      money("annual_slcsp_premium", "Annual second lowest cost silver plan premium (column B)", "33B", "TOTALS", [/Annual\s+Totals/i], { column: 1, ceiling: "MEDIUM_CONFIDENCE" }),
      money("annual_advance_ptc", "Annual advance payment of premium tax credit (column C)", "33C", "TOTALS", [/Annual\s+Totals/i], { column: 2, ceiling: "MEDIUM_CONFIDENCE" }),
    ],
  },

  PAY_STUB: {
    id: "paystub.2026.1",
    documentType: "PAY_STUB",
    currency: "DETECT",
    dateConvention: "MONTH_FIRST",
    fields: [
      { key: "employer_name", label: "Employer", box: null, section: "PARTIES", kind: "TEXT", strategy: "FIRST_LINE", ceiling: "LOW_CONFIDENCE" },
      { key: "pay_date", label: "Pay date", box: null, section: "PERIOD", kind: "DATE", strategy: "LABELLED", labels: [/\b(Pay|Check)\s+Date\b/i], required: true },
      { key: "pay_period_start", label: "Pay period start", box: null, section: "PERIOD", kind: "DATE", strategy: "LABELLED", labels: [/\bPay\s+Period\b/i], occurrence: 0 },
      { key: "pay_period_end", label: "Pay period end", box: null, section: "PERIOD", kind: "DATE", strategy: "LABELLED", labels: [/\bPay\s+Period\b/i], occurrence: 1 },
      money("gross_pay_current", "Gross pay (this period)", null, "INCOME", [/\bGross\s+Pay\b/i], { column: 0, required: true, ceiling: "MEDIUM_CONFIDENCE" }),
      money("gross_pay_ytd", "Gross pay (year to date)", null, "INCOME", [/\bGross\s+Pay\b/i], { column: 1, ceiling: "LOW_CONFIDENCE" }),
      money("federal_withholding_ytd", "Federal income tax (year to date)", null, "WITHHOLDING", [/\bFederal\s+(Income\s+)?(Tax|Withholding)\b/i], { column: 1, ceiling: "LOW_CONFIDENCE" }),
      money("net_pay", "Net pay", null, "TOTALS", [/\bNet\s+Pay\b/i], { column: 0, ceiling: "MEDIUM_CONFIDENCE" }),
    ],
  },

  BANK_STATEMENT: {
    id: "bankstatement.2026.1",
    documentType: "BANK_STATEMENT",
    currency: "DETECT",
    dateConvention: "UNKNOWN",
    fields: [
      { key: "institution", label: "Institution", box: null, section: "PARTIES", kind: "TEXT", strategy: "FIRST_LINE", ceiling: "LOW_CONFIDENCE" },
      { key: "account_number_present", label: "Account number printed (last four only)", box: null, section: "PARTIES", kind: "PRESENCE", strategy: "LABELLED", labels: [/\bAccount\s*(Number|No\.?|#)/i], presence: "IDENTIFIER" },
      { key: "period_start", label: "Statement period start", box: null, section: "PERIOD", kind: "DATE", strategy: "LABELLED", labels: [/\b(Statement\s+Period|Period\s+Covered|For\s+the\s+period)\b/i], occurrence: 0, required: true },
      { key: "period_end", label: "Statement period end", box: null, section: "PERIOD", kind: "DATE", strategy: "LABELLED", labels: [/\b(Statement\s+Period|Period\s+Covered|For\s+the\s+period)\b/i], occurrence: 1, required: true },
      money("opening_balance", "Opening balance", null, "BALANCES", [/\b(Beginning|Opening|Previous)\s+Balance\b/i], { required: true }),
      money("closing_balance", "Closing balance", null, "BALANCES", [/\b(Ending|Closing|New)\s+Balance\b/i], { required: true }),
      { key: "transaction", label: "Transaction", box: null, section: "TRANSACTIONS", kind: "MONEY", strategy: "ROWS", ceiling: "LOW_CONFIDENCE" },
    ],
  },

  INVOICE: {
    id: "invoice.2026.1",
    documentType: "INVOICE",
    currency: "DETECT",
    dateConvention: "UNKNOWN",
    fields: [
      { key: "vendor", label: "From", box: null, section: "PARTIES", kind: "TEXT", strategy: "FIRST_LINE", ceiling: "LOW_CONFIDENCE" },
      { key: "customer", label: "Bill to", box: null, section: "PARTIES", kind: "TEXT", strategy: "LABELLED", labels: [/\bBill\s+To\b:?/i], ceiling: "MEDIUM_CONFIDENCE" },
      { key: "invoice_number", label: "Invoice number", box: null, section: "DOCUMENT", kind: "CODE", strategy: "LABELLED", labels: [/\bInvoice\s*(Number|No\.?|#)\s*:?/i], codePattern: /\b([A-Z0-9][A-Z0-9-]{0,29})\b/i, required: true },
      { key: "issue_date", label: "Issue date", box: null, section: "PERIOD", kind: "DATE", strategy: "LABELLED", labels: [/\b(Invoice|Issue)\s+Date\b/i] },
      { key: "due_date", label: "Due date", box: null, section: "PERIOD", kind: "DATE", strategy: "LABELLED", labels: [/\bDue\s+Date\b/i] },
      money("subtotal", "Subtotal", null, "TOTALS", [/\bSubtotal\b/i]),
      money("tax", "Tax", null, "TOTALS", [/\b(Sales\s+)?Tax\b(?!\s*(ID|Number|No))/i]),
      money("total", "Total", null, "TOTALS", [/\b(Total\s+Due|Amount\s+Due|Balance\s+Due|Total)\b/i], { required: true }),
      { key: "line_item", label: "Line item", box: null, section: "LINE_ITEMS", kind: "MONEY", strategy: "ROWS", ceiling: "LOW_CONFIDENCE" },
    ],
  },

  RECEIPT: {
    id: "receipt.2026.1",
    documentType: "RECEIPT",
    currency: "DETECT",
    dateConvention: "UNKNOWN",
    fields: [
      { key: "merchant", label: "Merchant", box: null, section: "PARTIES", kind: "TEXT", strategy: "FIRST_LINE", ceiling: "LOW_CONFIDENCE" },
      { key: "date", label: "Date", box: null, section: "PERIOD", kind: "DATE", strategy: "LABELLED", labels: [/\bDate\b/i] },
      money("subtotal", "Subtotal", null, "TOTALS", [/\bSubtotal\b/i]),
      money("tax", "Tax", null, "TOTALS", [/\b(Sales\s+)?Tax\b(?!\s*(ID|Number|No))/i]),
      money("total", "Total", null, "TOTALS", [/\bTotal\b/i], { required: true }),
      { key: "card_present", label: "Payment card (last four only)", box: null, section: "PARTIES", kind: "PRESENCE", strategy: "LABELLED", labels: [/\b(Visa|Mastercard|Amex|American\s+Express|Discover|Card)\b/i], presence: "IDENTIFIER" },
    ],
  },
};

export function schemaFor(documentType: DocumentType): DocumentSchema | null {
  return DOCUMENT_SCHEMAS[documentType] ?? null;
}

/** Every field that may be proposed to Tax preparation, by schema. */
export function factMappingFor(schemaId: string, fieldKey: string): TaxFactKey | null {
  for (const schema of Object.values(DOCUMENT_SCHEMAS)) {
    if (schema?.id !== schemaId) continue;
    return schema.fields.find((field) => field.key === fieldKey)?.factKey ?? null;
  }
  return null;
}

export function fieldDefinitionFor(schemaId: string, fieldKey: string): FieldDefinition | null {
  const baseKey = fieldKey.replace(/_\d+$/, "");
  for (const schema of Object.values(DOCUMENT_SCHEMAS)) {
    if (schema?.id !== schemaId) continue;
    return schema.fields.find((field) => field.key === fieldKey || field.key === baseKey) ?? null;
  }
  return null;
}
