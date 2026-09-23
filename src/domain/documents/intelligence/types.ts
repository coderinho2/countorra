/**
 * DOCUMENT INTELLIGENCE — the vocabulary.
 *
 * WHAT THIS LAYER IS FOR
 *
 * Turning an uploaded file into structured, reviewable figures that keep a
 * complete trail back to the page they came from. It sits between the upload
 * lifecycle (`upload-lifecycle.ts`, which decides whether bytes are a document
 * at all) and Tax preparation (which decides what a person has confirmed).
 *
 * THE CONCEPTS, KEPT APART ON PURPOSE
 *
 *   Document         the verified upload                       documents
 *   Processing job   one request to read it, with attempts     document_processing_jobs
 *   Extraction       one immutable result of a completed run   document_extractions
 *   Extracted field  one value, raw and normalized, with       document_extracted_fields
 *                    its evidence (page, box, method, position)
 *   Proposed fact    a tax figure offered for review           tax_preparation_facts (PROPOSED)
 *   Confirmed fact   a figure a person accepted                tax_preparation_facts (CONFIRMED)
 *
 * EXTRACTED IS NOT CONFIRMED
 *
 * Nothing in this directory can make a value authoritative. A field's review
 * state describes how cleanly the value was READ — never whether it is right.
 * Only the existing Tax preparation review workflow turns a proposal into a
 * confirmed fact, and only a person can do that.
 */

/** Bumped when classification, extraction or normalization rules change. A
 *  document read under an older version can be read again; one read under the
 *  current version is not re-read (no duplicate extraction). */
export const PROCESSING_VERSION = "document-intelligence.2026.2";

// ── Processing jobs ─────────────────────────────────────────────────────

export type ProcessingJobStatus =
  /** Created; not yet started. */
  | "QUEUED"
  /** Claimed by a run. Holds a lease so a crashed run is recoverable. */
  | "PROCESSING"
  /** Classified with confidence, and every required field read cleanly. */
  | "SUCCEEDED"
  /** Classified, but some required fields are missing or unclear. */
  | "PARTIAL"
  /** Readable text, but the type is uncertain or values conflict. */
  | "REVIEW_REQUIRED"
  /** Nothing could be read with what is configured — a WEBP, which no
   *  reader accepts, or any image on a deployment with no OCR credentials.
   *  An honest outcome, not a failure. */
  | "UNSUPPORTED"
  /** The run itself failed. Retryable while attempts remain. */
  | "FAILED";

/** Statuses a completed run can record on an extraction. */
export type ExtractionStatus = Extract<ProcessingJobStatus, "SUCCEEDED" | "PARTIAL" | "REVIEW_REQUIRED" | "UNSUPPORTED">;

export const EXTRACTION_STATUSES: readonly ExtractionStatus[] = ["SUCCEEDED", "PARTIAL", "REVIEW_REQUIRED", "UNSUPPORTED"];

/**
 * Why a run failed.
 *
 * STABLE, INTERNAL, AND NOT THE PROVIDER'S VOCABULARY. Every category here is
 * one Countorra defines and stores; a vendor's own error name, message,
 * request id or ARN never reaches this type, a log line, or a person. The
 * adapter classifies its vendor's errors into these (see
 * `TextExtractionProvider.classifyError`), which is what keeps the domain
 * free of AWS.
 *
 * `PROVIDER_ERROR` is the unknown bucket — a failure the adapter could not
 * place. It is deliberately the residual rather than a removed category,
 * because rows written before the finer categories existed still carry it.
 */
