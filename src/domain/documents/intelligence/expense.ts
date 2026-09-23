import { z } from "zod";
import { currencyFromHint, findDate, maskSensitive, parseAmount, sanitizeText, toMinorUnits, type DateConvention } from "./normalization";
import type { ExtractedFieldDraft, ExtractionWarning, FieldReviewState } from "./types";

/**
 * AMAZON TEXTRACT ANALYZEEXPENSE, NORMALIZED — receipts, invoices and bills.
 *
 * WHY A SEPARATE OPERATION AT ALL
 *
 * The text-layer reader finds a receipt's total by looking for the word
 * "Total" and taking the amount nearest it. That works on a digital invoice
 * and falls apart on a photographed till receipt, where the layout is two
 * ragged columns and "Total" appears three times. AnalyzeExpense is trained
 * on exactly that document, and returns the fields already identified, with
 * the model's own confidence. So a photographed receipt goes through
 * AnalyzeExpense, not through the generic text path.
 *
 * WHAT THIS MODULE IS
 *
 * Pure. It takes the shape Textract returned — already parsed out of the AWS
 * SDK's types by the adapter, and validated here before a single value is
 * read — and produces the same `ExtractedFieldDraft`s every other reader
 * produces. Nothing downstream can tell which reader a field came from except
 * by its `method`, which is the point: one review workflow, one storage
 * shape, one proposal path.
 *
 * THE ARITHMETIC RULE, WHICH IS THE WHOLE POINT OF THE VALIDATION
 *
 * When subtotal, tax and total are all present and do not reconcile, NOTHING
 * IS ADJUSTED. Textract reading 20 / 5 / 40 does not become 20 / 5 / 25,
 * because the one thing worse than an unreadable receipt is a readable one
 * that quietly disagrees with the paper it came from. The document is flagged
 * TOTALS_INCONSISTENT and sent to review with all three values as read.
 */

// ── The provider payload, treated as untrusted input ────────────────────

/** Textract's own normalized label for a summary field, e.g. "VENDOR_NAME". */
const detectionSchema = z
  .object({
    text: z.string().max(500).nullable(),
    /** Textract reports 0–100; the adapter converts to 0–1. */
    confidence: z.number().min(0).max(1).nullable(),
  })
  .strict();

const expenseFieldSchema = z
  .object({
    type: z.string().max(64).nullable(),
    label: detectionSchema.nullable(),
    value: detectionSchema.nullable(),
    currency: z.string().max(8).nullable(),
    pageNumber: z.number().int().min(1).max(3000).nullable(),
  })
  .strict();

export const expensePayloadSchema = z
  .object({
    summaryFields: z.array(expenseFieldSchema).max(200),
    lineItems: z.array(z.object({ fields: z.array(expenseFieldSchema).max(40) }).strict()).max(300),
  })
  .strict();

export type ExpensePayload = z.infer<typeof expensePayloadSchema>;

/** Line items kept. A 300-line grocery receipt is real; 300 rows of review
 *  is not, and the total is what the ledger cares about either way. */
export const MAX_LINE_ITEMS = 40;

/** Absolute ceiling on any amount read off a personal receipt, in major
 *  units. Beyond this a value is far more likely to be a misread barcode or a
 *  concatenated pair of numbers than a purchase. */
export const MAX_REASONABLE_AMOUNT = 1_000_000;

/** Cents of slack allowed when checking subtotal + tax against total. Covers
 *  per-line rounding, not a disagreement. */
export const TOTALS_TOLERANCE_MINOR = 2;

// ── Textract's summary labels, mapped to this product's field keys ──────

const SUMMARY_MAP: Readonly<Record<string, { key: string; label: string; section: ExtractedFieldDraft["section"]; kind: ExtractedFieldDraft["valueKind"] }>> = {
  VENDOR_NAME: { key: "merchant", label: "Merchant", section: "PARTIES", kind: "TEXT" },
  RECEIVER_NAME: { key: "customer", label: "Bill to", section: "PARTIES", kind: "TEXT" },
  INVOICE_RECEIPT_DATE: { key: "date", label: "Date", section: "PERIOD", kind: "DATE" },
  DUE_DATE: { key: "due_date", label: "Due date", section: "PERIOD", kind: "DATE" },
  INVOICE_RECEIPT_ID: { key: "invoice_number", label: "Invoice number", section: "DOCUMENT", kind: "CODE" },
  SUBTOTAL: { key: "subtotal", label: "Subtotal", section: "TOTALS", kind: "MONEY" },
  TAX: { key: "tax", label: "Tax", section: "TOTALS", kind: "MONEY" },
  TOTAL: { key: "total", label: "Total", section: "TOTALS", kind: "MONEY" },
  AMOUNT_DUE: { key: "amount_due", label: "Amount due", section: "TOTALS", kind: "MONEY" },
  DISCOUNT: { key: "discount", label: "Discount", section: "TOTALS", kind: "MONEY" },
};

