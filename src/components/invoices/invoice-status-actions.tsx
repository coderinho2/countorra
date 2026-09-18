"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { sendInvoiceAction, updateInvoiceStatusAction } from "@/server/invoices/actions";
import type { DerivedInvoiceState, StoredInvoiceStatus } from "@/domain/invoicing/lifecycle";

/**
 * The actions an invoice offers, and only the ones its current state allows.
 *
 * `state` is the DERIVED state (so an overdue invoice is labelled as such),
 * while transitions are issued against the stored one. Which buttons appear
 * is a convenience — the server re-checks every transition against the same
 * state machine, so hiding a button is not what prevents an illegal move.
 *
 * Send and "mark paid" are different kinds of operation and are treated as
 * such: sending renders a PDF and delivers an email, so it can half-succeed
 * (invoice sent, email not) and returns a warning the user needs to read.
 */
export function InvoiceStatusActions({
  organizationId,
  invoiceId,
  status,
  state,
}: {
  organizationId: string;
  invoiceId: string;
  status: StoredInvoiceStatus;
  state: DerivedInvoiceState;
}) {
  const [pending, startTransition] = useTransition();
  const [voidOpen, setVoidOpen] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "warning"; text: string } | null>(null);

  function run(action: () => Promise<{ error?: string; warning?: string }>) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) setMessage({ tone: "error", text: result.error });
      else if (result.warning) setMessage({ tone: "warning", text: result.warning });
    });
  }

  const canSend = status === "draft" || status === "sent";

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        {canSend && (
          <Button size="sm" disabled={pending} onClick={() => run(() => sendInvoiceAction(organizationId, invoiceId))}>
            {pending ? "Sending…" : status === "draft" ? "Send invoice" : state === "overdue" ? "Send reminder" : "Resend"}
          </Button>
        )}

        {status === "sent" && (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => updateInvoiceStatusAction(organizationId, invoiceId, "paid"))}>
            Mark as paid
          </Button>
        )}

        {(status === "draft" || status === "sent") && (
          <Dialog open={voidOpen} onOpenChange={setVoidOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="destructive">
                Void
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Void this invoice?</DialogTitle>
                <DialogDescription>
                  The invoice stays on record but is marked void — it can no longer be sent or paid. This preserves your audit trail rather than deleting it.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setVoidOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive-solid"
                  disabled={pending}
                  onClick={() => {
                    run(() => updateInvoiceStatusAction(organizationId, invoiceId, "void"));
                    setVoidOpen(false);
                  }}
                >
                  Void invoice
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {message && (
        <p
          role="alert"
          className={`max-w-[46ch] text-right text-[12px] leading-[1.5] ${message.tone === "error" ? "text-negative" : "text-warning"}`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
