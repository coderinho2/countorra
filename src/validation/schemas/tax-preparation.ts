import { z } from "zod";
import { allFactDefinitions } from "@/domain/tax-preparation/facts";
import type { TaxFactKey } from "@/domain/tax-preparation/types";

/**
 * What the tax preparation forms may send.
 *
 * Every field arrives from a browser and is a claim, not a fact. Two things
 * are refused here rather than later, because later is too late:
 *
 *   A TAX IDENTIFIER IN A FREE-TEXT FIELD. Countorra does not store SSNs or
 *   ITINs — the schema has no column for one. But a name field or an evidence
 *   note would happily hold "123-45-6789" if someone typed it there, and from
 *   that moment it is in the database, in backups and potentially in an audit
 *   trail. So anything shaped like one is rejected with a message saying why.
 *
 *   A TAX YEAR, STATE OR JURISDICTION CHOSEN BY THE CLIENT FOR CALCULATION.
 *   The year is fixed when a case is created; the jurisdiction is derived from
 *   the organization. Nothing below lets a request move either.
 */

const FILING_STATUSES = ["single", "married_filing_jointly", "married_filing_separately", "head_of_household", "qualifying_surviving_spouse"] as const;

const FACT_KEYS = allFactDefinitions().map((definition) => definition.key) as [TaxFactKey, ...TaxFactKey[]];

/** Nine digits in the SSN/ITIN layout, with or without separators. Broad on
 *  purpose: refusing a nine-digit reference number by mistake costs a retype,
 *  and letting a real identifier through cannot be undone. */
const TAX_IDENTIFIER_PATTERN = /(?<!\d)\d{3}[-\s.]?\d{2}[-\s.]?\d{4}(?!\d)/;
const NO_IDENTIFIER_MESSAGE = "Don't enter a Social Security number or other tax ID here. Countorra never stores the number itself.";

const noIdentifier = (value: string | null) => value === null || !TAX_IDENTIFIER_PATTERN.test(value);

/** Blank means absent. Trimmed, bounded, and never an identifier. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : null))
    .refine(noIdentifier, NO_IDENTIFIER_MESSAGE);

const requiredText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(max)
    .refine((value) => !TAX_IDENTIFIER_PATTERN.test(value), NO_IDENTIFIER_MESSAGE);

const optionalDate = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : null))
  .refine((value) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value), "Use a date in the form YYYY-MM-DD.");

const yesNo = z
  .enum(["yes", "no", "on", ""])
  .optional()
  .transform((value) => value === "yes" || value === "on");

const blankToNull = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => (value === "" || value === undefined ? null : value), schema.nullable());

/** A plain decimal in major units. A leading minus is accepted here and
 *  checked against the fact's own `allowsNegative` rule in the action, where
 *  the message can name the fact. */
const amount = z.string().trim().regex(/^-?\d{1,12}(\.\d{1,2})?$/, "Enter an amount such as 85000 or 85000.00.");

const ids = { organizationId: z.uuid(), caseId: z.uuid() };

export const startTaxPreparationSchema = z.object({
  organizationId: z.uuid(),
  taxYear: z.coerce.number().int().min(2000).max(2100),
});

export const updateTaxpayerSchema = z.object({
  ...ids,
  filingStatus: blankToNull(z.enum(FILING_STATUSES)),
  legalFirstName: optionalText(100),
  legalMiddleName: optionalText(100),
  legalLastName: optionalText(100),
  dateOfBirth: optionalDate,
  taxIdentifierType: blankToNull(z.enum(["ssn", "itin", "none"])),
  taxIdentifierOnFile: yesNo,
  additionalStateRegions: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(/[\s,]+/)
        .map((code) => code.trim().toUpperCase())
        .filter(Boolean),
    )
    .refine((codes) => codes.every((code) => /^[A-Z]{2}$/.test(code)), "Use two-letter state codes, separated by commas.")
    .refine((codes) => codes.length <= 10, "List at most ten additional states."),
  spouseFirstName: optionalText(100),
  spouseLastName: optionalText(100),
  spouseDateOfBirth: optionalDate,
  spouseTaxIdentifierOnFile: yesNo,
  // Three states, not two: blank is "not answered", which is not the same as
  // "no" — only an explicit no lets the standard deduction stand.
  spouseItemizesDeductions: blankToNull(z.enum(["yes", "no"])).transform((value) => (value === null ? null : value === "yes")),
});

export const recordFactSchema = z.object({
  ...ids,
  key: z.enum(FACT_KEYS),
  amount,
  evidenceDocumentId: blankToNull(z.uuid()),
  evidenceNote: optionalText(200),
});

export const reviewFactSchema = z.object({
  ...ids,
  factId: z.uuid(),
  decision: z.enum(["confirm", "reject"]),
  correctedAmount: blankToNull(amount),
});

export const addDependentSchema = z.object({
  ...ids,
  firstName: requiredText(100, "First name"),
  lastName: requiredText(100, "Last name"),
  relationship: requiredText(60, "Relationship"),
  dateOfBirth: optionalDate,
  monthsLivedWithTaxpayer: blankToNull(z.coerce.number().int().min(0).max(12)),
  isStudent: yesNo,
  isDisabled: yesNo,
  hasTaxIdentifier: yesNo,
  claimedByAnother: yesNo,
});

export const removeDependentSchema = z.object({ ...ids, dependentId: z.uuid() });

export const caseActionSchema = z.object(ids);

export { TAX_IDENTIFIER_PATTERN };
