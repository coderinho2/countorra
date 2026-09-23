import { z } from "zod";
import type { VerifiedMimeType } from "@/domain/documents/file-signature";
import type { ExtractionWarning, FailureCategory, SourcePosition } from "./types";

/**
 * THE TEXT-EXTRACTION PROVIDER CONTRACT.
 *
 * Everything downstream — classification, extraction, normalization,
 * provenance — consumes a `ProviderResult` and nothing vendor-shaped. Adding a
 * real OCR provider later is one implementation of `TextExtractionProvider`;
 * the domain model, the tables and the review workflow do not change.
 *
 * A PROVIDER IS UNTRUSTED
 *
 * Its output is treated like any other external input: validated against the
 * schema below before a single value is used, bounded in size, and discarded
 * as MALFORMED_PROVIDER_RESPONSE if it does not conform. Coordinates and
 * confidence are kept only when the provider supplied them; neither is ever
 * computed to fill a gap.
 */

/** Pages read per document. Enough for a W-2 set or a monthly statement. */
export const MAX_PAGES = 30;
/** Lines kept per page. */
export const MAX_LINES_PER_PAGE = 1500;
/** Characters kept per line. */
export const MAX_LINE_LENGTH = 1000;
/** Characters kept per document, across all pages. */
export const MAX_TEXT_CHARS = 200_000;
/** A provider that has not answered by then is abandoned. */
export const PROVIDER_TIMEOUT_MS = 20_000;

export type ProviderMethod =
  /** Text that is part of a digital PDF. Deterministic, local, no network. */
  | "PDF_TEXT_LAYER"
  /** Optical character recognition of pixels. */
  | "OCR";

export interface ProviderLine {
  text: string;
  position: SourcePosition | null;
  /** 0–1, only when the provider reports one. */
  confidence: number | null;
}

export interface ProviderPage {
  pageNumber: number;
  lines: ProviderLine[];
}

export interface ProviderResult {
  provider: string;
  providerVersion: string;
  method: ProviderMethod;
  /** Pages in the document, which may exceed the pages returned. */
  pageCount: number;
  pages: ProviderPage[];
  warnings: ExtractionWarning[];
}

export interface TextExtractionInput {
  bytes: Uint8Array;
  mimeType: VerifiedMimeType;
  signal: AbortSignal;
}

export interface TextExtractionProvider {
  readonly id: string;
  readonly version: string;
  readonly method: ProviderMethod;
  supports(mimeType: VerifiedMimeType): boolean;
  /** Returns `unknown` on purpose: nothing is believed until validated. */
  extractText(input: TextExtractionInput): Promise<unknown>;
  /**
   * Places one of this provider's own errors into Countorra's vocabulary.
   *
   * THIS IS THE WHOLE REASON THE DOMAIN NEVER IMPORTS AN AWS TYPE. The runner
   * below catches a thrown error and asks the adapter what kind it was; the
   * adapter is the only code that knows what an `AccessDeniedException` is,
   * and the only thing that crosses back is a category from `FailureCategory`.
   * The error OBJECT is never returned, logged or rethrown, because it can
   * carry a request id, an ARN, an account id or a fragment of the document.
   *
   * Optional: a provider that does not implement it has every failure treated
   * as PROVIDER_ERROR, which is the safe residual.
   */
  classifyError?(error: unknown): ProviderFailureCategory;
}

/**
 * The failure categories a provider may report. A strict subset of
 * `FailureCategory` — timeouts and malformed responses are decided by the
 * runner, not by the provider, so they are not the provider's to return.
 */
export type ProviderFailureCategory = Extract<
  FailureCategory,
  "PROVIDER_AUTH_ERROR" | "PROVIDER_THROTTLED" | "PROVIDER_UNAVAILABLE" | "UNSUPPORTED_DOCUMENT" | "DOCUMENT_TOO_LARGE" | "DOCUMENT_UNREADABLE" | "PROVIDER_ERROR"
>;

const positionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative().nullable(),
    height: z.number().finite().nonnegative().nullable(),
    units: z.enum(["pdf_points", "pixels", "ratio"]),
  })
  .strict();

