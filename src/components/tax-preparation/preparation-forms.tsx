"use client";

import { Fragment, startTransition, useActionState, useState, type FormEvent } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorState } from "@/components/ui/error-state";
import { allFactDefinitions } from "@/domain/tax-preparation/facts";
import type { FactState, TaxpayerProfile } from "@/domain/tax-preparation/types";
import type { FilingStatus } from "@/domain/tax/rules/types";
import {
  addDependentAction,
  calculateTaxPreparationAction,
  recordFactAction,
  removeDependentAction,
  reviewFactAction,
  startTaxPreparationAction,
  updateTaxpayerAction,
  type TaxPreparationActionResult,
} from "@/server/tax-preparation/actions";

/**
 * The forms behind the tax preparation page.
 *
 * Every one of them posts to a server action that re-validates, re-authorizes
 * and derives the tax year and jurisdiction itself. Nothing here is trusted —
 * the hidden `caseId` field is a pointer the server checks, not a permission.
 */

type Action = (prev: TaxPreparationActionResult, formData: FormData) => Promise<TaxPreparationActionResult>;

/** `useActionState` plus a hook to close a dialog on success. */
function useTaxAction(action: Action, onSuccess?: () => void) {
  return useActionState(async (prev: TaxPreparationActionResult, formData: FormData) => {
    const result = await action(prev, formData);
    if (result.success) onSuccess?.();
    return result;
  }, {});
}

function Ids({ organizationId, caseId }: { organizationId: string; caseId?: string }) {
  return (
    <>
      <input type="hidden" name="organizationId" value={organizationId} />
      {caseId && <input type="hidden" name="caseId" value={caseId} />}
    </>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-text-tertiary text-[12px]">{hint}</p>}
    </div>
  );
}

/** A Radix select whose "not chosen" state submits as blank, because Radix
 *  items cannot carry an empty value themselves. */
