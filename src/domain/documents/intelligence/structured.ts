import { expensePayloadSchema, normalizeExpense } from "./expense";
import { identityPayloadSchema, normalizeIdentity } from "./identity";
import type { StructuredKind } from "./provider";
import { isIdentityDocument, type ExtractionDraft, type ExtractionStatus, type ExtractionWarning } from "./types";

/**
 * THE SECOND STAGE, FOLDED BACK INTO ONE EXTRACTION.
 *
 * The text stage has already classified the document and produced fields by
 * heuristic. When the class has a purpose-built operation, this replaces
 * those fields with the provider's own — better identified, and carrying the
 * provider's confidence rather than a guess about layout.
 *
 * REPLACE, NOT MERGE. Two readings of the same receipt produce two "total"
 * fields that a person then has to arbitrate between, which is worse than
 * either reading alone. The purpose-built result wins outright for the
 * sections it covers, and the text reading is discarded for those sections.
 *
 * THE PAYLOAD IS UNTRUSTED, again. It has crossed a network from a vendor and
 * is validated against the schema for its kind before a value is read; a
 * payload that does not conform leaves the text reading in place rather than
 * failing the document, because a worse reading is still a reading.
 */

export type StructuredApplication =
  | { applied: true; draft: ExtractionDraft }
  /** The payload was unusable. The caller keeps the text reading. */
  | { applied: false; reason: "MALFORMED" | "EMPTY" };

export function applyStructured(draft: ExtractionDraft, kind: StructuredKind, payload: unknown): StructuredApplication {
  return kind === "EXPENSE" ? applyExpense(draft, payload) : applyIdentity(draft, payload);
}

function applyExpense(draft: ExtractionDraft, payload: unknown): StructuredApplication {
  const parsed = expensePayloadSchema.safeParse(payload);
  if (!parsed.success) return { applied: false, reason: "MALFORMED" };

  const { fields, warnings } = normalizeExpense(parsed.data);
  if (fields.length === 0) return { applied: false, reason: "EMPTY" };

  const merged = mergeWarnings(draft.warnings, warnings);
  return {
    applied: true,
    draft: { ...draft, fields, warnings: merged, status: expenseStatus(fields, merged) },
  };
}

/**
 * An identity document's fields REPLACE everything the text stage read, and
 * that is a security property rather than a quality one.
 *
 * The text stage saw the whole document — the name, the address, the number —
 * and produced fields from it under the generic masking rules. Those rules
 * are good, but they were not written for a licence. The identity normalizer
 * was, and it keeps a fixed, tiny allowlist. So the generic fields are
 * dropped entirely rather than merged, and nothing the text stage happened to
 * pick up survives into storage.
 */
function applyIdentity(draft: ExtractionDraft, payload: unknown): StructuredApplication {
  const parsed = identityPayloadSchema.safeParse(payload);
  if (!parsed.success) return { applied: false, reason: "MALFORMED" };

  const { fields, warnings } = normalizeIdentity(parsed.data);
  const merged = mergeWarnings(draft.warnings, warnings);
  return {
    applied: true,
    // Always REVIEW_REQUIRED, even when every field was read cleanly. An
    // identity document has no "done" state in this product: there is nothing
    // it can go on to do, so the only honest status is one that asks a person
    // to look at what was kept.
    draft: { ...draft, fields, warnings: merged, status: "REVIEW_REQUIRED", taxYear: null },
  };
}

/**
 * The status a set of expense fields earns.
 *
 * Arithmetic that does not reconcile outranks everything else: a receipt
 * whose subtotal, tax and total disagree needs a person regardless of how
 * confidently each individual number was read.
 */
export function expenseStatus(fields: ExtractionDraft["fields"], warnings: readonly ExtractionWarning[]): ExtractionStatus {
  if (warnings.includes("TOTALS_INCONSISTENT")) return "REVIEW_REQUIRED";

  const total = fields.find((field) => field.fieldKey === "total" || field.fieldKey === "amount_due");
  if (!total || total.amountMinor === null) return "PARTIAL";
  if (total.reviewState === "LOW_CONFIDENCE" || total.reviewState === "UNREADABLE" || total.reviewState === "CONFLICT") return "REVIEW_REQUIRED";

  const unreadable = fields.filter((field) => field.reviewState === "UNREADABLE").length;
  return unreadable > 0 ? "PARTIAL" : "SUCCEEDED";
}

function mergeWarnings(existing: readonly ExtractionWarning[], added: readonly ExtractionWarning[]): ExtractionWarning[] {
  // The text stage's warnings about HOW the file was read (page limits, low
  // OCR confidence) still apply; its warnings about what it FOUND do not,
  // because those findings have just been replaced.
  const aboutTheRead: readonly ExtractionWarning[] = [
    "NO_TEXT_LAYER",
    "ENCRYPTED_DOCUMENT",
    "PAGE_LIMIT_REACHED",
    "TEXT_LIMIT_REACHED",
    "OCR_LOW_CONFIDENCE",
    "OCR_PAGE_LIMIT",
    "OCR_FILE_TOO_LARGE",
    "UNSUPPORTED_FONT_ENCODING",
  ];
  return [...new Set([...existing.filter((warning) => aboutTheRead.includes(warning)), ...added])];
}

/**
 * Whether a classified document may be sent to a second, billed operation.
 *
 * Two independent gates, both of which have to pass:
 *
 *   - the class must be one with a purpose-built operation
 *     (`structuredKindFor`), which the caller has already established
 *   - the classification must be better than a coin flip. Paying to run
 *     AnalyzeExpense on something classified UNKNOWN buys nothing, and
 *     running AnalyzeID on a document that merely mentions "passport" would
 *     send a document to an identity operation on the strength of one word.
 */
export function shouldRunStructured(draft: ExtractionDraft): boolean {
  if (draft.classification.documentType === "UNKNOWN") return false;
  if (isIdentityDocument(draft.classification.documentType)) {
    // Identity is held to the higher bar: a single weak signal is not enough
    // to hand a document to an identity reader.
    return draft.classification.confidence === "HIGH" || draft.classification.confidence === "MEDIUM";
  }
  return draft.classification.confidence !== "NONE";
}
