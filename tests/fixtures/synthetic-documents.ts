import { buildTextPdf, type SyntheticLine } from "./synthetic-pdf";

/**
 * SYNTHETIC TAX AND FINANCIAL DOCUMENTS, as real PDFs.
 *
 * EVERYTHING HERE IS INVENTED. No real person, employer, address, Social
 * Security number, EIN, account number or taxpayer appears. The identifiers
 * are drawn from ranges that are never issued:
 *
 *   SSN   000-00-0000 — the SSA has never issued an area number of 000.
 *   EIN   00-0000000  — likewise never issued.
 *
 * They are SSN- and EIN-SHAPED on purpose: the pipeline masks identifiers
 * before storing anything, and a fixture that carried no identifier-shaped
 * text would test the masking against nothing.
 *
 * WHY REAL PDFs RATHER THAN LINES OF TEXT
 *
 * These build genuine PDF files through `./synthetic-pdf`, with text placed at
 * coordinates the way a form actually lays it out — box labels down the left,
 * amounts in a column, two boxes side by side across the page. The document
 * then goes through the SAME reader production uses, so the test exercises
 * line grouping, column separation and label matching rather than assuming
 * them. A fixture that handed the extractor a tidy array of strings would
 * prove only that the extractor can read what a test author already parsed.
 *
 * NO AWS IS INVOLVED. The local text-layer reader handles these end to end,
 * which is what keeps the document-to-tax suite deterministic and runnable
 * everywhere. Amazon Textract's own path is proven separately, against the
 * real service, in tests/textract-live.
 */

/** Never issued by the SSA. Shaped like an SSN so masking is exercised. */
export const SYNTHETIC_SSN = "000-00-0000";
/** Never issued by the IRS. */
export const SYNTHETIC_EIN = "00-0000000";

interface Column {
  x: number;
  text: string;
}

/**
 * One visual row, as a form prints it: several cells across the page.
 *
 * The gaps matter. The reader inserts a separator between two runs of text
 * only when the horizontal distance between them is wide enough to be a
 * column rather than a word space, so a fixture with cramped columns would
 * produce "84,500.002 Federal income tax withheld" — which is what a badly
 * laid-out form really does produce, and not what these fixtures are for.
 */
function row(y: number, columns: readonly Column[], size = 9): SyntheticLine[] {
  return columns.map((column) => ({ text: column.text, x: column.x, y, size }));
}

const money = (value: number): string => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── W-2 ─────────────────────────────────────────────────────────────────

export interface SyntheticW2 {
  taxYear: number;
  wages: number;
  federalWithholding: number;
  socialSecurityWages: number;
  medicareWages: number;
  /** Two-letter state code for box 15, or null to leave 15–17 off the form. */
  state: string | null;
  stateWages?: number;
  stateIncomeTax?: number;
  employer?: string;
}

/**
 * A Form W-2 as the IRS lays one out: title and year at the top, the party
 * boxes lettered a–f, then the numbered boxes in two columns.
 */
