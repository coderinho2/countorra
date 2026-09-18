import type { TaxJurisdiction } from "@/domain/tax/rules/types";
import { FILING_TAX_YEAR } from "./types";

/**
 * THE FILING REQUIREMENT REGISTER.
 *
 * A real return has requirements a preparation record does not: an
 * identification number, a signature or electronic authorization, specific
 * form lines. It would be easy to encode the familiar ones from memory, and
 * that is exactly what this register exists to prevent.
 *
 * THE RULE
 *
 * A requirement may only be ENFORCED when an official 2026 publication — the
 * IRS or the state taxing authority — has been opened and read, and its
 * source, locator and retrieval date recorded here. None has been, so every
 * entry below is SOURCE_UNVERIFIED, carries no URL, and is NOT_ENFORCED. The
 * readiness engine surfaces them as information; it never blocks on them and
 * never presents them as established.
 *
 * `source` is null rather than a plausible-looking link. A URL that was never
 * opened is a fabricated citation, whatever domain it points at.
 */

export type RequirementSourceStatus = "VERIFIED" | "SOURCE_UNVERIFIED";

export interface FilingRequirement {
  id: string;
  jurisdiction: TaxJurisdiction;
  taxYear: number;
  description: string;
  sourceStatus: RequirementSourceStatus;
  /** Required when VERIFIED; null otherwise. */
  source: { title: string; url: string; retrievedOn: string; locator: string } | null;
  enforcement: "ENFORCED" | "NOT_ENFORCED";
  /** What Countorra does about it today. */
  implementation: string;
}

export const FILING_REQUIREMENTS: readonly FilingRequirement[] = [
  {
    id: "FEDERAL_TAXPAYER_IDENTIFICATION_NUMBER",
    jurisdiction: "US_FEDERAL",
    taxYear: FILING_TAX_YEAR,
    description: "The identification numbers a 2026 federal return must carry for the taxpayer, spouse and dependents.",
    sourceStatus: "SOURCE_UNVERIFIED",
    source: null,
    enforcement: "NOT_ENFORCED",
    implementation: "Countorra records only whether an SSN or ITIN exists. No number is collected or stored, and readiness does not decide what a 2026 return requires.",
  },
  {
    id: "FEDERAL_SIGNATURE_OR_ELECTRONIC_AUTHORIZATION",
    jurisdiction: "US_FEDERAL",
    taxYear: FILING_TAX_YEAR,
    description: "How a 2026 federal return is signed or electronically authorized.",
    sourceStatus: "SOURCE_UNVERIFIED",
    source: null,
    enforcement: "NOT_ENFORCED",
    implementation: "Not collected. Finalization is a confirmation inside Countorra, not a signature on a return.",
  },
  {
    id: "FEDERAL_2026_FORM_LINE_MAPPING",
    jurisdiction: "US_FEDERAL",
    taxYear: FILING_TAX_YEAR,
    description: "Which line of the 2026 federal return each figure belongs on.",
    sourceStatus: "SOURCE_UNVERIFIED",
    source: null,
    enforcement: "NOT_ENFORCED",
    implementation: "Mapping is PENDING. The filing package names concepts, never line numbers, and copies nothing from 2025 forms.",
  },
  {
    id: "FEDERAL_2026_TAX_TABLE",
    jurisdiction: "US_FEDERAL",
    taxYear: FILING_TAX_YEAR,
    description: "Whether a 2026 return computes tax from a published tax table rather than the rate schedule, and below which taxable income.",
    sourceStatus: "SOURCE_UNVERIFIED",
    source: null,
    enforcement: "NOT_ENFORCED",
    implementation: "The federal engine applies the verified 2026 rate schedule. Readiness discloses that a filed return may compute tax differently.",
  },
  {
    id: "CALIFORNIA_2026_RESIDENT_RETURN",
    jurisdiction: "US_CA",
    taxYear: FILING_TAX_YEAR,
    description: "The form and requirements of a 2026 California resident return.",
    sourceStatus: "SOURCE_UNVERIFIED",
    source: null,
    enforcement: "NOT_ENFORCED",
    implementation: "No California form is generated. California 2026 is an estimate under 2025 published rules and cannot be ready for filing.",
  },
  {
    id: "NEW_YORK_2026_RESIDENT_RETURN",
    jurisdiction: "US_NY",
    taxYear: FILING_TAX_YEAR,
    description: "The form and requirements of a 2026 New York State resident return.",
    sourceStatus: "SOURCE_UNVERIFIED",
    source: null,
    enforcement: "NOT_ENFORCED",
    implementation: "No New York form is generated. The package reports the New York engine's 2026 result and its disclosed limitations.",
  },
  {
    id: "ARIZONA_2026_RESIDENT_RETURN",
    jurisdiction: "US_AZ",
    taxYear: FILING_TAX_YEAR,
    description: "The form and requirements of a 2026 Arizona resident return.",
    sourceStatus: "SOURCE_UNVERIFIED",
    source: null,
    enforcement: "NOT_ENFORCED",
    implementation: "No Arizona form is generated. Arizona's 2026 rules are not published, so no Arizona figure exists to prepare.",
  },
];

export function unverifiedRequirementIds(): readonly string[] {
  return FILING_REQUIREMENTS.filter((requirement) => requirement.enforcement === "NOT_ENFORCED").map((requirement) => requirement.id);
}

export function requirementById(id: string): FilingRequirement | undefined {
  return FILING_REQUIREMENTS.find((requirement) => requirement.id === id);
}
