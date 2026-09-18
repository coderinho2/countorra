"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { deleteTransactionAction } from "@/server/transactions/actions";

/** Destructive action, behind an explicit confirmation dialog (product
 *  spec §9, §37) — never a single accidental click. */
export function DeleteTransactionButton({ organizationId, transactionId }: { organizationId: string; transactionId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm">
          Delete transaction
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this transaction?</DialogTitle>
          <DialogDescription>This removes it from your records permanently. This cannot be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive-solid"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await deleteTransactionAction(organizationId, transactionId);
                router.push(`/app/${organizationId}/transactions`);
              })
            }
          >
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
