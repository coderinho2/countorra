"use client";

import { useActionState, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorState } from "@/components/ui/error-state";
import { createAccountAction, type AccountActionResult } from "@/server/accounts/actions";

/**
 * Adds a CASH or WALLET account — money a bank connection can't see. Bank
 * and credit card accounts come from connecting a bank
 * (src/domain/accounts/manual-entry.ts), so they are not offered here, and
 * the server and database refuse them. A secondary action: connecting a bank
 * is the primary way accounts arrive.
 */
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
        <Button variant="secondary">Add cash account</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a cash account</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="organizationId" value={organizationId} />
          <input type="hidden" name="currency" value={currency} />

          <p className="text-[13px] text-text-secondary">
            For cash or a wallet you track yourself. Bank and credit card accounts are added by connecting your bank, so their balances
            and transactions come straight from it.
          </p>

          {state.error && <ErrorState title="Couldn't add account" description={state.error} />}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" placeholder="e.g. Cash on hand" required />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kind">Type</Label>
            <Select name="kind" defaultValue="cash">
              <SelectTrigger id="kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="wallet">Wallet</SelectItem>
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
