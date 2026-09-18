"use client";

import { useActionState, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorState } from "@/components/ui/error-state";
import { createCustomerAction, type CustomerActionResult } from "@/server/customers/actions";

export function NewCustomerDialog({ organizationId }: { organizationId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(async (prevState: CustomerActionResult, formData: FormData) => {
    const result = await createCustomerAction(prevState, formData);
    if (result.success) setOpen(false);
    return result;
  }, {});

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add customer</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add customer</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="organizationId" value={organizationId} />
          {state.error && <ErrorState title="Couldn't add customer" description={state.error} />}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="displayName">Name</Label>
            <Input id="displayName" name="displayName" placeholder="Individual or company name" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" placeholder="Optional" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="taxId">Tax ID</Label>
            <Input id="taxId" name="taxId" placeholder="Optional — EIN, SSN, etc." />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add customer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
