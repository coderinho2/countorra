import "server-only";
import type { TextExtractionProvider } from "@/domain/documents/intelligence/provider";
import { PdfTextLayerProvider } from "./pdf-text-layer";
import { textractConfigured } from "./textract/client";
import { TextractProvider } from "./textract/provider";

/**
 * The readers this deployment actually has.
 *
 * TWO, and the order matters.
 *
 *   1. `pdf-text-layer` — local, deterministic, free, and exact on a digital
 *      PDF because it reads the text the PDF already contains rather than
 *      guessing at pixels. It therefore gets first refusal on every PDF.
 *   2. `amazon-textract` — real OCR, for PNG and JPEG, and for PDFs whose
 *      text layer turns out to be empty (a scan). Present only when this
 *      deployment is configured for it; unconfigured, images resolve to "not
 *      configured" through `resolveProvider` exactly as before, and the
 *      product says so rather than pretending to have read them.
 *
 * WEBP has no reader at all: Textract does not accept it. Such a file is
 * stored and honestly reported as unreadable.
 *
 * Whichever reader runs, its output passes the same schema validation,
 * extraction, review and proposal workflow. Nothing downstream can tell them
 * apart except by the `method` recorded on the extraction.
 */
export function configuredProviders(): readonly TextExtractionProvider[] {
  const providers: TextExtractionProvider[] = [new PdfTextLayerProvider()];
  if (textractConfigured()) providers.push(new TextractProvider());
  return providers;
}

/**
 * The OCR reader, for the scanned-PDF fallback in ./processing.ts.
 *
 * A PDF resolves to the text-layer reader, which is right for a digital PDF
 * and useless for a scan — a scan has no text layer, so it reads nothing.
 * When that happens the pipeline asks for this instead.
 */
export function ocrProvider(providers: readonly TextExtractionProvider[]): TextExtractionProvider | null {
  return providers.find((provider) => provider.method === "OCR") ?? null;
}
