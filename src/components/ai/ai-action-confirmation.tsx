"use client";

import { useState, useTransition } from "react";
import { Warning } from "@phosphor-icons/react/dist/ssr/Warning";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { confirmAiAction } from "@/server/ai/actions";

/**
 * The visible half of the WRITE/DELETE confirmation gate (product spec
 * §4, §14 "confirmation controls"). Nothing this card represents has
 * touched the database yet — it exists because src/domain/ai/service.ts
 * intercepted a write/delete tool call and turned it into a
 * pending `ai_actions` row instead of executing it.
 *
 * The card lists the actual arguments, not just the tool's name. A
 * confirmation the user cannot read is not a control: the whole point of
 * the gate is that a human sees *what* would be written before it is, and
 * the arguments are the part an injected instruction inside a merchant
 * name or a document would be steering. Values are rendered as inert text
 * — React escapes them, and nothing here interprets markup or links.
 */

/** Human-readable labels for the argument names the write tools use, so a
 *  reviewer reads "Amount", not "amountMinor". Anything not listed falls
 *  back to the raw key rather than being hidden — an unrecognized argument
 *  is exactly the thing worth showing. */
const ARGUMENT_LABELS: Record<string, string> = {
  accountId: "Account",
  amount: "Amount",
  categoryId: "Category",
  currency: "Currency",
  customerId: "Customer",
  description: "Description",
  dueDate: "Due date",
  invoiceNumber: "Invoice number",
  issueDate: "Issue date",
  kind: "Type",
  lineItems: "Line items",
  occurredOn: "Date",
  transactionId: "Transaction",
};

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  return JSON.stringify(value);
}

function ArgumentList({ input }: { input: unknown }) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return null;

  return (
    <dl className="flex flex-col gap-1 border-t border-border-subtle pt-3">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-baseline justify-between gap-4">
          <dt className="text-[11px] font-semibold tracking-wide text-text-tertiary uppercase">{ARGUMENT_LABELS[key] ?? key}</dt>
          <dd className="font-numeric truncate text-right text-[13px] text-text-primary">{formatValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AiActionConfirmation({
  actionId,
  toolName,
  operationMode,
  input,
}: {
  actionId: string;
  toolName: string;
  operationMode: string;
  input?: unknown;
}) {
  const [status, setStatus] = useState<"pending" | "executed" | "rejected">("pending");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const respond = (approve: boolean) => {
    startTransition(async () => {
      const result = await confirmAiAction({ aiActionId: actionId, approve });
      if (result.error) setError(result.error);
      setStatus(result.status);
    });
  };

  if (status !== "pending") {
    return (
      <Card className="flex items-center gap-2 border-border-subtle bg-surface-sunken p-3 text-[13px] text-text-secondary">
        {status === "executed" ? "Confirmed and applied." : error ? error : "Not applied."}
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-3 border-warning/30 bg-warning-subtle p-4">
      <div className="flex items-center gap-2 text-warning">
        <Warning size={16} weight="bold" />
        <span className="text-[13px] font-semibold">
          {operationMode === "delete" ? "This will delete a record" : "This will change your records"}
        </span>
      </div>
      <p className="text-[13px] text-text-secondary">
        The assistant wants to run <span className="font-numeric">{toolName}</span> with the values below. Nothing has been
        changed yet.
      </p>
      <ArgumentList input={input} />
      <div className="flex gap-2">
        <Button size="sm" variant={operationMode === "delete" ? "destructive-solid" : "primary"} disabled={pending} onClick={() => respond(true)}>
          Confirm
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => respond(false)}>
          Dismiss
        </Button>
      </div>
    </Card>
  );
}