export type FailureCategory =
  /** The stored file could not be fetched. Usually transient. */
  | "DOCUMENT_UNAVAILABLE"
  /** The stored bytes are not what they claim to be. */
  | "FILE_VALIDATION_FAILED"
  /** The reader rejected the file's format. */
  | "UNSUPPORTED_DOCUMENT"
  /** Past the reader's own size ceiling, which is lower than the upload one. */
  | "DOCUMENT_TOO_LARGE"
  /** The reader could not make out the document at all — a blurred photo. */
  | "DOCUMENT_UNREADABLE"
  /** The deployment's reader credentials were refused. An operator problem,
   *  never the person's, and never fixed by trying again. */
  | "PROVIDER_AUTH_ERROR"
  /** Rate limited by the reader. Transient by definition. */
  | "PROVIDER_THROTTLED"
  /** The reader is down or unreachable. */
  | "PROVIDER_UNAVAILABLE"
  /** An error the adapter could not classify. */
  | "PROVIDER_ERROR"
  | "PROVIDER_TIMEOUT"
  | "MALFORMED_PROVIDER_RESPONSE"
  | "LEASE_EXPIRED"
  | "INTERNAL_ERROR";

/**
 * What a person is told. Actionable where there is an action, honest where
 * there is not, and free of the reader's name in every case: "Textract" means
 * nothing to somebody photographing a receipt.
 */
export const FAILURE_MESSAGES: Readonly<Record<FailureCategory, string>> = {
  DOCUMENT_UNAVAILABLE: "The stored file couldn't be read. Try again in a moment.",
  FILE_VALIDATION_FAILED: "The stored file didn't pass validation, so it wasn't read.",
  UNSUPPORTED_DOCUMENT: "This file's format can't be read. Try a PDF, PNG or JPEG.",
  DOCUMENT_TOO_LARGE: "This file is too large to read. Reading works on files up to 10MB — try a smaller scan or a single page.",
  DOCUMENT_UNREADABLE: "Countorra couldn't make out this document. A clearer, flatter photo in better light usually works.",
  PROVIDER_AUTH_ERROR: "Document reading isn't available right now. Nothing is wrong with your file — this is being looked into.",
  PROVIDER_THROTTLED: "Document reading is busy right now. Try again in a minute.",
  PROVIDER_UNAVAILABLE: "Document reading is temporarily unavailable. Your file is stored; try again shortly.",
  PROVIDER_ERROR: "The reader failed on this file.",
  PROVIDER_TIMEOUT: "Reading this file took too long and was stopped. Try again, or try a smaller file.",
  MALFORMED_PROVIDER_RESPONSE: "The reader returned something that couldn't be verified, so nothing was recorded.",
  LEASE_EXPIRED: "A previous attempt stopped before finishing.",
  INTERNAL_ERROR: "Something went wrong while recording the result. Nothing was saved.",
};

/**
 * Whether trying again could plausibly produce a different result.
 *
 * This is a cost control as much as a UX one. Every retry of a document the
 * reader has already rejected is another billed call that will fail the same
 * way, so a permanent failure stops at one attempt instead of three. The
 * split is by cause, not by severity:
 *
 *   TRANSIENT  something outside the document — the network, a rate limit,
 *              a lease, the storage layer. Worth another attempt.
 *   PERMANENT  something about the document, the credentials or the contract.
 *              Identical input, identical outcome; retrying only costs money.
 */
export const PERMANENT_FAILURES: readonly FailureCategory[] = [
  "FILE_VALIDATION_FAILED",
  "UNSUPPORTED_DOCUMENT",
  "DOCUMENT_TOO_LARGE",
  "DOCUMENT_UNREADABLE",
  "MALFORMED_PROVIDER_RESPONSE",
  "PROVIDER_AUTH_ERROR",
];

export function isRetryableFailure(category: FailureCategory): boolean {
  return !PERMANENT_FAILURES.includes(category);
}

// ── Classification ──────────────────────────────────────────────────────

