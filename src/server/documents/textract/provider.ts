import "server-only";
import { AnalyzeExpenseCommand, AnalyzeIDCommand, DetectDocumentTextCommand, type Block, type ExpenseField } from "@aws-sdk/client-textract";
import type { VerifiedMimeType } from "@/domain/documents/file-signature";
import { MAX_LINES_PER_PAGE, MAX_LINE_LENGTH, type ProviderFailureCategory, type ProviderPage, type ProviderResult, type StructuredCapableProvider, type StructuredExtractionInput, type StructuredKind, type TextExtractionInput } from "@/domain/documents/intelligence/provider";
import type { ExtractionWarning, SourcePosition } from "@/domain/documents/intelligence/types";
import { classifyTextractError, textractClient, TEXTRACT_MAX_BYTES } from "./client";

/**
 * AMAZON TEXTRACT, as a Countorra reader.
 *
 * WHICH OPERATION, AND WHY EACH
 *
 *   DetectDocumentText  every document, first. It is the cheapest operation
 *                       and it is what produces the text that CLASSIFIES the
 *                       document, which is what decides whether a second,
 *                       dearer call is worth making at all.
 *   AnalyzeExpense      receipts, invoices, bills. Purpose-built: returns
 *                       merchant, dates, subtotal/tax/total and line items
 *                       already identified, with per-field confidence.
 *   AnalyzeID           US driver's licences and US passports, which are the
 *                       only documents AWS supports here. Most of what it
 *                       returns is discarded before storage
 *                       (domain/documents/intelligence/identity.ts).
 *
 * SYNCHRONOUS ONLY, AND WHAT THAT COSTS
 *
 * The bytes go in the request body. That is the whole reason this integration
 * needs no S3 bucket, no bucket policy and no s3:GetObject grant — the
 * document never leaves Supabase Storage for a second store, and the IAM
 * policy is three Textract actions.
 *
 * The price of that is AWS's synchronous limits, which are hard: 10 MB, and
 * ONE page of a PDF. Both are declared honestly rather than worked around —
 * an oversized file and a multi-page scan come back with a warning saying
 * exactly what was and was not read. Multi-page scanned PDFs would need the
 * async API and therefore a bucket; that is a deployment decision nobody has
 * made, so it is reported, not invented.
 *
 * WEBP IS NOT SUPPORTED. Textract accepts JPEG, PNG, PDF and TIFF. The
 * product accepts WEBP uploads, so `supports` excludes it and such a file
 * resolves to "no reader configured" — the honest answer, rather than a call
 * that would fail at AWS with an opaque error.
 *
 * NOTHING FROM AWS REACHES A LOG OR A USER. Errors are mapped to a category
 * in ./client.ts; the SDK's message, which can carry a request id and
 * occasionally document text, is dropped at the boundary.
 */

export const TEXTRACT_PROVIDER_ID = "amazon-textract";
export const TEXTRACT_PROVIDER_VERSION = "2026.1";

/** Textract's formats, intersected with what this product stores. */
const SUPPORTED: readonly VerifiedMimeType[] = ["application/pdf", "image/png", "image/jpeg"];

/** Below this, the page was read badly enough to say so. Textract reports
 *  per-word confidence; this is the mean over the lines it returned. */
export const LOW_CONFIDENCE_THRESHOLD = 0.8;

export class TextractProvider implements StructuredCapableProvider {
  readonly id = TEXTRACT_PROVIDER_ID;
  readonly version = TEXTRACT_PROVIDER_VERSION;
  readonly method = "OCR" as const;

  supports(mimeType: VerifiedMimeType): boolean {
    return SUPPORTED.includes(mimeType);
  }

  structuredKinds(): readonly StructuredKind[] {
    return ["EXPENSE", "IDENTITY"];
  }

  /**
   * The only place an AWS error name is understood.
   *
   * Everything above this line deals in Countorra's categories, so an AWS SDK
   * type never reaches the domain, a log line or a person. The error object
   * itself is not returned — only the category — because it can carry a
   * request id, an ARN, an account id or a fragment of the document.
   */
  classifyError(error: unknown): ProviderFailureCategory {
    switch (classifyTextractError(error)) {
      case "AUTH":
        return "PROVIDER_AUTH_ERROR";
      case "THROTTLED":
        return "PROVIDER_THROTTLED";
      case "SERVICE":
        return "PROVIDER_UNAVAILABLE";
      case "UNSUPPORTED":
        return "UNSUPPORTED_DOCUMENT";
      case "TOO_LARGE":
        return "DOCUMENT_TOO_LARGE";
      case "BAD_DOCUMENT":
        // Textract reached the file and could not make it out: a blurred
        // photo, a page of noise. The person can act on that, so it is kept
        // distinct from a format it refuses outright.
        return "DOCUMENT_UNREADABLE";
      default:
        return "PROVIDER_ERROR";
    }
  }

