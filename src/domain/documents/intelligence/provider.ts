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
}

const positionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative().nullable(),
    height: z.number().finite().nonnegative().nullable(),
    units: z.enum(["pdf_points", "pixels"]),
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
  | { ok: false; category: Extract<FailureCategory, "PROVIDER_ERROR" | "PROVIDER_TIMEOUT" | "MALFORMED_PROVIDER_RESPONSE">; durationMs: number };

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
  } catch {
    if (controller.signal.aborted) return { ok: false, category: "PROVIDER_TIMEOUT", durationMs: Date.now() - started };
    return { ok: false, category: "PROVIDER_ERROR", durationMs: Date.now() - started };
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