export type DocumentType =
  | "W2"
  | "FORM_1099_NEC"
  | "FORM_1099_MISC"
  | "FORM_1099_INT"
  | "FORM_1099_DIV"
  | "FORM_1099_B"
  | "FORM_1099_R"
  | "FORM_1098"
  | "FORM_1098_T"
  | "FORM_1095_A"
  | "PAY_STUB"
  | "BANK_STATEMENT"
  | "INVOICE"
  | "RECEIPT"
  | "BILL"
  | "OTHER_FINANCIAL"
  // Identity documents. Held to a different standard throughout: see
  // DOCUMENT_SENSITIVITY below and ./identity.ts.
  | "DRIVER_LICENSE"
  | "PASSPORT"
  | "SSN_DOCUMENT"
  | "GOVERNMENT_ID"
  | "UNKNOWN";

export const DOCUMENT_TYPES: readonly DocumentType[] = [
  "W2",
  "FORM_1099_NEC",
  "FORM_1099_MISC",
  "FORM_1099_INT",
  "FORM_1099_DIV",
  "FORM_1099_B",
  "FORM_1099_R",
  "FORM_1098",
  "FORM_1098_T",
  "FORM_1095_A",
  "PAY_STUB",
  "BANK_STATEMENT",
  "INVOICE",
  "RECEIPT",
  "BILL",
  "OTHER_FINANCIAL",
  "DRIVER_LICENSE",
  "PASSPORT",
  "SSN_DOCUMENT",
  "GOVERNMENT_ID",
  "UNKNOWN",
];

export const DOCUMENT_TYPE_LABELS: Readonly<Record<DocumentType, string>> = {
  W2: "Form W-2",
  FORM_1099_NEC: "Form 1099-NEC",
  FORM_1099_MISC: "Form 1099-MISC",
  FORM_1099_INT: "Form 1099-INT",
  FORM_1099_DIV: "Form 1099-DIV",
  FORM_1099_B: "Form 1099-B",
  FORM_1099_R: "Form 1099-R",
  FORM_1098: "Form 1098",
  FORM_1098_T: "Form 1098-T",
  FORM_1095_A: "Form 1095-A",
  PAY_STUB: "Pay stub",
  BANK_STATEMENT: "Bank statement",
  INVOICE: "Invoice",
  RECEIPT: "Receipt",
  BILL: "Bill",
  OTHER_FINANCIAL: "Other financial document",
  DRIVER_LICENSE: "Driver's licence",
  PASSPORT: "Passport",
  SSN_DOCUMENT: "Social Security document",
  GOVERNMENT_ID: "Government ID",
  UNKNOWN: "Unknown",
};

/**
 * WHAT CLASS OF HARM A DOCUMENT CARRIES — the switch that everything
 * stricter about identity documents hangs from.
 *
 * FINANCIAL documents describe money. Their worst case is an embarrassing or
 * incorrect figure, and the product already handles that with review states.
 *
 * IDENTITY documents carry government identifiers. Their worst case is
 * identity theft, which is permanent and not recoverable by editing a row. So
 * they are treated differently at every layer, not just at the UI:
 *
 *   - the identifier itself is NEVER persisted (./identity.ts)
 *   - no field of theirs is ever proposed into the ledger or a tax fact
 *   - the assistant is given the document's existence, never its fields
 *   - the review screen masks by default and has no reveal control
 *
 * A type not listed here is financial by default, which is the safe
 * direction: adding an identity type without adding it here is caught by
 * ./identity.test.ts, which pins the whole list.
 */
export type DocumentSensitivity = "FINANCIAL" | "IDENTITY";

const IDENTITY_TYPES: readonly DocumentType[] = ["DRIVER_LICENSE", "PASSPORT", "SSN_DOCUMENT", "GOVERNMENT_ID"];

export function documentSensitivity(documentType: DocumentType): DocumentSensitivity {
  return IDENTITY_TYPES.includes(documentType) ? "IDENTITY" : "FINANCIAL";
}

export function isIdentityDocument(documentType: DocumentType): boolean {
  return documentSensitivity(documentType) === "IDENTITY";
}

export type ClassificationConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

