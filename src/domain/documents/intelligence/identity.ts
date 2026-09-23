import { z } from "zod";
import { containsSsnLike, findDate, sanitizeText } from "./normalization";
import type { ExtractedFieldDraft, ExtractionWarning, FieldReviewState } from "./types";

/**
 * AMAZON TEXTRACT ANALYZEID, NORMALIZED — and mostly, deliberately, discarded.
 *
 * WHAT TEXTRACT SUPPORTS, EXACTLY
 *
 * AnalyzeID reads US driver's licences and US passports. Nothing else. It does
 * NOT read Social Security cards, state ID cards, or any non-US document, so
 * this module never claims to: an SSN card is classified, held privately and
 * read by no structured operation at all (see ./classification.ts).
 *
 * THE RETENTION DECISION, WHICH IS THE IMPORTANT PART OF THIS FILE
 *
 * Textract returns a licence's full name, date of birth, address, document
 * number and — on a passport — the MRZ, which encodes the passport number in
 * a machine-readable line. Countorra has NO implemented feature that consumes
 * any of it. Tax preparation asks a person for their filing status and their
 * dependents directly; it has never ingested an identity document, and it
 * stores no SSN (migration 0043).
 *
 * Storing those fields anyway — because the provider happened to return them
 * — would create a database of government identifiers to serve a feature that
 * does not exist. So this module keeps the smallest set that lets a person
 * confirm the right document is on file, and throws the rest away before it
 * reaches storage:
 *
 *   KEPT      document class, issuing state, issue and expiry dates, and
 *             whether a document number was present, with its last four
 *             digits so the person can tell two licences apart
 *   DISCARDED full name, date of birth, address, county, place of birth,
 *             the full document number, the MRZ, endorsements, restrictions,
 *             veteran status — every field not in the kept list
 *
 * An SSN is stricter still: no digits of one are ever retained, not even the
 * last four, in any field of any document class. `redactIdentifier` enforces
 * that and `assertNoIdentifiers` is the belt-and-braces check that runs over
 * everything this module is about to return.
 *
 * WHY NONE OF THIS IS PROPOSABLE
 *
 * Every field produced here carries this module's own schema id, and
 * ./schemas.ts maps no field of it to a tax fact. So `planFactProposals`
 * finds nothing to propose — not because it filters identity out, but
 * because there is no mapping to find. An identity document cannot move
 * money or change a figure by construction, rather than by a check someone
 * has to remember to write.
 */

// ── The provider payload, treated as untrusted input ────────────────────

const idDetectionSchema = z
  .object({
    text: z.string().max(500).nullable(),
    /** 0–1. The adapter converts from Textract's 0–100. */
    confidence: z.number().min(0).max(1).nullable(),
    /** Textract's own ISO-8601 reading of a date, when it managed one. */
    normalizedValue: z.string().max(64).nullable(),
  })
  .strict();

