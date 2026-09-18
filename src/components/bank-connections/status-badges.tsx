import { Badge } from "@/components/ui/badge";
import { CONNECTION_STATUS_PRESENTATION, IMPORT_MODE_PRESENTATION, RECONCILIATION_PRESENTATION } from "@/domain/bank-connections/presentation";
import type { ConnectionStatus, ImportMode, ReconciliationState } from "@/domain/bank-connections/types";

/**
 * Status pills for bank connections (DESIGN.md §11): tinted background, the
 * status word always present, never colour alone. "Connected" is the only
 * positive state a connection can show, and it appears only for a connection
 * whose status is ACTIVE in the database.
 */

export function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  const { label, tone } = CONNECTION_STATUS_PRESENTATION[status];
  return <Badge variant={tone}>{label}</Badge>;
}

export function ImportModeBadge({ mode, detached }: { mode: ImportMode; detached: boolean }) {
  if (detached) return <Badge variant="neutral">Disconnected</Badge>;
  const { label, tone } = IMPORT_MODE_PRESENTATION[mode];
  return <Badge variant={tone}>{label}</Badge>;
}

export function ReconciliationBadge({ state }: { state: ReconciliationState }) {
  const { label, tone } = RECONCILIATION_PRESENTATION[state];
  return <Badge variant={tone}>{label}</Badge>;
}