/** How the type was decided. Never the filename — see classification.ts. */
export type ClassificationMethod = "CONTENT_SIGNALS" | "NO_TEXT";

export interface Classification {
  documentType: DocumentType;
  confidence: ClassificationConfidence;
  method: ClassificationMethod;
  /** Ids of the content signals that matched, for evidence. */
  signals: readonly string[];
  /** True unless the type was established with high confidence. */
  reviewRequired: boolean;
  /** Why review is required, when it is. */
  reviewReason: string | null;
}

// ── Extracted fields ────────────────────────────────────────────────────

/**
 * How cleanly a value was READ. Not how likely it is to be correct, and never
 * a substitute for a person confirming it.
 */
export type FieldReviewState =
  /** The labelled value was on the same line as its label, parsed cleanly,
   *  in a document classified with high confidence. */
  | "HIGH_CONFIDENCE"
  /** Found by layout (the line below the label) or in a medium-confidence
   *  document. */
  | "MEDIUM_CONFIDENCE"
  /** Found, but the layout left room for doubt. */
  | "LOW_CONFIDENCE"
  /** The label was found; its value could not be parsed. No value is kept. */
  | "UNREADABLE"
  /** The label was not found. No value is invented. */
  | "MISSING"
  /** The same field was read with different values. None is chosen. */
  | "CONFLICT";

export const FIELD_REVIEW_STATES: readonly FieldReviewState[] = ["HIGH_CONFIDENCE", "MEDIUM_CONFIDENCE", "LOW_CONFIDENCE", "UNREADABLE", "MISSING", "CONFLICT"];

/** States whose value may be offered to Tax preparation as a proposal. */
export const PROPOSABLE_REVIEW_STATES: readonly FieldReviewState[] = ["HIGH_CONFIDENCE", "MEDIUM_CONFIDENCE", "LOW_CONFIDENCE"];

export type FieldValueKind =
  /** An amount. Normalized to a canonical decimal, and to minor units only
   *  when the currency is known. */
  | "MONEY"
  | "DATE"
  | "TAX_YEAR"
  | "TEXT"
  /** A short code, e.g. a W-2 box 12 code or a state abbreviation. */
  | "CODE"
  /** Whether an identifier is present. The identifier itself is never kept. */
  | "PRESENCE";

export type FieldSection =
  | "DOCUMENT"
  | "PARTIES"
  | "INCOME"
  | "WITHHOLDING"
  | "DEDUCTIONS"
  | "STATE"
  | "LOCAL"
  | "PERIOD"
  | "BALANCES"
  | "TOTALS"
  | "LINE_ITEMS"
  | "TRANSACTIONS"
  /** Identity-document fields. Never proposable, never sent to the model. */
  | "IDENTITY";

/** Where a currency came from. A currency is never assumed. */
export type CurrencySource =
  /** The form is a US federal information return, denominated in US dollars
   *  by definition. */
  | "FORM_DEFINITION"
  /** An ISO code or an unambiguous symbol appeared in the document. */
  | "DOCUMENT_TEXT";

/** A coordinate the provider actually reported. Units are the provider's. */
export interface SourcePosition {
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  units: "pdf_points" | "pixels" | "ratio";
}

export interface ExtractedFieldDraft {
  schemaId: string;
  fieldKey: string;
  label: string;
  section: FieldSection;
  /** The box or line on the form, when the schema knows one. */
  box: string | null;
  valueKind: FieldValueKind;
  /** What was read, masked of identifiers, at most 200 characters. Null when
   *  nothing was read. */
  rawValue: string | null;
  normalizedDecimal: string | null;
  amountMinor: number | null;
  currency: string | null;
  currencySource: CurrencySource | null;
  normalizedDate: string | null;
  normalizedText: string | null;
  reviewState: FieldReviewState;
  /** Why the state is what it is, in plain words. */
  reviewReason: string | null;
  /** Only when the provider reported one. Never computed. */
  providerConfidence: number | null;
  /** 1-based. Null when the value was not found. */
  pageNumber: number | null;
  lineIndex: number | null;
  position: SourcePosition | null;
  /** e.g. "pdf-text-layer/label-same-line". */
  method: string;
}