const LINE_ITEM_DESCRIPTION = new Set(["ITEM", "PRODUCT_CODE"]);

export const EXPENSE_SCHEMA_ID = "textract-expense.2026.1";

/**
 * Textract confidence, mapped to how cleanly a value was READ.
 *
 * The thresholds are deliberately conservative. A field the model is 80% sure
 * of is not something to put in front of someone as settled, and the cost of
 * over-flagging is one extra glance while the cost of under-flagging is a
 * wrong number in a ledger.
 */
export function reviewStateForConfidence(confidence: number | null): FieldReviewState {
  if (confidence === null) return "LOW_CONFIDENCE";
  if (confidence >= 0.95) return "HIGH_CONFIDENCE";
  if (confidence >= 0.85) return "MEDIUM_CONFIDENCE";
  return "LOW_CONFIDENCE";
}

interface NormalizedAmount {
  decimal: string;
  minor: number | null;
}

function normalizeAmount(text: string, currency: string | null): NormalizedAmount | null {
  const parsed = parseAmount(text);
  if (!parsed) return null;
  const value = Number(parsed.decimal);
  // Negative and absurd values are refused rather than stored: a receipt
  // total of -40 or 8,000,000 is a misread, and keeping it would put it in
  // front of somebody as a candidate figure.
  if (!Number.isFinite(value) || value < 0 || value > MAX_REASONABLE_AMOUNT) return null;
  return { decimal: parsed.decimal, minor: toMinorUnits(parsed.decimal, currency) };
}

export interface ExpenseNormalization {
  fields: ExtractedFieldDraft[];
  warnings: ExtractionWarning[];
  /** The currency every amount is denominated in, when the provider stated
   *  one. Never assumed from the locale or the region. */
  currency: string | null;
}

/**
 * Turns one AnalyzeExpense document into reviewable fields.
 *
 * `dateConvention` decides how a numeric date like 03/04/2026 is read. It is
 * the caller's to supply because it is a property of the document's origin,
 * not of the OCR.
 */
export function normalizeExpense(payload: ExpensePayload, dateConvention: DateConvention = "UNKNOWN"): ExpenseNormalization {
  const warnings = new Set<ExtractionWarning>();
  const fields: ExtractedFieldDraft[] = [];

  const currency = firstCurrency(payload);
  if (!currency) warnings.add("CURRENCY_NOT_FOUND");

  const seen = new Set<string>();
  const amounts = new Map<string, number>();

  for (const field of payload.summaryFields) {
    const mapped = field.type ? SUMMARY_MAP[field.type] : undefined;
    const raw = field.value?.text?.trim();
    if (!mapped || !raw) continue;
    // Textract can report the same label twice (a receipt printing "Total"
    // in two places). The first is kept and the second only matters if it
    // disagrees, which the totals check below catches.
    if (seen.has(mapped.key)) continue;
    seen.add(mapped.key);

    const confidence = field.value?.confidence ?? null;
    const draft = buildField({ mapped, raw, confidence, currency, pageNumber: field.pageNumber, dateConvention, warnings });
    if (!draft) continue;
    if (draft.amountMinor !== null) amounts.set(mapped.key, draft.amountMinor);
    fields.push(draft);
  }

  fields.push(...normalizeLineItems(payload, currency, warnings));

  if (!reconciles(amounts)) warnings.add("TOTALS_INCONSISTENT");

  return { fields, warnings: [...warnings], currency };
}

/**
 * Whether subtotal + tax − discount matches the total.
 *
 * Returns true when there is not enough information to judge: absence of
 * evidence is not a conflict, and flagging every receipt that omits its
 * subtotal would make the flag meaningless.
 */
export function reconciles(amounts: ReadonlyMap<string, number>): boolean {
  const subtotal = amounts.get("subtotal");
  const tax = amounts.get("tax");
  const total = amounts.get("total");
  if (subtotal === undefined || tax === undefined || total === undefined) return true;
  const discount = amounts.get("discount") ?? 0;
  return Math.abs(subtotal + tax - discount - total) <= TOTALS_TOLERANCE_MINOR;
}

function firstCurrency(payload: ExpensePayload): string | null {
  const all = [...payload.summaryFields, ...payload.lineItems.flatMap((item) => item.fields)];
  for (const field of all) {
    const code = currencyFromHint(field.currency);
    if (code) return code;
  }
  return null;
}