const warningSchema = z.enum([
  "NO_TEXT_LAYER",
  "ENCRYPTED_DOCUMENT",
  "PAGE_LIMIT_REACHED",
  "TEXT_LIMIT_REACHED",
  "OCR_NOT_CONFIGURED",
  "UNSUPPORTED_DOCUMENT_TYPE",
  "TYPE_AMBIGUOUS",
  "TAX_YEAR_NOT_FOUND",
  "TAX_YEAR_AMBIGUOUS",
  "CURRENCY_NOT_FOUND",
  "MULTIPLE_STATE_ROWS",
  "CONFLICTING_VALUES",
  "SENSITIVE_VALUES_MASKED",
  "UNSUPPORTED_FONT_ENCODING",
  "IDENTITY_DOCUMENT",
  "IDENTIFIERS_NOT_STORED",
  "TOTALS_INCONSISTENT",
  "OCR_LOW_CONFIDENCE",
  "OCR_PAGE_LIMIT",
  "OCR_FILE_TOO_LARGE",
]);

export const providerResultSchema = z
  .object({
    provider: z.string().min(1).max(64),
    providerVersion: z.string().min(1).max(32),
    method: z.enum(["PDF_TEXT_LAYER", "OCR"]),
    pageCount: z.number().int().min(0).max(100_000),
    pages: z
      .array(
        z
          .object({
            pageNumber: z.number().int().min(1),
            lines: z
              .array(
                z
                  .object({
                    text: z.string().max(MAX_LINE_LENGTH),
                    position: positionSchema.nullable(),
                    confidence: z.number().min(0).max(1).nullable(),
                  })
                  .strict(),
              )
              .max(MAX_LINES_PER_PAGE),
          })
          .strict(),
      )
      .max(MAX_PAGES),
    warnings: z.array(warningSchema).max(20),
  })
  .strict()
  .superRefine((result, context) => {
    const total = result.pages.reduce((sum, page) => sum + page.lines.reduce((lineSum, line) => lineSum + line.text.length, 0), 0);
    if (total > MAX_TEXT_CHARS) context.addIssue({ code: "custom", message: "text exceeds the extraction limit" });
    const numbers = result.pages.map((page) => page.pageNumber);
    if (new Set(numbers).size !== numbers.length) context.addIssue({ code: "custom", message: "duplicate page numbers" });
  });

export type ProviderOutcome =
  | { ok: true; result: ProviderResult; durationMs: number }
  | { ok: false; category: ProviderFailureCategory | Extract<FailureCategory, "PROVIDER_TIMEOUT" | "MALFORMED_PROVIDER_RESPONSE">; durationMs: number };

/**
 * Runs a provider with a deadline and validates what it returns.
 *
 * The provider's own error message is never propagated: it may contain file
 * contents, paths or credentials. The caller gets a category.
 */
