import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TaxpayerForm } from "@/components/tax-preparation/preparation-forms";
import type { TaxpayerProfile } from "@/domain/tax-preparation/types";
import type { FilingStatus } from "@/domain/tax/rules/types";

/**
 * Renders the REAL TaxpayerForm, with its server actions replaced by
 * `actions-stub.ts`. `saved` plays the part of the server's copy of the case:
 * it changes only when a save succeeds, exactly as the page's props do.
 */

interface Saved {
  filingStatus: FilingStatus | null;
  taxpayer: TaxpayerProfile;
}

declare global {
  interface Window {
    __saved: Saved;
  }
}

const INITIAL: Saved = {
  filingStatus: "single",
  taxpayer: {
    legalFirstName: "Taylor",
    legalMiddleName: null,
    legalLastName: "Synthetic",
    dateOfBirth: "1988-03-14",
    taxIdentifierType: "ssn",
    taxIdentifierOnFile: true,
    primaryStateRegion: "FL",
    additionalStateRegions: ["NY"],
    spouseFirstName: null,
    spouseLastName: null,
    spouseDateOfBirth: null,
    spouseTaxIdentifierOnFile: false,
    spouseItemizesDeductions: null,
  },
};

const blank = (value: string | undefined) => (value ? value : null);

/** The same normalisation the real schema applies, so "saved" means saved. */
function toSaved(fields: Record<string, string>, previous: Saved): Saved {
  return {
    filingStatus: (blank(fields.filingStatus) as FilingStatus | null) ?? null,
    taxpayer: {
      ...previous.taxpayer,
      legalFirstName: blank(fields.legalFirstName?.trim()),
      legalMiddleName: blank(fields.legalMiddleName?.trim()),
      legalLastName: blank(fields.legalLastName?.trim()),
      dateOfBirth: blank(fields.dateOfBirth),
      taxIdentifierType: blank(fields.taxIdentifierType) as TaxpayerProfile["taxIdentifierType"],
      taxIdentifierOnFile: fields.taxIdentifierOnFile === "yes",
      additionalStateRegions: (fields.additionalStateRegions ?? "")
        .split(/[\s,]+/)
        .map((code) => code.trim().toUpperCase())
        .filter(Boolean),
      spouseFirstName: blank(fields.spouseFirstName?.trim()),
      spouseLastName: blank(fields.spouseLastName?.trim()),
      spouseDateOfBirth: blank(fields.spouseDateOfBirth),
      spouseTaxIdentifierOnFile: fields.spouseTaxIdentifierOnFile === "yes",
      spouseItemizesDeductions: fields.spouseItemizesDeductions ? fields.spouseItemizesDeductions === "yes" : null,
    },
  };
}

function Harness() {
  const [saved, setSaved] = useState<Saved>(INITIAL);
  // Test hooks for the spec: read the saved copy, and apply a successful save.
  useEffect(() => {
    window.__saved = saved;
    window.__applySaved = (fields) => setSaved((previous) => toSaved(fields, previous));
  }, [saved]);
  return (
    <TaxpayerForm
      organizationId="11111111-1111-4111-8111-111111111111"
      caseId="22222222-2222-4222-8222-222222222222"
      filingStatus={saved.filingStatus}
      taxpayer={saved.taxpayer}
    />
  );
}

window.__submissions = [];
window.__nextResult = { success: true, message: "Saved." };
createRoot(document.getElementById("root")!).render(<Harness />);
