"use client";

import { useActionState, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createTaxFilingSnapshotAction,
  evaluateTaxFilingReadinessAction,
  finalizeTaxFilingAction,
  startTaxFilingAction,
  type TaxFilingActionResult,
} from "@/server/tax-filing/actions";

/**
 * The forms behind the Tax filing page.
 *
 * Every one posts to a server action that re-validates, re-authorizes,
 * recomputes readiness and re-runs the engines. The hidden ids are pointers the
 * server checks, not permissions, and nothing here can set a status, a scope's
 * eligibility or a package.
 */

type Action = (prev: TaxFilingActionResult, formData: FormData) => Promise<TaxFilingActionResult>;

function useFilingAction(action: Action, onSuccess?: () => void) {
  return useActionState(async (prev: TaxFilingActionResult, formData: FormData) => {
    const result = await action(prev, formData);
    if (result.success) onSuccess?.();
    return result;
  }, {});
}

function Result({ state, title }: { state: TaxFilingActionResult; title: string }) {
  if (state.error) return <ErrorState title={title} description={state.error} />;
  if (state.message) {
    return (
      <p role="status" className="text-text-secondary text-[13px]">
        {state.message}
      </p>
    );
  }
  return null;
}

export function StartFilingForm({ organizationId }: { organizationId: string }) {
  const [state, formAction, pending] = useFilingAction(startTaxFilingAction);
  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <input type="hidden" name="organizationId" value={organizationId} />
      <Button type="submit" disabled={pending}>
        {pending ? "Checking…" : "Start filing review"}
      </Button>
      <Result state={state} title="Couldn't start" />
    </form>
  );
}

export function EvaluateReadinessForm({ organizationId, filingCaseId }: { organizationId: string; filingCaseId: string }) {
  const [state, formAction, pending] = useFilingAction(evaluateTaxFilingReadinessAction);
  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="filingCaseId" value={filingCaseId} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Checking…" : "Check readiness again"}
      </Button>
      <Result state={state} title="Couldn't check readiness" />
    </form>
  );
}

export function CreateSnapshotForm({ organizationId, filingCaseId, disabled, label }: { organizationId: string; filingCaseId: string; disabled: boolean; label: string }) {
  const [state, formAction, pending] = useFilingAction(createTaxFilingSnapshotAction);
  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="filingCaseId" value={filingCaseId} />
      <Button type="submit" disabled={disabled || pending}>
        {pending ? "Creating…" : label}
      </Button>
      <Result state={state} title="Couldn't create the snapshot" />
    </form>
  );
}

export interface FinalizeSummary {
  taxYear: number;
  version: number;
  filingStatus: string;
  scope: "FULL" | "FEDERAL_ONLY";
  /** Pre-formatted rows: jurisdiction, what happens to it, its figure. */
  jurisdictions: readonly { name: string; role: string; figure: string }[];
  refund: string;
  exclusions: readonly { code: string; name: string; reason: string }[];
  warnings: readonly string[];
  limitations: readonly string[];
}

/**
 * Finalization confirmation.
 *
 * Everything material is on the face of the dialog — figures, every excluded
 * state with its reason, every warning and every limitation — not behind a
 * tooltip or a disclosure. Finalizing needs the box ticked AND the word typed,
 * so it is never one stray click, and the dialog says in plain words that
 * nothing is filed or submitted.
 */
