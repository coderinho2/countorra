"use client";

import { useActionState, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorState } from "@/components/ui/error-state";
import { createTransactionAction, type TransactionActionResult } from "@/server/transactions/actions";
import type { Account } from "@/server/db/repositories/accounts";
import type { Category } from "@/server/db/repositories/categories";
import type { TransactionKind } from "@/types/database";

export function NewTransactionDialog({ organizationId, accounts, categories, currency }: { organizationId: string; accounts: Account[]; categories: Category[]; currency: string }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<TransactionKind>("expense");
  const [sourceAccountId, setSourceAccountId] = useState<string>("");
  const isTransfer = kind === "transfer";
  const [state, formAction, pending] = useActionState(async (prevState: TransactionActionResult, formData: FormData) => {
    const result = await createTransactionAction(prevState, formData);
    if (result.success) setOpen(false);
    return result;
  }, {});

  // A transfer is neither income nor spending, so no category applies —
  // every aggregate excludes transfers, and offering a category would imply
  // it appears in a breakdown somewhere. The server refuses one too.
  const filteredCategories = isTransfer ? [] : categories.filter((c) => c.kind === kind);

  // Both sides must be the same currency: Countorra converts nothing, so a
  // cross-currency transfer has no single correct amount. Offering only
  // matching accounts stops the user hitting that as a server error.
  const source = accounts.find((a) => a.id === sourceAccountId);
  const destinations = accounts.filter((a) => a.id !== sourceAccountId && (!source || a.currency === source.currency));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add transaction</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add transaction</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="organizationId" value={organizationId} />
          <input type="hidden" name="currency" value={currency} />

          {state.error && <ErrorState title="Couldn't add transaction" description={state.error} />}

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kind">Type</Label>
              <Select name="kind" value={kind} onValueChange={(v) => setKind(v as TransactionKind)}>
                <SelectTrigger id="kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="expense">Expense</SelectItem>
                  <SelectItem value="income">Income</SelectItem>
                  <SelectItem value="transfer">Transfer</SelectItem>
                </SelectContent>
              </Select>
              <input type="hidden" name="kind" value={kind} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="amount">Amount</Label>
              <Input id="amount" name="amount" type="text" inputMode="decimal" placeholder="0.00" numeric required />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="accountId">{isTransfer ? "From account" : "Account"}</Label>
            <Select name="accountId" required value={sourceAccountId} onValueChange={setSourceAccountId}>
              <SelectTrigger id="accountId">
                <SelectValue placeholder="Select an account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isTransfer && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="transferAccountId">To account</Label>
              <Select name="transferAccountId" required>
                <SelectTrigger id="transferAccountId">
                  <SelectValue placeholder={sourceAccountId ? "Select the destination" : "Choose the from account first"} />
                </SelectTrigger>
                <SelectContent>
                  {destinations.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[12px] text-text-tertiary">
                Moving money between your own accounts. It changes both balances and is excluded from income, spending and profit.
              </p>
            </div>
          )}

          {!isTransfer && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="categoryId">Category</Label>
            <Select name="categoryId">
              <SelectTrigger id="categoryId">
                <SelectValue placeholder="Uncategorized" />
              </SelectTrigger>
              <SelectContent>
                {filteredCategories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="occurredOn">Date</Label>
              <Input id="occurredOn" name="occurredOn" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="merchantName">Merchant</Label>
              <Input id="merchantName" name="merchantName" placeholder="Optional" disabled={isTransfer} />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="description">Description</Label>
            <Input id="description" name="description" placeholder="Optional" />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add transaction"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