export async function runProvider(provider: TextExtractionProvider, input: Omit<TextExtractionInput, "signal">, timeoutMs = PROVIDER_TIMEOUT_MS): Promise<ProviderOutcome> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });

  try {
    const raced = await Promise.race([provider.extractText({ ...input, signal: controller.signal }).then((value) => ({ value })), timeout]);
    if (raced === "timeout") return { ok: false, category: "PROVIDER_TIMEOUT", durationMs: Date.now() - started };

    const parsed = providerResultSchema.safeParse(raced.value);
    if (!parsed.success) return { ok: false, category: "MALFORMED_PROVIDER_RESPONSE", durationMs: Date.now() - started };
    if (parsed.data.provider !== provider.id || parsed.data.providerVersion !== provider.version || parsed.data.method !== provider.method) {
      // A result claiming to come from a different reader than the one that
      // ran is not evidence of anything.
      return { ok: false, category: "MALFORMED_PROVIDER_RESPONSE", durationMs: Date.now() - started };
    }
    return { ok: true, result: parsed.data, durationMs: Date.now() - started };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, category: "PROVIDER_TIMEOUT", durationMs: Date.now() - started };
    // The adapter names the kind; the error itself goes no further. A
    // classifier that itself throws must not turn a read failure into a
    // crash, so it is guarded too.
    let category: ProviderFailureCategory = "PROVIDER_ERROR";
    try {
      category = provider.classifyError?.(error) ?? "PROVIDER_ERROR";
    } catch {
      category = "PROVIDER_ERROR";
    }
    return { ok: false, category, durationMs: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Which reader handles which file ─────────────────────────────────────

export type ProviderAvailability =
  | { available: true; provider: TextExtractionProvider }
  | {
      available: false;
      reason: "OCR_NOT_CONFIGURED";
      /** Safe to show. */
      message: string;
    };

/**
 * The reader for a file type, from the providers this deployment has.
 *
 * Images need OCR. No OCR provider is part of this build, so for an image the
 * answer is an honest "not configured" — never a stand-in that returns
 * nothing and calls it a result.
 */
export function resolveProvider(mimeType: VerifiedMimeType, providers: readonly TextExtractionProvider[]): ProviderAvailability {
  const provider = providers.find((candidate) => candidate.supports(mimeType));
  if (provider) return { available: true, provider };
  return {
    available: false,
    reason: "OCR_NOT_CONFIGURED",
    message: "Reading photos and scanned images needs an OCR provider, and none is configured for this deployment. The file is stored; nothing was read from it.",
  };
}

// ── The optional second stage: a purpose-built operation ────────────────

/**
 * WHY THERE IS A SECOND STAGE AT ALL.
 *
 * Generic OCR returns lines of text. A receipt's total is then found by
 * looking for the word "Total" nearby, which is exactly the heuristic that
 * fails on a photographed till receipt. Some providers have an operation
 * built for one document class that returns the fields already identified,
 * with the provider's own confidence — Textract's AnalyzeExpense and
 * AnalyzeID are both of these.
 *
 * So reading a document is: generic text first (which is what CLASSIFIES it),
 * then, only when the class has a better operation available, one more call.
 * A provider without `extractStructured` simply never gets the second stage
 * and the text path stands, which is why this is optional rather than part of
 * the base contract.
 *
 * The second stage is never speculative. It runs only for a class that has an
 * operation, and only once per document, because each call is billed.
 */
export type StructuredKind =
  /** Receipts, invoices and bills: merchant, totals, line items. */
  | "EXPENSE"
  /** Identity documents. What is kept of the result is decided in
   *  ./identity.ts, which discards most of it. */
  | "IDENTITY";

export interface StructuredExtractionInput {
  bytes: Uint8Array;
  mimeType: VerifiedMimeType;
  kind: StructuredKind;
  signal: AbortSignal;
}

export interface StructuredCapableProvider extends TextExtractionProvider {
  /** Which classes this provider has a purpose-built operation for. */
  structuredKinds(): readonly StructuredKind[];
  /** Returns `unknown`: validated by the caller against the payload schema
   *  for the kind, exactly like `extractText`. */
  extractStructured(input: StructuredExtractionInput): Promise<unknown>;
}

export function supportsStructured(provider: TextExtractionProvider, kind: StructuredKind): provider is StructuredCapableProvider {
  const candidate = provider as Partial<StructuredCapableProvider>;
  return typeof candidate.extractStructured === "function" && (candidate.structuredKinds?.() ?? []).includes(kind);
}

export type StructuredOutcome = { ok: true; payload: unknown; durationMs: number } | { ok: false; durationMs: number };

/**
 * Runs the second stage under the same deadline discipline as the first.
 *
 * A failure here is NOT a failed read: the text stage already produced a
 * classification and fields. The caller keeps those and records that the
 * better result was unavailable, so a Textract outage degrades a receipt to
 * the heuristic reading rather than to nothing.
 */
export async function runStructured(
  provider: StructuredCapableProvider,
  input: Omit<StructuredExtractionInput, "signal">,
  timeoutMs = PROVIDER_TIMEOUT_MS,
): Promise<StructuredOutcome> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });

  try {
    const raced = await Promise.race([provider.extractStructured({ ...input, signal: controller.signal }).then((value) => ({ value })), timeout]);
    if (raced === "timeout") return { ok: false, durationMs: Date.now() - started };
    return { ok: true, payload: raced.value, durationMs: Date.now() - started };
  } catch {
    return { ok: false, durationMs: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The operation a classified document should be read with, if any. */
export function structuredKindFor(documentType: string): StructuredKind | null {
  if (documentType === "RECEIPT" || documentType === "INVOICE" || documentType === "BILL") return "EXPENSE";
  // Only the two Textract actually reads. An SSN card and a generic
  // government ID are classified and protected, never sent to AnalyzeID,
  // because it does not support them and a confident wrong reading of an
  // identity document is worse than no reading.
  if (documentType === "DRIVER_LICENSE" || documentType === "PASSPORT") return "IDENTITY";
  return null;
}