export function FinalizeDialog({ organizationId, filingCaseId, snapshotId, summary }: { organizationId: string; filingCaseId: string; snapshotId: string; summary: FinalizeSummary }) {
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [typed, setTyped] = useState("");
  const [state, formAction, pending] = useFilingAction(finalizeTaxFilingAction, () => setOpen(false));
  const ready = acknowledged && typed === "FINALIZE";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>{summary.scope === "FULL" ? "Review and finalize" : "Review and finalize federal only"}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Finalize {summary.taxYear} return — version {summary.version}
          </DialogTitle>
          <DialogDescription>
            Finalizing locks this reviewed version inside Countorra. It does not file or submit anything to the IRS or any state, and electronic filing is not
            available.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="flex flex-col gap-5">
          <input type="hidden" name="organizationId" value={organizationId} />
          <input type="hidden" name="filingCaseId" value={filingCaseId} />
          <input type="hidden" name="snapshotId" value={snapshotId} />
          <input type="hidden" name="scope" value={summary.scope} />
          <input type="hidden" name="excludedJurisdictions" value={summary.exclusions.map((exclusion) => exclusion.code).join(",")} />
          <input type="hidden" name="acknowledged" value={acknowledged ? "yes" : ""} />

          <section className="flex flex-col gap-2">
            <h3 className="text-text-secondary text-[11px] font-semibold tracking-[0.08em] uppercase">What you are finalizing</h3>
            <dl className="border-border-subtle divide-border-subtle flex flex-col divide-y rounded-md border text-[13px]">
              <Row label="Tax year" value={String(summary.taxYear)} />
              <Row label="Filing status" value={summary.filingStatus} />
              <Row label="Scope" value={summary.scope === "FULL" ? "Federal and every state component" : "Federal only"} />
              {summary.jurisdictions.map((jurisdiction) => (
                <Row key={jurisdiction.name} label={jurisdiction.name} value={jurisdiction.figure} note={jurisdiction.role} numeric />
              ))}
              <Row label="Federal refund or balance due" value={summary.refund} numeric />
            </dl>
            <p className="text-text-tertiary text-[12px]">All tax figures are before credits, which are not modelled.</p>
          </section>

          {summary.exclusions.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-text-secondary text-[11px] font-semibold tracking-[0.08em] uppercase">Excluded from this finalization</h3>
              <ul className="flex flex-col gap-1.5 text-[13px]">
                {summary.exclusions.map((exclusion) => (
                  <li key={exclusion.code} className="border-l-warning border-border-subtle rounded-md border border-l-2 px-3 py-2">
                    <span className="text-text-primary font-medium">{exclusion.name}</span>
                    <span className="text-text-secondary block">{exclusion.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="flex flex-col gap-2">
            <h3 className="text-text-secondary text-[11px] font-semibold tracking-[0.08em] uppercase">Warnings you are acknowledging</h3>
            {summary.warnings.length === 0 ? (
              <p className="text-text-secondary text-[13px]">None.</p>
            ) : (
              <ul className="text-text-secondary flex list-disc flex-col gap-1 pl-5 text-[13px]">
                {summary.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-text-secondary text-[11px] font-semibold tracking-[0.08em] uppercase">Limitations</h3>
            <ul className="text-text-secondary flex list-disc flex-col gap-1 pl-5 text-[13px]">
              {summary.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </section>

          <div className="border-border-subtle flex flex-col gap-4 border-t pt-4">
            <div className="flex items-start gap-2.5">
              <Checkbox id="finalize-acknowledged" checked={acknowledged} onCheckedChange={(value) => setAcknowledged(value === true)} className="mt-0.5" />
              <Label htmlFor="finalize-acknowledged" className="text-text-primary text-[13px] leading-5 font-normal">
                I have reviewed every figure, excluded state, warning and limitation above, and I understand that finalizing does not file or submit this return.
              </Label>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="finalize-confirmation">Type FINALIZE to confirm</Label>
              <Input id="finalize-confirmation" name="confirmation" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} className="font-numeric max-w-48" />
            </div>
          </div>

          <Result state={state} title="Couldn't finalize" />

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || pending}>
              {pending ? "Finalizing…" : "Finalize return"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, note, numeric }: { label: string; value: string; note?: string; numeric?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-3 py-2">
      <dt className="flex flex-col">
        <span className="text-text-primary">{label}</span>
        {note && <span className="text-text-tertiary text-[12px]">{note}</span>}
      </dt>
      <dd className={numeric ? "font-numeric text-text-primary text-right tabular-nums" : "text-text-primary text-right"}>{value}</dd>
    </div>
  );
}
