import { Badge } from "@/components/ui/badge";
import type { InvoiceStatus } from "@/types/database";

const STATUS_VARIANT: Record<InvoiceStatus, { label: string; variant: "positive" | "negative" | "warning" | "info" | "neutral" }> = {
  paid: { label: "Paid", variant: "positive" },
  overdue: { label: "Overdue", variant: "negative" },
  sent: { label: "Sent", variant: "info" },
  draft: { label: "Draft", variant: "warning" },
  void: { label: "Void", variant: "neutral" },
};

/** DESIGN.md §3/§13: status communicated by color + text together, never
 *  color alone — the label always renders, the variant only tints it. */
export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const { label, variant } = STATUS_VARIANT[status];
  return <Badge variant={variant}>{label}</Badge>;
}
