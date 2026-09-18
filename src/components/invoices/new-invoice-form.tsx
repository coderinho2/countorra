"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorState } from "@/components/ui/error-state";
import { Card } from "@/components/ui/card";
import { InvoiceLineItemsEditor } from "./invoice-line-items-editor";
import { createInvoiceAction, type InvoiceActionResult } from "@/server/invoices/actions";
import type { Customer } from "@/server/db/repositories/customers";

export function NewInvoiceForm({ organizationId, customers, currency }: { organizationId: string; customers: Customer[]; currency: string }) {
  const [state, formAction, pending] = useActionState<InvoiceActionResult, FormData>(createInvoiceAction, {});

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="currency" value={currency} />

      {state.error && <ErrorState title="Couldn't create invoice" description={state.error} />}

      <Card className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="customerId">Customer</Label>
            <Select name="customerId" required>
              <SelectTrigger id="customerId">
                <SelectValue placeholder={customers.length === 0 ? "Add a customer first" : "Select a customer"} />
              </SelectTrigger>
              <SelectContent>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="issueDate">Issue date</Label>
            <Input id="issueDate" name="issueDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dueDate">Due date</Label>
            <Input id="dueDate" name="dueDate" type="date" />
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-[13px] font-semibold tracking-wide text-text-tertiary uppercase">Line items</h2>
        <InvoiceLineItemsEditor currency={currency} />
      </Card>

      <Card>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="notes">Notes</Label>
          <Textarea id="notes" name="notes" placeholder="Payment instructions, terms, etc. (optional)" />
        </div>
      </Card>

      <div className="flex justify-end gap-2">
        <Button asChild variant="ghost">
          <Link href={`/app/${organizationId}/invoices`}>Cancel</Link>
        </Button>
        <Button type="submit" disabled={pending || customers.length === 0}>
          {pending ? "Creating…" : "Create draft"}
        </Button>
      </div>
    </form>
  );
}