export interface ExtractionDraft {
  status: ExtractionStatus;
  classification: Classification;
  /** Null unless a tax year was printed in the document. */
  taxYear: number | null;
  fields: readonly ExtractedFieldDraft[];
  pageCount: number;
  textCharCount: number;
  textTruncated: boolean;
  warnings: readonly ExtractionWarning[];
}

export type ExtractionWarning =
  | "NO_TEXT_LAYER"
  | "ENCRYPTED_DOCUMENT"
  | "PAGE_LIMIT_REACHED"
  | "TEXT_LIMIT_REACHED"
  | "OCR_NOT_CONFIGURED"
  | "UNSUPPORTED_DOCUMENT_TYPE"
  | "TYPE_AMBIGUOUS"
  | "TAX_YEAR_NOT_FOUND"
  | "TAX_YEAR_AMBIGUOUS"
  | "CURRENCY_NOT_FOUND"
  | "MULTIPLE_STATE_ROWS"
  | "CONFLICTING_VALUES"
  | "SENSITIVE_VALUES_MASKED"
  | "UNSUPPORTED_FONT_ENCODING"
  | "IDENTITY_DOCUMENT"
  | "IDENTIFIERS_NOT_STORED"
  | "TOTALS_INCONSISTENT"
  | "OCR_LOW_CONFIDENCE"
  | "OCR_PAGE_LIMIT"
  | "OCR_FILE_TOO_LARGE";

export const EXTRACTION_WARNING_TEXT: Readonly<Record<ExtractionWarning, string>> = {
  NO_TEXT_LAYER: "This file has no readable text layer — it looks like a scan or photo.",
  ENCRYPTED_DOCUMENT: "This PDF is encrypted, so its text can't be read.",
  PAGE_LIMIT_REACHED: "Only the first pages were read; the rest were skipped.",
  TEXT_LIMIT_REACHED: "The text was longer than the reading limit and was cut off.",
  OCR_NOT_CONFIGURED: "Reading scans and photos needs an OCR provider, and none is configured.",
  UNSUPPORTED_DOCUMENT_TYPE: "Figures aren't extracted for this kind of document.",
  TYPE_AMBIGUOUS: "The document matched more than one type, so no type was chosen.",
  TAX_YEAR_NOT_FOUND: "No tax year is printed where one was expected. None was assumed.",
  TAX_YEAR_AMBIGUOUS: "More than one year appears where the tax year should be. None was chosen.",
  CURRENCY_NOT_FOUND: "No currency is stated, so amounts are kept as written without one.",
  MULTIPLE_STATE_ROWS: "More than one state appears. Only the first state row was read, and it needs review.",
  CONFLICTING_VALUES: "Some fields were read with different values in different places.",
  SENSITIVE_VALUES_MASKED: "Identifiers such as SSNs and account numbers were masked and not stored.",
  UNSUPPORTED_FONT_ENCODING: "Part of the text uses a font encoding that couldn't be decoded.",
  IDENTITY_DOCUMENT: "This looks like an identity document. It is kept private, never used to change your records, and never shared with the assistant.",
  IDENTIFIERS_NOT_STORED: "Any identity or account number on this document was read to check it is there, and deliberately not stored.",
  TOTALS_INCONSISTENT: "The subtotal, tax and total on this document don't add up, so none of them was adjusted. Check them before using any of them.",
  OCR_LOW_CONFIDENCE: "The image was hard to read, so the values need checking more carefully than usual.",
  OCR_PAGE_LIMIT: "Only the first page of this file was read by the image reader.",
  OCR_FILE_TOO_LARGE: "This file is too large for the image reader, so nothing was read from it.",
};