  async extractText(input: TextExtractionInput): Promise<unknown> {
    const tooLarge = this.refuseOversized(input.bytes);
    if (tooLarge) return tooLarge;

    const response = await textractClient().send(new DetectDocumentTextCommand({ Document: { Bytes: input.bytes } }), { abortSignal: input.signal });

    const lines = (response.Blocks ?? []).filter((block) => block.BlockType === "LINE");
    const pages = groupIntoPages(lines);
    const warnings: ExtractionWarning[] = [];

    // DocumentMetadata.Pages is what the document HAS; sync read one of them.
    const pageCount = response.DocumentMetadata?.Pages ?? pages.length;
    if (pageCount > 1) warnings.push("OCR_PAGE_LIMIT");
    if (pages.length === 0) warnings.push("NO_TEXT_LAYER");

    const mean = meanConfidence(lines);
    if (mean !== null && mean < LOW_CONFIDENCE_THRESHOLD) warnings.push("OCR_LOW_CONFIDENCE");

    return {
      provider: this.id,
      providerVersion: this.version,
      method: this.method,
      pageCount,
      pages,
      warnings,
    } satisfies ProviderResult;
  }

  async extractStructured(input: StructuredExtractionInput): Promise<unknown> {
    if (input.bytes.byteLength > TEXTRACT_MAX_BYTES) throw new Error("document exceeds the synchronous limit");

    if (input.kind === "EXPENSE") {
      const response = await textractClient().send(new AnalyzeExpenseCommand({ Document: { Bytes: input.bytes } }), { abortSignal: input.signal });
      // One expense document per file. A multi-receipt scan is not a case the
      // product has, and picking one of several would be a guess.
      const expense = response.ExpenseDocuments?.[0];
      return {
        summaryFields: (expense?.SummaryFields ?? []).map(mapExpenseField),
        lineItems: (expense?.LineItemGroups ?? []).flatMap((group) => (group.LineItems ?? []).map((item) => ({ fields: (item.LineItemExpenseFields ?? []).map(mapExpenseField) }))),
      };
    }

    const response = await textractClient().send(new AnalyzeIDCommand({ DocumentPages: [{ Bytes: input.bytes }] }), { abortSignal: input.signal });
    const document = response.IdentityDocuments?.[0];
    return {
      fields: (document?.IdentityDocumentFields ?? []).map((field) => ({
        type: field.Type?.Text ?? null,
        value: field.ValueDetection
          ? {
              text: field.ValueDetection.Text ?? null,
              confidence: ratio(field.ValueDetection.Confidence),
              normalizedValue: field.ValueDetection.NormalizedValue?.Value ?? null,
            }
          : null,
      })),
    };
  }

  /**
   * A file over the synchronous ceiling is a result, not an error: the
   * document is stored and valid, and the honest outcome is "too large to
   * read", recorded where the person can see it.
   */
  private refuseOversized(bytes: Uint8Array): ProviderResult | null {
    if (bytes.byteLength <= TEXTRACT_MAX_BYTES) return null;
    return {
      provider: this.id,
      providerVersion: this.version,
      method: this.method,
      pageCount: 0,
      pages: [],
      warnings: ["OCR_FILE_TOO_LARGE"],
    };
  }
}

/** Textract reports confidence as 0–100; everything downstream uses 0–1. */
function ratio(confidence: number | undefined): number | null {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  return Math.min(1, Math.max(0, confidence / 100));
}

function mapExpenseField(field: ExpenseField) {
  return {
    type: field.Type?.Text ?? null,
    label: field.LabelDetection ? { text: field.LabelDetection.Text ?? null, confidence: ratio(field.LabelDetection.Confidence) } : null,
    value: field.ValueDetection ? { text: field.ValueDetection.Text ?? null, confidence: ratio(field.ValueDetection.Confidence) } : null,
    currency: field.Currency?.Code ?? null,
    pageNumber: typeof field.PageNumber === "number" ? field.PageNumber : null,
  };
}

/**
 * Textract's bounding box is a ratio of the page, not a coordinate, so it is
 * recorded with `units: "ratio"` rather than converted into points against a
 * page size the response does not state.
 */
function positionOf(block: Block): SourcePosition | null {
  const box = block.Geometry?.BoundingBox;
  if (!box || typeof box.Left !== "number" || typeof box.Top !== "number") return null;
  return {
    x: box.Left,
    y: box.Top,
    width: typeof box.Width === "number" ? box.Width : null,
    height: typeof box.Height === "number" ? box.Height : null,
    units: "ratio",
  };
}

function groupIntoPages(lines: readonly Block[]): ProviderPage[] {
  const byPage = new Map<number, ProviderPage>();
  for (const block of lines) {
    const text = (block.Text ?? "").slice(0, MAX_LINE_LENGTH);
    if (!text.trim()) continue;
    const pageNumber = typeof block.Page === "number" && block.Page >= 1 ? block.Page : 1;
    let page = byPage.get(pageNumber);
    if (!page) {
      page = { pageNumber, lines: [] };
      byPage.set(pageNumber, page);
    }
    if (page.lines.length >= MAX_LINES_PER_PAGE) continue;
    page.lines.push({ text, position: positionOf(block), confidence: ratio(block.Confidence) });
  }
  return [...byPage.values()].sort((a, b) => a.pageNumber - b.pageNumber);
}

function meanConfidence(lines: readonly Block[]): number | null {
  const values = lines.map((line) => ratio(line.Confidence)).filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export { classifyTextractError };
