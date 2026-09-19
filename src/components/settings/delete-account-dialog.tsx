"use client";

import { useActionState, useLayoutEffect, useState } from "react";
import { WarningCircle } from "@phosphor-icons/react/dist/ssr/WarningCircle";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteAccountAction, type AccountActionResult } from "@/server/account/actions";

/** The exact word `deleteAccountAction` requires. Checked here only so the
 *  button can stay disabled until it is typed; the server checks it again. */
const CONFIRMATION_WORD = "DELETE";

/**
 * Settings → Delete account.
 *
 * This is a front end to `deleteAccountAction` and nothing more. There is
 * one deletion implementation, on the server, and every rule lives there:
 * re-authentication, the shared-workspace check, canceling Stripe billing
 * before anything is removed, releasing bank credentials, and the order of
 * the deletes.
 *
 * WHAT THE BROWSER SENDS
 *
 * Two fields: `password` and `confirmation`. No organization, customer,
 * subscription or user id travels. The server works out which workspaces are
 * affected from the session's own memberships, and reads any Stripe ids from
 * its own rows, so there is nothing here a caller could change to point the
 * deletion somewhere else.
 *
 * WHAT IT SHOWS
 *
 * On failure, the server's `error` string, which is always one of a fixed set
 * of plain sentences (the action never forwards a provider's or a database's
 * own message). On success the action signs the session out and redirects,
 * so this component never renders a success state of its own. It cannot claim
 * a deletion that did not happen.
 *
 * DESIGN.md §18: the modal is not tinted; only the confirm button carries
 * the destructive weight.
 */
export function DeleteAccountDialog() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  return (
    <Dialog
      open={open}
      // While a deletion is in flight the dialog cannot be dismissed: closing
      // it would hide the result of an action that is still running.
      onOpenChange={(next) => {
        if (!pending) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm">
          Delete account
        </Button>
      </DialogTrigger>
      <DialogContent
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onInteractOutside={(event) => pending && event.preventDefault()}
      >
        {/* Mounted only while open, so every opening starts from empty fields
            and no earlier error. */}
        <DeleteAccountForm onPendingChange={setPending} onCancel={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function DeleteAccountForm({ onPendingChange, onCancel }: { onPendingChange: (pending: boolean) => void; onCancel: () => void }) {
  const [state, formAction, pending] = useActionState<AccountActionResult, FormData>(deleteAccountAction, {});

  // Reported from React's own pending flag, which commits as soon as the
  // submission starts. Setting the parent's state from inside the action
  // instead would be held back until the action finished, which is exactly
  // the window in which the dialog must refuse to close.
  useLayoutEffect(() => {
    onPendingChange(pending);
  }, [pending, onPendingChange]);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const ready = password.length > 0 && confirmation === CONFIRMATION_WORD;

  return (
    <form
      action={formAction}
      aria-busy={pending}
      // A second submission while the first is running (a double click, or
      // Enter pressed again) is dropped here as well as by the disabled button.
      onSubmit={(event) => {
        if (pending || !ready) event.preventDefault();
      }}
      noValidate
    >
      <DialogHeader>
        <DialogTitle>Delete your account?</DialogTitle>
        <DialogDescription>This is permanent and cannot be undone.</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        <ul className="flex list-disc flex-col gap-1.5 pl-4 text-[13px] text-text-secondary">
          <li>Every workspace you are the only member of is deleted, with all of its records, documents, tax information and bank connections.</li>
          <li>Any paid subscription on those workspaces is canceled first. If the cancellation cannot be confirmed, nothing is deleted.</li>
          <li>You are removed from workspaces you share. Their records stay with the other members.</li>
        </ul>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="delete-account-password">Your password</Label>
          <Input
            id="delete-account-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending}
            required
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="delete-account-confirmation">
            Type <span className="font-numeric text-text-primary">{CONFIRMATION_WORD}</span> to confirm
          </Label>
          <Input
            id="delete-account-confirmation"
            name="confirmation"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={pending}
            required
          />
        </div>

        {state.error && !pending && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-negative/30 bg-negative-subtle p-3">
            <WarningCircle weight="bold" className="mt-0.5 size-4 shrink-0 text-negative" />
            <p className="text-[13px] text-text-primary">{state.error}</p>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive-solid" disabled={!ready || pending}>
          {pending ? "Deleting account…" : "Delete account"}
        </Button>
      </DialogFooter>
    </form>
  );
}
