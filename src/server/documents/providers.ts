import "server-only";
import type { TextExtractionProvider } from "@/domain/documents/intelligence/provider";
import { PdfTextLayerProvider } from "./pdf-text-layer";

/**
 * The readers this deployment actually has.
 *
 * ONE, and it is local: `pdf-text-layer`, which reads the text built into
 * digital PDFs. There is no OCR provider. Images (PNG, JPEG, WEBP) and scanned
 * PDFs therefore resolve to "not configured" through `resolveProvider`, and the
 * product says so — nothing pretends to have read them.
 *
 * ADDING A REAL OCR PROVIDER
 *
 * Implement `TextExtractionProvider` (src/domain/documents/intelligence/
 * provider.ts) with `method: "OCR"`, read its credentials through
 * src/lib/env.ts (never `process.env` directly), and add it to this list when
 * those credentials are present. Its output passes the same schema validation,
 * extraction, review and proposal workflow as the text-layer reader; nothing
 * downstream changes. A deterministic fixture provider exists only in tests.
 */
export function configuredProviders(): readonly TextExtractionProvider[] {
  return [new PdfTextLayerProvider()];
}
