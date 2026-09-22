"use client";

import { useActionState, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  disconnectBankConnectionAction,
  linkExternalAccountAction,
  requestBankSyncAction,
  resolveBankReviewAction,
  type BankActionResult,
} from "@/server/bank-connections/actions";

/**
 * The few things a person can do on the Bank connections page.
 *
 * Every form posts ids and, at most, one small choice. The server decides
 * everything else — which provider, what status, which amounts, whether a
 * currency matches — so nothing here can be edited in the browser to change
 * an outcome. There is no "Connect a bank" form: no provider is configured,
 * and a button that could only fail would be a pretence.
 */

function Result({ state }: { state: BankActionResult }) {
  if (state.error) {
    return (
      <p role="alert" className="max-w-[60ch] text-[13px] text-negative">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p role="status" className="max-w-[60ch] text-[13px] text-text-secondary">
        {state.message}
      </p>
    );
  }
  return null;
}

export function RefreshConnectionForm({ organizationId, connectionId }: { organizationId: string; connectionId: string }) {
  const [state, formAction, pending] = useActionState(requestBankSyncAction, {});
  return (
    <form action={formAction} className="flex flex-col items-end gap-1.5">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="connectionId" value={connectionId} />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? "Importing…" : "Import now"}
      </Button>
      <Result state={state} />
    </form>
  );
}

export function DisconnectConnectionDialog({ organizationId, connectionId, institutionName }: { organizationId: string; connectionId: string; institutionName: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(async (previous: BankActionResult, formData: FormData) => {
    const result = await disconnectBankConnectionAction(previous, formData);
    if (result.success) setOpen(false);
    return result;
  }, {});

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="destructive">
            Disconnect
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {institutionName}?</DialogTitle>
            <DialogDescription>
              Countorra stops importing from this bank and removes the access it holds. Transactions already imported stay in your books — nothing is deleted. To import
              again later, you would connect the bank again.
            </DialogDescription>
          </DialogHeader>
          <form action={formAction} className="flex flex-col gap-4">
            <input type="hidden" name="organizationId" value={organizationId} />
            <input type="hidden" name="connectionId" value={connectionId} />
            <input type="hidden" name="confirm" value="disconnect" />
            <Result state={state} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive-solid" disabled={pending}>
                {pending ? "Disconnecting…" : "Disconnect"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {!open && state.message && <Result state={state} />}
    </div>
  );
}

export function LinkAccountForm({
  organizationId,
  linkedAccountId,
  accounts,
  label,
}: {
  organizationId: string;
  linkedAccountId: string;
  /** Countorra accounts of the same kind and currency, kept by hand and not
   *  already fed by a bank — the ones this bank account could continue. */
  accounts: { id: string; name: string }[];
  label: string;
}) {
  const [state, formAction, pending] = useActionState(linkExternalAccountAction, {});
  const fieldId = `link-${linkedAccountId}`;
  return (
    // `relative`: Radix Select renders a visually-hidden native <select>
    // absolutely positioned. Without a positioned ancestor its containing block
    // is the page, so inside a horizontally scrolling table it escaped the
    // table's scroll frame and made the whole page scroll sideways on a phone.
    <form action={formAction} className="relative flex flex-col gap-1.5">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="linkedAccountId" value={linkedAccountId} />
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={fieldId} className="sr-only">
          {label}
        </label>
        <Select name="target" defaultValue="new">
          <SelectTrigger id={fieldId} className="h-8 w-[200px] text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="new">Import as a new account</SelectItem>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                Continue {account.name}
              </SelectItem>
            ))}
            <SelectItem value="ignore">Don&apos;t import</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      {accounts.length > 0 && (
        <p className="max-w-[40ch] text-[12px] text-text-tertiary">
          Continuing an account you kept by hand matches your entries instead of importing them twice.
        </p>
      )}
      <Result state={state} />
    </form>
  );
}

const RESOLUTION_LABELS = {
  KEEP_BOOKS: "Keep my books as they are",
  IMPORT_AS_NEW: "Import as a new transaction",
  DO_NOT_IMPORT: "Don't import",
} as const;

export function ReviewResolutionForm({ organizationId, externalId, options }: { organizationId: string; externalId: string; options: (keyof typeof RESOLUTION_LABELS)[] }) {
  const [state, formAction, pending] = useActionState(resolveBankReviewAction, {});
  return (
    <form action={formAction} className="flex flex-col items-start gap-1.5">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="externalId" value={externalId} />
      <div className="flex flex-wrap gap-2">
        {options.map((option, index) => (
          <Button key={option} type="submit" name="resolution" value={option} size="sm" variant={index === 0 ? "secondary" : "ghost"} disabled={pending}>
            {RESOLUTION_LABELS[option]}
          </Button>
        ))}
      </div>
      <Result state={state} />
    </form>
  );
}