function OptionalSelect({
  id,
  name,
  defaultValue,
  placeholder,
  options,
  disabled,
}: {
  id: string;
  name: string;
  defaultValue: string | null;
  placeholder: string;
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
}) {
  const [value, setValue] = useState(defaultValue ?? "unset");
  return (
    <>
      <input type="hidden" name={name} value={value === "unset" ? "" : value} />
      <Select value={value} onValueChange={setValue} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unset">{placeholder}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}

const YES_NO = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
] as const;

// ── Start ─────────────────────────────────────────────────────────────

export function StartPreparationForm({ organizationId, years }: { organizationId: string; years: readonly number[] }) {
  const [state, formAction, pending] = useTaxAction(startTaxPreparationAction);
  const [year, setYear] = useState(String(years[years.length - 1]));

  return (
    <form action={formAction} className="flex flex-col items-center gap-3">
      <Ids organizationId={organizationId} />
      <input type="hidden" name="taxYear" value={year} />
      {state.error && <ErrorState title="Couldn't start" description={state.error} />}
      <div className="flex items-center gap-2">
        {years.length > 1 && (
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger aria-label="Tax year" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Starting…" : `Start ${year}`}
        </Button>
      </div>
    </form>
  );
}

// ── Calculate ─────────────────────────────────────────────────────────

export function CalculateForm({ organizationId, caseId, blockerCount }: { organizationId: string; caseId: string; blockerCount: number }) {
  const [state, formAction, pending] = useTaxAction(calculateTaxPreparationAction);
  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <Ids organizationId={organizationId} caseId={caseId} />
      <Button type="submit" disabled={pending} variant={blockerCount > 0 ? "secondary" : "primary"}>
        {pending ? "Calculating…" : "Calculate"}
      </Button>
      {state.error && (
        <p role="alert" className="text-text-secondary max-w-[40ch] text-right text-[13px]">
          {state.error}
        </p>
      )}
    </form>
  );
}

// ── Taxpayer ──────────────────────────────────────────────────────────

/** The action's result, plus how many saves have succeeded on this page. */
type TaxpayerFormState = TaxPreparationActionResult & { savedCount: number };

const FILING_STATUS_OPTIONS: readonly { value: FilingStatus; label: string }[] = [
  { value: "single", label: "Single" },
  { value: "married_filing_jointly", label: "Married filing jointly" },
  { value: "married_filing_separately", label: "Married filing separately" },
  { value: "head_of_household", label: "Head of household" },
  { value: "qualifying_surviving_spouse", label: "Qualifying surviving spouse" },
];

export function TaxpayerForm({
  organizationId,
  caseId,
  filingStatus,
  taxpayer,
  disabled,
}: {
  organizationId: string;
  caseId: string;
  filingStatus: FilingStatus | null;
  taxpayer: TaxpayerProfile;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    async (previous: TaxpayerFormState, formData: FormData): Promise<TaxpayerFormState> => {
      const result = await updateTaxpayerAction({}, formData);
      return { ...result, savedCount: previous.savedCount + (result.success ? 1 : 0) };
    },
    { savedCount: 0 },
  );

  // WHAT THE FIELDS SHOW, AND WHEN THEY CHANGE.
  //
  // Between saves, the fields hold what the person is typing and choosing —
  // they are uncontrolled, and the browser is the only copy of an unsaved edit.
  // The SAVED case is the only other source: the page's props.
  //
  // React's automatic form action resets the form after EVERY submission,
  // failed ones included, and each Radix select answers a reset by restoring
  // the value it was mounted with. That produced two defects: after a
  // successful save the selects showed, and resubmitted, pre-save choices; and
  // after a failed save every change was silently thrown away while the error
  // said the save had failed. So submission is dispatched here instead, inside
  // a transition — React still tracks it as pending, and resets nothing.
  //
  // The fields are keyed on the saved case and on the count of successful
  // saves. A successful save therefore remounts them from exactly what the
  // server stored (normalised values included); a failed save changes neither
  // key, so the person's changes stay in place to be corrected and retried.
  const persisted = JSON.stringify({ filingStatus, taxpayer });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form action={formAction} onSubmit={submit} className="flex flex-col gap-6">
      <Ids organizationId={organizationId} caseId={caseId} />
      {state.error && <ErrorState title="Couldn't save" description={`${state.error} Nothing was saved — your changes are still below, so you can correct them and save again.`} />}

      <Fragment key={`${persisted}#${state.savedCount}`}>
      <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Filing status" htmlFor="filingStatus">
          <OptionalSelect id="filingStatus" name="filingStatus" defaultValue={filingStatus} placeholder="Not chosen" options={FILING_STATUS_OPTIONS} disabled={disabled} />
        </Field>
        <Field label="Legal first name" htmlFor="legalFirstName">
          <Input id="legalFirstName" name="legalFirstName" defaultValue={taxpayer.legalFirstName ?? ""} autoComplete="given-name" />
        </Field>
        <Field label="Legal last name" htmlFor="legalLastName">
          <Input id="legalLastName" name="legalLastName" defaultValue={taxpayer.legalLastName ?? ""} autoComplete="family-name" />
        </Field>
        <Field label="Middle name" htmlFor="legalMiddleName">
          <Input id="legalMiddleName" name="legalMiddleName" defaultValue={taxpayer.legalMiddleName ?? ""} />
        </Field>
        <Field label="Date of birth" htmlFor="dateOfBirth">
          <Input id="dateOfBirth" name="dateOfBirth" type="date" defaultValue={taxpayer.dateOfBirth ?? ""} />
        </Field>
        <Field label="Tax ID type" htmlFor="taxIdentifierType" hint="Which kind you have. Never enter the number.">
          <OptionalSelect
            id="taxIdentifierType"
            name="taxIdentifierType"
            defaultValue={taxpayer.taxIdentifierType}
            placeholder="Not set"
            options={[
              { value: "ssn", label: "Social Security number" },
              { value: "itin", label: "ITIN" },
              { value: "none", label: "None" },
            ]}
            disabled={disabled}
          />
        </Field>
        <Field label="Tax ID on file" htmlFor="taxIdentifierOnFile">
          <OptionalSelect
            id="taxIdentifierOnFile"
            name="taxIdentifierOnFile"
            defaultValue={taxpayer.taxIdentifierOnFile ? "yes" : "no"}
            placeholder="Not set"
            options={YES_NO}
            disabled={disabled}
          />
        </Field>
        <Field label="State" htmlFor="primaryStateRegion" hint="Taken from workspace settings.">
          <Input id="primaryStateRegion" value={taxpayer.primaryStateRegion ?? "Not set"} readOnly aria-readonly="true" />
        </Field>
        <Field label="Other states this year" htmlFor="additionalStateRegions" hint="Two-letter codes, e.g. NY, NJ. Flagged for review, not calculated.">
          <Input id="additionalStateRegions" name="additionalStateRegions" defaultValue={taxpayer.additionalStateRegions.join(", ")} />
        </Field>
      </fieldset>

      <fieldset disabled={disabled} className="border-border-subtle grid gap-4 border-t pt-6 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="text-text-secondary mb-2 text-[11px] font-semibold tracking-[0.08em] uppercase sm:col-span-2 lg:col-span-4">Spouse, if married</legend>
        <Field label="First name" htmlFor="spouseFirstName">
          <Input id="spouseFirstName" name="spouseFirstName" defaultValue={taxpayer.spouseFirstName ?? ""} />
        </Field>
        <Field label="Last name" htmlFor="spouseLastName">
          <Input id="spouseLastName" name="spouseLastName" defaultValue={taxpayer.spouseLastName ?? ""} />
        </Field>
        <Field label="Date of birth" htmlFor="spouseDateOfBirth">
          <Input id="spouseDateOfBirth" name="spouseDateOfBirth" type="date" defaultValue={taxpayer.spouseDateOfBirth ?? ""} />
        </Field>
        <Field label="Tax ID on file" htmlFor="spouseTaxIdentifierOnFile">
          <OptionalSelect
            id="spouseTaxIdentifierOnFile"
            name="spouseTaxIdentifierOnFile"
            defaultValue={taxpayer.spouseTaxIdentifierOnFile ? "yes" : "no"}
            placeholder="Not set"
            options={YES_NO}
            disabled={disabled}
          />
        </Field>
        <Field label="Spouse itemizes deductions" htmlFor="spouseItemizesDeductions" hint="Filing separately only. If yes, the standard deduction isn't allowed.">
          <OptionalSelect
            id="spouseItemizesDeductions"
            name="spouseItemizesDeductions"
            defaultValue={taxpayer.spouseItemizesDeductions === null ? null : taxpayer.spouseItemizesDeductions ? "yes" : "no"}
            placeholder="Not answered"
            options={YES_NO}
            disabled={disabled}
          />
        </Field>
      </fieldset>
      </Fragment>

      {!disabled && (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save details"}
          </Button>
          {state.message && !state.error && <span className="text-text-secondary text-[13px]">{state.message}</span>}
        </div>
      )}
    </form>
  );
}

// ── Facts ─────────────────────────────────────────────────────────────

const FACT_OPTIONS = allFactDefinitions().map((definition) => ({
  value: definition.key,
  // Stated in the picker, before anyone types a figure, so rental income is
  // never entered in the belief it will change the tax.
  label: definition.support === "COLLECTED_NOT_CALCULATED" ? `${definition.label} (recorded, not calculated)` : definition.label,
}));

export function AddFactDialog({
  organizationId,
  caseId,
  currency,
  documents,
}: {
  organizationId: string;
  caseId: string;
  currency: string;
  documents: readonly { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<string>("W2_WAGES");
  const [state, formAction, pending] = useTaxAction(recordFactAction, () => setOpen(false));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          Add figure
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a figure</DialogTitle>
          <DialogDescription>A figure you enter is confirmed and used in the next calculation.</DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          <Ids organizationId={organizationId} caseId={caseId} />
          <input type="hidden" name="key" value={key} />
          {state.error && <ErrorState title="Couldn't add figure" description={state.error} />}

          <Field label="Item" htmlFor="factKey">
            <Select value={key} onValueChange={setKey}>
              <SelectTrigger id="factKey">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FACT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={`Amount (${currency})`} htmlFor="amount">
            <Input id="amount" name="amount" type="text" inputMode="decimal" placeholder="0.00" numeric required />
          </Field>

          <Field label="Supporting document" htmlFor="evidenceDocumentId" hint="Optional. Only documents already uploaded to this workspace.">
            <OptionalSelect
              id="evidenceDocumentId"
              name="evidenceDocumentId"
              defaultValue={null}
              placeholder="None"
              options={documents.map((document) => ({ value: document.id, label: document.name }))}
            />
          </Field>

          <Field label="Note" htmlFor="evidenceNote" hint="e.g. W-2 box 1, Acme Corp. Never a tax ID or account number.">
            <Input id="evidenceNote" name="evidenceNote" maxLength={200} />
          </Field>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add figure"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Confirm or reject a suggestion; withdraw a confirmed figure.
 *
 * Neither deletes anything. Both record a new row saying who decided what, so
 * a suggestion and the person who accepted it stay separately attributable.
 */
export function FactReviewActions({ organizationId, caseId, factId, state: factState }: { organizationId: string; caseId: string; factId: string; state: FactState }) {
  const [state, formAction, pending] = useTaxAction(reviewFactAction);

  return (
    <form action={formAction} className="flex items-center justify-end gap-1.5">
      <Ids organizationId={organizationId} caseId={caseId} />
      <input type="hidden" name="factId" value={factId} />
      {state.error && (
        <span role="alert" className="text-text-secondary mr-2 text-[12px]">
          {state.error}
        </span>
      )}
      {factState === "PROPOSED" && (
        <Button type="submit" name="decision" value="confirm" size="sm" disabled={pending}>
          Confirm
        </Button>
      )}
      <Button type="submit" name="decision" value="reject" size="sm" variant="ghost" disabled={pending}>
        {factState === "PROPOSED" ? "Reject" : "Withdraw"}
      </Button>
    </form>
  );
}

// ── Dependents ────────────────────────────────────────────────────────

export function AddDependentDialog({ organizationId, caseId }: { organizationId: string; caseId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useTaxAction(addDependentAction, () => setOpen(false));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          Add dependent
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a dependent</DialogTitle>
          <DialogDescription>Collected for review. Whether someone qualifies is not decided here.</DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          <Ids organizationId={organizationId} caseId={caseId} />
          {state.error && <ErrorState title="Couldn't add dependent" description={state.error} />}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" htmlFor="dependentFirstName">
              <Input id="dependentFirstName" name="firstName" required />
            </Field>
            <Field label="Last name" htmlFor="dependentLastName">
              <Input id="dependentLastName" name="lastName" required />
            </Field>
            <Field label="Relationship" htmlFor="relationship">
              <Input id="relationship" name="relationship" placeholder="e.g. son, daughter, parent" required />
            </Field>
            <Field label="Date of birth" htmlFor="dependentDateOfBirth">
              <Input id="dependentDateOfBirth" name="dateOfBirth" type="date" />
            </Field>
            <Field label="Months lived with you" htmlFor="monthsLivedWithTaxpayer" hint="0 to 12, in this tax year.">
              <Input id="monthsLivedWithTaxpayer" name="monthsLivedWithTaxpayer" type="number" min={0} max={12} inputMode="numeric" numeric />
            </Field>
            <Field label="Tax ID on file" htmlFor="hasTaxIdentifier">
              <OptionalSelect id="hasTaxIdentifier" name="hasTaxIdentifier" defaultValue="no" placeholder="Not set" options={YES_NO} />
            </Field>
            <Field label="Full-time student" htmlFor="isStudent">
              <OptionalSelect id="isStudent" name="isStudent" defaultValue="no" placeholder="Not set" options={YES_NO} />
            </Field>
            <Field label="Permanently disabled" htmlFor="isDisabled">
              <OptionalSelect id="isDisabled" name="isDisabled" defaultValue="no" placeholder="Not set" options={YES_NO} />
            </Field>
            <Field label="Could someone else claim them?" htmlFor="claimedByAnother">
              <OptionalSelect id="claimedByAnother" name="claimedByAnother" defaultValue="no" placeholder="Not set" options={YES_NO} />
            </Field>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add dependent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveDependentButton({ organizationId, caseId, dependentId }: { organizationId: string; caseId: string; dependentId: string }) {
  const [state, formAction, pending] = useTaxAction(removeDependentAction);
  return (
    <form action={formAction} className="flex items-center justify-end gap-2">
      <Ids organizationId={organizationId} caseId={caseId} />
      <input type="hidden" name="dependentId" value={dependentId} />
      {state.error && (
        <span role="alert" className="text-text-secondary text-[12px]">
          {state.error}
        </span>
      )}
      <Button type="submit" size="sm" variant="ghost" disabled={pending}>
        Remove
      </Button>
    </form>
  );
}