export function syntheticW2Pdf(input: SyntheticW2): Uint8Array {
  const employer = input.employer ?? "Northwind Trading LLC";
  const lines: SyntheticLine[] = [
    ...row(760, [
      { x: 60, text: "Form W-2" },
      { x: 175, text: "Wage and Tax Statement" },
      { x: 430, text: String(input.taxYear) },
    ], 12),
    ...row(742, [{ x: 60, text: "Department of the Treasury - Internal Revenue Service" }], 8),

    ...row(714, [
      { x: 60, text: "a  Employee's social security number" },
      { x: 300, text: SYNTHETIC_SSN },
    ]),
    ...row(696, [
      { x: 60, text: "b  Employer identification number (EIN)" },
      { x: 300, text: SYNTHETIC_EIN },
    ]),
    ...row(678, [
      { x: 60, text: "c  Employer's name, address, and ZIP code" },
      { x: 300, text: employer },
    ]),
    ...row(664, [{ x: 300, text: "4400 Example Parkway, Springfield, 00000" }]),
    ...row(640, [
      { x: 60, text: "e  Employee's first name and initial" },
      { x: 300, text: "Taylor R" },
      { x: 400, text: "Synthetic" },
    ]),

    ...row(600, [
      { x: 60, text: "1  Wages, tips, other compensation" },
      { x: 250, text: money(input.wages) },
      { x: 330, text: "2  Federal income tax withheld" },
      { x: 505, text: money(input.federalWithholding) },
    ]),
    ...row(578, [
      { x: 60, text: "3  Social security wages" },
      { x: 250, text: money(input.socialSecurityWages) },
      { x: 330, text: "4  Social security tax withheld" },
      { x: 505, text: money(round(input.socialSecurityWages * 0.062)) },
    ]),
    ...row(556, [
      { x: 60, text: "5  Medicare wages and tips" },
      { x: 250, text: money(input.medicareWages) },
      { x: 330, text: "6  Medicare tax withheld" },
      { x: 505, text: money(round(input.medicareWages * 0.0145)) },
    ]),
  ];

  if (input.state) {
    lines.push(
      ...row(520, [
        { x: 60, text: "15  State" },
        { x: 160, text: input.state },
        { x: 230, text: "16  State wages, tips, etc." },
        { x: 400, text: money(input.stateWages ?? input.wages) },
      ]),
      ...row(498, [
        { x: 60, text: "17  State income tax" },
        { x: 250, text: money(input.stateIncomeTax ?? 0) },
      ]),
    );
  }

  return buildTextPdf([lines]);
}

const round = (value: number) => Math.round(value * 100) / 100;

// ── 1099-NEC ────────────────────────────────────────────────────────────

export interface Synthetic1099Nec {
  taxYear: number;
  nonemployeeCompensation: number;
  federalWithholding?: number;
  payer?: string;
}

export function synthetic1099NecPdf(input: Synthetic1099Nec): Uint8Array {
  const lines: SyntheticLine[] = [
    ...row(760, [
      { x: 60, text: "Form 1099-NEC" },
      { x: 220, text: "Nonemployee Compensation" },
      { x: 450, text: String(input.taxYear) },
    ], 12),
    ...row(742, [{ x: 60, text: "Department of the Treasury - Internal Revenue Service" }], 8),

    ...row(710, [
      { x: 60, text: "PAYER'S name, street address, city or town" },
      { x: 320, text: input.payer ?? "Contoso Consulting Group" },
    ]),
    ...row(696, [{ x: 320, text: "88 Fictional Avenue, Springfield, 00000" }]),
    ...row(672, [
      { x: 60, text: "PAYER'S TIN" },
      { x: 250, text: SYNTHETIC_EIN },
      { x: 360, text: "RECIPIENT'S TIN" },
      { x: 505, text: SYNTHETIC_SSN },
    ]),
    ...row(650, [
      { x: 60, text: "RECIPIENT'S name" },
      { x: 250, text: "Taylor R Synthetic" },
    ]),
    ...row(610, [
      { x: 60, text: "1  Nonemployee compensation" },
      { x: 290, text: money(input.nonemployeeCompensation) },
    ]),
    ...row(588, [
      { x: 60, text: "4  Federal income tax withheld" },
      { x: 290, text: money(input.federalWithholding ?? 0) },
    ]),
  ];
  return buildTextPdf([lines]);
}

// ── 1099-INT ────────────────────────────────────────────────────────────

export interface Synthetic1099Int {
  taxYear: number;
  interestIncome: number;
  payer?: string;
}

export function synthetic1099IntPdf(input: Synthetic1099Int): Uint8Array {
  const lines: SyntheticLine[] = [
    ...row(760, [
      { x: 60, text: "Form 1099-INT" },
      { x: 220, text: "Interest Income" },
      { x: 430, text: String(input.taxYear) },
    ], 12),
    ...row(742, [{ x: 60, text: "Department of the Treasury - Internal Revenue Service" }], 8),
    ...row(710, [
      { x: 60, text: "PAYER'S name, street address, city or town" },
      { x: 320, text: input.payer ?? "Fabrikam Savings Bank" },
    ]),
    ...row(686, [
      { x: 60, text: "PAYER'S TIN" },
      { x: 250, text: SYNTHETIC_EIN },
      { x: 360, text: "RECIPIENT'S TIN" },
      { x: 505, text: SYNTHETIC_SSN },
    ]),
    ...row(650, [
      { x: 60, text: "1  Interest income" },
      { x: 290, text: money(input.interestIncome) },
    ]),
    ...row(628, [
      { x: 60, text: "4  Federal income tax withheld" },
      { x: 290, text: money(0) },
    ]),
  ];
  return buildTextPdf([lines]);
}