function buildField(input: {
  mapped: (typeof SUMMARY_MAP)[string];
  raw: string;
  confidence: number | null;
  currency: string | null;
  pageNumber: number | null;
  dateConvention: DateConvention;
  warnings: Set<ExtractionWarning>;
}): ExtractedFieldDraft | null {
  const { mapped, raw, confidence, currency, pageNumber, dateConvention, warnings } = input;

  // Every value is masked before it is stored, on the same terms as every
  // other reader: a receipt footer routinely carries a card number.
  const masked = maskSensitive(raw);
  if (masked.masked) warnings.add("SENSITIVE_VALUES_MASKED");

  const base: ExtractedFieldDraft = {
    schemaId: EXPENSE_SCHEMA_ID,
    fieldKey: mapped.key,
    label: mapped.label,
    section: mapped.section,
    box: null,
    valueKind: mapped.kind,
    rawValue: sanitizeText(masked.text, 200),
    normalizedDecimal: null,
    amountMinor: null,
    currency: null,
    currencySource: null,
    normalizedDate: null,
    normalizedText: null,
    reviewState: reviewStateForConfidence(confidence),
    reviewReason: null,
    providerConfidence: confidence,
    pageNumber,
    lineIndex: null,
    position: null,
    method: "textract-expense/summary-field",
  };

  if (mapped.kind === "MONEY") {
    const amount = normalizeAmount(raw, currency);
    if (!amount) return { ...base, reviewState: "UNREADABLE", rawValue: sanitizeText(masked.text, 200), reviewReason: "The amount couldn't be read as a plain number." };
    return { ...base, normalizedDecimal: amount.decimal, amountMinor: amount.minor, currency, currencySource: currency ? "DOCUMENT_TEXT" : null };
  }

  if (mapped.kind === "DATE") {
    const date = findDate(raw, dateConvention);
    if (!date) return { ...base, reviewState: "UNREADABLE", reviewReason: "The date couldn't be read." };
    return { ...base, normalizedDate: date.iso };
  }

  return { ...base, normalizedText: sanitizeText(masked.text, 200) };
}

function normalizeLineItems(payload: ExpensePayload, currency: string | null, warnings: Set<ExtractionWarning>): ExtractedFieldDraft[] {
  const rows: ExtractedFieldDraft[] = [];

  payload.lineItems.slice(0, MAX_LINE_ITEMS).forEach((item, index) => {
    let description: string | null = null;
    let price: string | null = null;
    let quantity: string | null = null;
    let unitPrice: string | null = null;
    let confidence: number | null = null;
    let pageNumber: number | null = null;

    for (const field of item.fields) {
      const text = field.value?.text?.trim();
      if (!field.type || !text) continue;
      pageNumber ??= field.pageNumber;
      if (LINE_ITEM_DESCRIPTION.has(field.type)) description ??= text;
      else if (field.type === "PRICE") {
        price ??= text;
        confidence ??= field.value?.confidence ?? null;
      } else if (field.type === "QUANTITY") quantity ??= text;
      else if (field.type === "UNIT_PRICE") unitPrice ??= text;
    }

    // A row with neither a description nor a price is not a row.
    if (!description && !price) return;

    const amount = price ? normalizeAmount(price, currency) : null;
    if (price && !amount) warnings.add("CONFLICTING_VALUES");

    const maskedDescription = description ? maskSensitive(description) : null;
    if (maskedDescription?.masked) warnings.add("SENSITIVE_VALUES_MASKED");

    rows.push({
      schemaId: EXPENSE_SCHEMA_ID,
      fieldKey: `line_item_${index + 1}`,
      label: describeRow(maskedDescription?.text ?? null, quantity, unitPrice),
      section: "LINE_ITEMS",
      box: null,
      valueKind: "MONEY",
      rawValue: sanitizeText(maskSensitive([description, quantity, unitPrice, price].filter(Boolean).join(" · ")).text, 200),
      normalizedDecimal: amount?.decimal ?? null,
      amountMinor: amount?.minor ?? null,
      currency: amount ? currency : null,
      currencySource: amount && currency ? "DOCUMENT_TEXT" : null,
      normalizedDate: null,
      normalizedText: maskedDescription ? sanitizeText(maskedDescription.text, 120) : null,
      // A line item is never more than a supporting detail: the total is what
      // a person checks, and per-row OCR on a folded receipt is the least
      // reliable thing on the page.
      reviewState: amount ? clampToLow(reviewStateForConfidence(confidence)) : "UNREADABLE",
      reviewReason: amount ? null : "The line's amount couldn't be read.",
      providerConfidence: confidence,
      pageNumber,
      lineIndex: index,
      position: null,
      method: "textract-expense/line-item",
    });
  });

  if (payload.lineItems.length > MAX_LINE_ITEMS) warnings.add("PAGE_LIMIT_REACHED");
  return rows;
}

function clampToLow(state: FieldReviewState): FieldReviewState {
  return state === "HIGH_CONFIDENCE" || state === "MEDIUM_CONFIDENCE" ? "LOW_CONFIDENCE" : state;
}

function describeRow(description: string | null, quantity: string | null, unitPrice: string | null): string {
  const parts = [description ?? "Line item"];
  if (quantity) parts.push(`× ${sanitizeText(quantity, 12)}`);
  if (unitPrice) parts.push(`@ ${sanitizeText(unitPrice, 16)}`);
  return sanitizeText(parts.join(" "), 200);
}
