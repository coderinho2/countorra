import { z } from "zod";

/**
 * Tax filing form input.
 *
 * Every field here is a CLAIM from a browser. Ids are pointers the server
 * re-checks against the database; nothing in a form can set a status, a
 * readiness result, a tax year or a package.
 */

const uuid = z.uuid("That isn't a valid reference.");

export const startFilingSchema = z.object({ organizationId: uuid }).strict();

export const filingActionSchema = z.object({ organizationId: uuid, filingCaseId: uuid }).strict();

/** A jurisdiction code or USPS state code a person was shown as excluded. */
const EXCLUSION = /^(US_[A-Z]{2,7}|[A-Z]{2}|STATE)$/;

export const finalizeFilingSchema = z
  .object({
    organizationId: uuid,
    filingCaseId: uuid,
    snapshotId: uuid,
    scope: z.enum(["FULL", "FEDERAL_ONLY"]),
    /** Typed, so finalization is never one stray click. */
    confirmation: z.literal("FINALIZE", { error: "Type FINALIZE to confirm." }),
    acknowledged: z.literal("yes", { error: "Confirm that you have reviewed the warnings and limitations." }),
    excludedJurisdictions: z
      .string()
      .max(200)
      .transform((value) =>
        value
          .split(",")
          .map((code) => code.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(EXCLUSION, "That excluded state isn't recognised.")).max(10)),
  })
  .strict();

export const exportFormatSchema = z.enum(["json", "csv", "txt"]);
