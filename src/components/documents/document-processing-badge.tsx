import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { FieldReviewState, ProcessingJobStatus } from "@/domain/documents/intelligence/types";

/**
 * The states a document's reading can honestly be in.
 *
 * "Processed" means the reader finished — not that any figure is right. A
 * figure is only ever right once a person confirms it in Tax preparation,
 * which is why none of these is the green "confirmed" colour except a
 * complete read, and why review states for individual values are neutral
 * rather than positive.
 */
const PROCESSING: Record<ProcessingJobStatus | "NOT_PROCESSED", { label: string; variant: BadgeProps["variant"] }> = {
  NOT_PROCESSED: { label: "Not processed", variant: "neutral" },
  QUEUED: { label: "Queued", variant: "info" },
  PROCESSING: { label: "Processing", variant: "info" },
  SUCCEEDED: { label: "Processed", variant: "positive" },
  PARTIAL: { label: "Partially extracted", variant: "warning" },
  REVIEW_REQUIRED: { label: "Needs review", variant: "warning" },
  UNSUPPORTED: { label: "Unsupported", variant: "neutral" },
  FAILED: { label: "Failed", variant: "negative" },
};

export function ProcessingStatusBadge({ status }: { status: ProcessingJobStatus | null }) {
  const { label, variant } = PROCESSING[status ?? "NOT_PROCESSED"];
  return <Badge variant={variant}>{label}</Badge>;
}

const REVIEW: Record<FieldReviewState, { label: string; variant: BadgeProps["variant"] }> = {
  HIGH_CONFIDENCE: { label: "Clear read", variant: "neutral" },
  MEDIUM_CONFIDENCE: { label: "Read by layout", variant: "neutral" },
  LOW_CONFIDENCE: { label: "Uncertain", variant: "warning" },
  UNREADABLE: { label: "Unreadable", variant: "warning" },
  MISSING: { label: "Not found", variant: "neutral" },
  CONFLICT: { label: "Conflicting", variant: "negative" },
};

export function FieldReviewBadge({ state }: { state: FieldReviewState }) {
  const { label, variant } = REVIEW[state];
  return <Badge variant={variant}>{label}</Badge>;
}

export type PreparationColumnState = "EXTRACTED" | "PROPOSED" | "CONFIRMED" | "REJECTED" | "CONFLICTING";

const PREPARATION: Record<PreparationColumnState, { label: string; variant: BadgeProps["variant"] }> = {
  EXTRACTED: { label: "Extracted", variant: "neutral" },
  PROPOSED: { label: "Proposed", variant: "info" },
  CONFIRMED: { label: "Confirmed", variant: "positive" },
  REJECTED: { label: "Rejected", variant: "neutral" },
  CONFLICTING: { label: "Conflicting", variant: "negative" },
};

export function PreparationStateBadge({ state }: { state: PreparationColumnState }) {
  const { label, variant } = PREPARATION[state];
  return <Badge variant={variant}>{label}</Badge>;
}
