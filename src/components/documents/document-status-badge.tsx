import { Badge } from "@/components/ui/badge";
import type { DocumentStatus } from "@/types/database";

const STATUS_VARIANT: Record<DocumentStatus, { label: string; variant: "positive" | "negative" | "warning" | "info" | "neutral" }> = {
  uploaded: { label: "Uploaded", variant: "neutral" },
  // Present for exhaustiveness, not because they render. `listDocuments`
  // returns only 'uploaded' rows, so a badge for an in-flight or refused
  // upload has no surface to appear on — and that is the point: a `pending`
  // row rendered as "Pending" would be the product admitting a document
  // exists before any server has confirmed one does.
  pending: { label: "Uploading", variant: "info" },
  rejected: { label: "Rejected", variant: "negative" },
  processing: { label: "Processing", variant: "info" },
  needs_review: { label: "Needs review", variant: "warning" },
  processed: { label: "Processed", variant: "positive" },
  failed: { label: "Failed", variant: "negative" },
};

/** DESIGN.md §21: every document state the pipeline can honestly be in
 *  (product spec §21) — 'processing'/'processed'/'needs_review' exist in
 *  the type system for when a real extraction provider lands, but nothing
 *  currently moves a document past 'uploaded' (see the module comment on
 *  src/server/documents/actions.ts). */
export function DocumentStatusBadge({ status }: { status: DocumentStatus }) {
  const { label, variant } = STATUS_VARIANT[status];
  return <Badge variant={variant}>{label}</Badge>;
}
