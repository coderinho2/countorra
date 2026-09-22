"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updateOrganizationAction } from "@/server/settings/actions";
import type { Organization } from "@/domain/organizations/types";
import { SUPPORTED_STATES, isSupportedState } from "@/domain/tax/supported-states";

export function OrganizationForm({ organization, canEdit }: { organization: Organization; canEdit: boolean }) {
  const [state, formAction, pending] = useActionState(updateOrganizationAction, {});

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="organizationId" value={organization.id} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" defaultValue={organization.name} disabled={!canEdit} required />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="country">Country</Label>
          <Input id="country" name="country" defaultValue={organization.country} maxLength={2} className="uppercase" disabled={!canEdit} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="stateRegion">State</Label>
          {/* One of the supported states (src/domain/tax/supported-states.ts);
              the server validates it again and audits a change. Keyed on the
              saved value: a React 19 form action resets the form, and Radix
              Select would otherwise restore the value it mounted with. An
              unset or no-longer-supported state shows the placeholder, never
              a guess. */}
          <Select
            key={organization.stateRegion ?? "unset"}
            name="stateRegion"
            defaultValue={isSupportedState(organization.stateRegion) ? organization.stateRegion : undefined}
            disabled={!canEdit}
            required
          >
            <SelectTrigger id="stateRegion">
              <SelectValue placeholder="Choose your state" />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_STATES.map((option) => (
                <SelectItem key={option.code} value={option.code}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="baseCurrency">Currency</Label>
          <Input id="baseCurrency" name="baseCurrency" defaultValue={organization.baseCurrency} maxLength={3} className="uppercase" disabled={!canEdit} required />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="taxIdentifierType">Tax ID type</Label>
          <Select name="taxIdentifierType" defaultValue={organization.taxIdentifierType ?? undefined} disabled={!canEdit}>
            <SelectTrigger id="taxIdentifierType">
              <SelectValue placeholder="Not set" />
            </SelectTrigger>
            <SelectContent>
              {/* An EIN identifies an employer or business; a person files
                  under an SSN or ITIN. Shown only where one is already
                  stored, so a workspace created before the personal-only
                  launch still displays its value. */}
              {organization.taxIdentifierType === "ein" && <SelectItem value="ein">EIN</SelectItem>}
              <SelectItem value="ssn">SSN</SelectItem>
              <SelectItem value="itin">ITIN</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="taxIdentifier">Tax ID</Label>
          <Input id="taxIdentifier" name="taxIdentifier" defaultValue={organization.taxIdentifier ?? ""} disabled={!canEdit} placeholder="e.g. 12-3456789" />
        </div>
      </div>

      {canEdit && (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending} className="w-fit">
            {pending ? "Saving…" : "Save"}
          </Button>
          {state.success && <span className="text-[13px] text-positive">Saved.</span>}
          {state.error && <span className="text-[13px] text-negative">{state.error}</span>}
        </div>
      )}
    </form>
  );
}