// ── Receipts ────────────────────────────────────────────────────────────

export interface SyntheticReceiptItem {
  description: string;
  amount: number;
}

export interface SyntheticReceipt {
  merchant: string;
  date: string;
  items: readonly SyntheticReceiptItem[];
  subtotal: number;
  tax: number;
  total: number;
  /** Printed above the total, for a refund. */
  note?: string;
}

/** A till receipt: merchant, date, items, subtotal, tax, total. */
export function syntheticReceiptPdf(input: SyntheticReceipt): Uint8Array {
  const lines: SyntheticLine[] = [
    ...row(760, [{ x: 60, text: input.merchant }], 13),
    ...row(744, [{ x: 60, text: "120 Invented Street, Springfield, 00000" }], 8),
    ...row(730, [{ x: 60, text: "Receipt" }], 9),
    ...row(712, [
      { x: 60, text: "Date" },
      { x: 200, text: input.date },
    ]),
  ];

  let y = 680;
  for (const item of input.items) {
    lines.push(...row(y, [
      { x: 60, text: item.description },
      { x: 320, text: money(item.amount) },
    ]));
    y -= 18;
  }

  y -= 14;
  if (input.note) {
    lines.push(...row(y, [{ x: 60, text: input.note }]));
    y -= 18;
  }
  lines.push(...row(y, [{ x: 60, text: "Subtotal" }, { x: 320, text: money(input.subtotal) }]));
  lines.push(...row(y - 18, [{ x: 60, text: "Sales Tax" }, { x: 320, text: money(input.tax) }]));
  lines.push(...row(y - 36, [{ x: 60, text: "Total" }, { x: 320, text: money(input.total) }], 11));

  return buildTextPdf([lines]);
}

// ── AnalyzeExpense payloads ─────────────────────────────────────────────

/**
 * What Amazon Textract's AnalyzeExpense returns for a receipt, in the shape
 * `TextractProvider.extractStructured` produces.
 *
 * Built here rather than read from AWS because the expense normalizer's job is
 * to decide what to do with a payload — including a self-inconsistent or
 * low-confidence one, which no real receipt can be relied on to produce on
 * demand. The adapter that turns AWS's own response INTO this shape is tested
 * against real AWS separately (tests/textract-live).
 */
export interface SyntheticExpensePayloadInput {
  merchant?: string;
  date?: string;
  subtotal?: number;
  tax?: number;
  total?: number;
  items?: readonly SyntheticReceiptItem[];
  /** 0–1. Applied to every field, so a whole-document low-confidence read can
   *  be expressed. */
  confidence?: number;
  currency?: string;
}

export function syntheticExpensePayload(input: SyntheticExpensePayloadInput = {}) {
  const confidence = input.confidence ?? 0.98;
  const currency = input.currency ?? "USD";
  const field = (type: string, text: string) => ({
    type,
    label: null,
    value: { text, confidence },
    currency,
    pageNumber: 1,
  });

  const summaryFields = [
    input.merchant !== undefined ? field("VENDOR_NAME", input.merchant) : null,
    input.date !== undefined ? field("INVOICE_RECEIPT_DATE", input.date) : null,
    input.subtotal !== undefined ? field("SUBTOTAL", money(input.subtotal)) : null,
    input.tax !== undefined ? field("TAX", money(input.tax)) : null,
    input.total !== undefined ? field("TOTAL", money(input.total)) : null,
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return {
    summaryFields,
    lineItems: (input.items ?? []).map((item) => ({
      fields: [field("ITEM", item.description), field("PRICE", money(item.amount))],
    })),
  };
}