export const identityPayloadSchema = z
  .object({
    fields: z
      .array(
        z
          .object({
            type: z.string().max(64).nullable(),
            value: idDetectionSchema.nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export type IdentityPayload = z.infer<typeof identityPayloadSchema>;

export const IDENTITY_SCHEMA_ID = "textract-identity.2026.1";

/**
 * The only AnalyzeID field types that may become stored fields.
 *
 * An allowlist, not a denylist: a field type AWS adds in a later model
 * version is dropped by default rather than silently persisted because nobody
 * updated a list of things to exclude.
 */
const KEPT_FIELDS: Readonly<Record<string, { key: string; label: string; kind: ExtractedFieldDraft["valueKind"] }>> = {
  ID_TYPE: { key: "document_class", label: "Document", kind: "TEXT" },
  STATE_NAME: { key: "issuing_state", label: "Issuing state", kind: "TEXT" },
  STATE_IN_ADDRESS: { key: "issuing_state", label: "Issuing state", kind: "TEXT" },
  EXPIRATION_DATE: { key: "expires_on", label: "Expires", kind: "DATE" },
  DATE_OF_ISSUE: { key: "issued_on", label: "Issued", kind: "DATE" },
  /** Recorded as PRESENCE. The number itself is never stored. */
  DOCUMENT_NUMBER: { key: "document_number_present", label: "Document number", kind: "PRESENCE" },
};

/**
 * Field types this module explicitly refuses, named so the refusal is a
 * decision in the code rather than an accident of the allowlist.
 *
 * MRZ_CODE matters more than it looks: the two machine-readable lines at the
 * foot of a passport contain the passport number, the date of birth and the
 * expiry, so storing "just the MRZ" would store everything this module exists
 * to avoid storing.
 */
export const DISCARDED_FIELDS: readonly string[] = [
  "FIRST_NAME",
  "MIDDLE_NAME",
  "LAST_NAME",
  "SUFFIX",
  "DATE_OF_BIRTH",
  "ADDRESS",
  "CITY_IN_ADDRESS",
  "ZIP_CODE_IN_ADDRESS",
  "COUNTY",
  "PLACE_OF_BIRTH",
  "MRZ_CODE",
  "ENDORSEMENTS",
  "RESTRICTIONS",
  "CLASS",
  "VETERAN",
];

/** Digits of a document number kept, so two licences can be told apart. */
export const IDENTIFIER_TAIL_DIGITS = 4;

/**
 * What a stored identifier looks like: a mask and at most the last four
 * digits — never the value.
 *
 * An SSN-shaped input returns a mask with NO digits at all. The last four of
 * an SSN are the part most often used to verify identity over the phone, so
 * they are the part least worth keeping.
 */
export function redactIdentifier(raw: string): { display: string; present: true } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (containsSsnLike(trimmed)) return { display: "•••••••••", present: true };
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < IDENTIFIER_TAIL_DIGITS) return { display: "••••", present: true };
  return { display: `••••${digits.slice(-IDENTIFIER_TAIL_DIGITS)}`, present: true };
}

function reviewStateFor(confidence: number | null): FieldReviewState {
  if (confidence === null) return "LOW_CONFIDENCE";
  if (confidence >= 0.95) return "HIGH_CONFIDENCE";
  if (confidence >= 0.85) return "MEDIUM_CONFIDENCE";
  return "LOW_CONFIDENCE";
}

export interface IdentityNormalization {
  fields: ExtractedFieldDraft[];
  warnings: ExtractionWarning[];
  /** Field types the provider returned that were deliberately not stored.
   *  Types only — never their values — so the decision is auditable. */
  discarded: string[];
}

export function normalizeIdentity(payload: IdentityPayload): IdentityNormalization {
  const warnings = new Set<ExtractionWarning>(["IDENTITY_DOCUMENT"]);
  const fields: ExtractedFieldDraft[] = [];
  const discarded: string[] = [];
  const seen = new Set<string>();

  for (const field of payload.fields) {
    const type = field.type?.trim().toUpperCase() ?? null;
    const raw = field.value?.text?.trim() ?? "";
    if (!type) continue;

    const kept = KEPT_FIELDS[type];
    if (!kept) {
      if (raw.length > 0) discarded.push(type);
      continue;
    }
    if (raw.length === 0 || seen.has(kept.key)) continue;
    seen.add(kept.key);

    const confidence = field.value?.confidence ?? null;
    const base: ExtractedFieldDraft = {
      schemaId: IDENTITY_SCHEMA_ID,
      fieldKey: kept.key,
      label: kept.label,
      section: "IDENTITY",
      box: null,
      valueKind: kept.kind,
      rawValue: null,
      normalizedDecimal: null,
      amountMinor: null,
      currency: null,
      currencySource: null,
      normalizedDate: null,
      normalizedText: null,
      reviewState: reviewStateFor(confidence),
      reviewReason: null,
      providerConfidence: confidence,
      pageNumber: null,
      lineIndex: null,
      position: null,
      method: "textract-identity/field",
    };

    if (kept.kind === "PRESENCE") {
      const redacted = redactIdentifier(raw);
      if (!redacted) continue;
      warnings.add("IDENTIFIERS_NOT_STORED");
      fields.push({ ...base, rawValue: redacted.display, normalizedText: redacted.display });
      continue;
    }

    if (kept.kind === "DATE") {
      // Textract's own ISO reading is preferred when it produced one; the
      // printed text is only a fallback, and a date that cannot be read is
      // left absent rather than guessed.
      const iso = isoDate(field.value?.normalizedValue ?? null) ?? findDate(raw, "MONTH_FIRST")?.iso ?? null;
      if (!iso) continue;
      fields.push({ ...base, rawValue: iso, normalizedDate: iso });
      continue;
    }

    // A document class or a state name. Short, non-identifying, and still
    // passed through the same sanitizer as everything else.
    const text = sanitizeText(raw, 64);
    if (containsSsnLike(text) || /\d{5,}/.test(text)) {
      // Not what this field is supposed to contain. Dropped rather than
      // stored on the chance that it is harmless.
      discarded.push(type);
      continue;
    }
    fields.push({ ...base, rawValue: text, normalizedText: text });
  }

  if (discarded.length > 0) warnings.add("IDENTIFIERS_NOT_STORED");
  assertNoIdentifiers(fields);
  return { fields, warnings: [...warnings], discarded: [...new Set(discarded)] };
}

/**
 * The last line of defence, run over everything this module returns.
 *
 * It exists because every protection above is a rule someone could later
 * edit. This one throws, so a change that would persist an identifier fails
 * loudly in the test suite instead of quietly in production. The thrown
 * message names no value.
 */
export function assertNoIdentifiers(fields: readonly ExtractedFieldDraft[]): void {
  for (const field of fields) {
    for (const value of [field.rawValue, field.normalizedText]) {
      if (!value) continue;
      if (containsSsnLike(value)) throw new Error(`identity normalization produced an SSN-shaped value in ${field.fieldKey}`);
      const digits = value.replace(/\D/g, "");
      if (digits.length > IDENTIFIER_TAIL_DIGITS && field.valueKind !== "DATE") {
        throw new Error(`identity normalization produced ${digits.length} digits in ${field.fieldKey}, which is more than a masked tail`);
      }
    }
  }
}

function isoDate(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  // Round-tripped, so 2026-02-31 is refused rather than silently rolled into
  // March by the Date constructor.
  return date.toISOString().slice(0, 10) === `${year}-${month}-${day}` ? `${year}-${month}-${day}` : null;
}
