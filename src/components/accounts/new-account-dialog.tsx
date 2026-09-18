"use client";

import { useActionState, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorState } from "@/components/ui/error-state";
import { createAccountAction, type AccountActionResult } from "@/server/accounts/actions";

export function NewAccountDialog({ organizationId, currency }: { organizationId: string; currency: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(async (prevState: AccountActionResult, formData: FormData) => {
    const result = await createAccountAction(prevState, formData);
    if (result.success) setOpen(false);
    return result;
  }, {});

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add account</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add account</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="organizationId" value={organizationId} />
          <input type="hidden" name="currency" value={currency} />

          {state.error && <ErrorState title="Couldn't add account" description={state.error} />}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" placeholder="e.g. Business Checking" required />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kind">Type</Label>
            <Select name="kind" defaultValue="bank">
              <SelectTrigger id="kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bank">Bank account</SelectItem>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="credit_card">Credit card</SelectItem>
                <SelectItem value="wallet">Wallet</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="openingBalance">Opening balance</Label>
            <Input id="openingBalance" name="openingBalance" type="text" inputMode="decimal" placeholder="0.00" numeric />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
