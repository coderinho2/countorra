"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updateOrganizationAction } from "@/server/settings/actions";
import type { Organization } from "@/domain/organizations/types";

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
          {/* Optional, and left blank for the nine states with no individual
              income tax. Nothing is inferred from the country — a workspace
              is only in a state tax regime because it says it is. */}
          <Input
            id="stateRegion"
            name="stateRegion"
            defaultValue={organization.stateRegion ?? ""}
            maxLength={2}
            className="uppercase"
            placeholder="—"
            disabled={!canEdit}
          />
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
