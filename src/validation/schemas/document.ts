import { z } from "zod";
import { MAX_UPLOAD_BYTES } from "@/domain/documents/upload-limits";

const ACCEPTED_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"] as const;

/**
 * Step 1 of a direct-to-Storage upload: what the browser declares before any
 * bytes exist.
 *
 * Every field here is a CLAIM. `mimeType` is derived from the file extension
 * by the browser and `sizeBytes` is whatever the client chose to send. They
 * are validated so an obviously-impossible upload is refused before a signed
 * URL is minted — cheap, and it keeps junk out of the bucket — but nothing in
 * this object is treated as evidence. The size that gets recorded and the type
 * that gets enforced both come from reading the stored object back
 * (src/domain/documents/upload-lifecycle.ts).
 */
export const uploadDocumentSchema = z.object({
  organizationId: z.uuid(),
  kind: z.enum(["invoice", "receipt", "bill", "bank_statement", "tax_form", "other"]),
  originalFilename: z.string().min(1).max(255),
  mimeType: z.enum(ACCEPTED_MIME_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});

export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;

/**
 * Step 2: the caller identifies the pending row to verify.
 *
 * No storage path, no size, no type — nothing the caller could use to point
 * confirmation at a different object. The server already recorded all of that
 * when it minted the URL, and re-reads it from the row.
 */
export const confirmDocumentUploadSchema = z.object({
  organizationId: z.uuid(),
  documentId: z.uuid(),
});

export type ConfirmDocumentUploadInput = z.infer<typeof confirmDocumentUploadSchema>;
