import { factDefinition } from "@/domain/tax-preparation/facts";
import type { FactSource, FactState, TaxFactKey } from "@/domain/tax-preparation/types";
import { factMappingFor } from "./schemas";
import { PROPOSABLE_REVIEW_STATES, type ClassificationConfidence, type DocumentType, type ExtractionStatus, type FieldReviewState } from "./types";

/**
 * FROM EXTRACTED FIELDS TO PROPOSED TAX FACTS — and never further.
 *
 * Pure. Given an extraction, its fields, the open preparation case and the
 * facts already in it, decides what may be offered to Tax preparation as a
 * PROPOSAL. Writing the proposals, and confirming them, happen elsewhere: the
 * first in a server action, the second only by a person on the Tax
 * preparation page.
 *
 * WHAT IS NEVER DONE
 *
 *   - No confirmed fact is written, changed or replaced.
 *   - A tax year is never assumed. A document without a printed tax year
 *     proposes nothing.
 *   - A currency is never converted. A value in another currency than the
 *     workspace's proposes nothing.
 *   - A value that could not be read (UNREADABLE, MISSING, CONFLICT) proposes
 *     nothing.
 *
 * WHEN A FIGURE ALREADY EXISTS
 *
 *   same document, same key, same amount       MATCHES_EXISTING  — not duplicated
 *   same document, same key, different amount  PROPOSE_CONFLICT  — proposed, and
 *                                               the disagreement is surfaced as a
 *                                               conflict nobody resolves automatically
 *   entered without a document, same amount    MATCHES_EXISTING  — likely the same figure
 *   entered without a document, other amount   PROPOSE_ALONGSIDE — proposed, with a
 *                                               note that both are now present
 */

export interface StoredField {
  id: string;
  extractionId: string;
  documentId: string;
  schemaId: string;
  fieldKey: string;
  label: string;
  box: string | null;
  pageNumber: number | null;
  amountMinor: number | null;
  currency: string | null;
  normalizedDecimal: string | null;
  reviewState: FieldReviewState;
}

export interface ExistingFact {
  id: string;
  key: TaxFactKey;
  amountMinor: number | null;
  currency: string | null;
  state: FactState;
  source: FactSource;
  evidenceDocumentId: string | null;
  evidenceExtractionFieldId: string | null;
}

export type ProposalRelation = "PROPOSE" | "PROPOSE_CONFLICT" | "PROPOSE_ALONGSIDE" | "ALREADY_PROPOSED" | "MATCHES_EXISTING" | "NOT_PROPOSABLE";

export interface ProposalPlanItem {
  fieldId: string;
  fieldKey: string;
  label: string;
  box: string | null;
  factKey: TaxFactKey;
  amountMinor: number | null;
  currency: string | null;
  relation: ProposalRelation;
  /** Safe to show. */
  reason: string;
  relatedFactIds: readonly string[];
}

export interface ProposalPlan {
  /** Why nothing at all can be proposed, if so. */
  blocked: string | null;
  taxYear: number | null;
  items: readonly ProposalPlanItem[];
}

export interface ProposalPlanInput {
  extraction: {
    id: string;
    documentId: string;
    documentType: DocumentType;
    status: ExtractionStatus;
    classificationConfidence: ClassificationConfidence;
    taxYear: number | null;
  };
  fields: readonly StoredField[];
  /** The open preparation case for the document's tax year, if any. */
  preparation: { caseId: string; taxYear: number } | null;
  workspaceCurrency: string | null;
  currentFacts: readonly ExistingFact[];
}

export function willPropose(relation: ProposalRelation): boolean {
  return relation === "PROPOSE" || relation === "PROPOSE_CONFLICT" || relation === "PROPOSE_ALONGSIDE";
}

export function planFactProposals(input: ProposalPlanInput): ProposalPlan {
  const { extraction } = input;
  const mapped = input.fields
    .map((field) => ({ field, factKey: factMappingFor(field.schemaId, field.fieldKey) }))
    .filter((entry): entry is { field: StoredField; factKey: TaxFactKey } => entry.factKey !== null);

  const blocked = (reason: string): ProposalPlan => ({ blocked: reason, taxYear: extraction.taxYear, items: [] });

  if (mapped.length === 0) return blocked("Nothing on this kind of document maps to a Tax preparation figure.");
  if (extraction.status === "UNSUPPORTED") return blocked("Nothing was read from this document.");
  if (extraction.classificationConfidence !== "HIGH" && extraction.classificationConfidence !== "MEDIUM") {
    return blocked("The document type needs review before any figure from it can be proposed.");
  }
  if (extraction.taxYear === null) return blocked("No tax year is printed where one was expected, and none is assumed — so no figure can be proposed.");
  if (!input.preparation) return blocked(`No tax preparation is open for ${extraction.taxYear}. Start one on the Tax preparation page first.`);
  if (input.preparation.taxYear !== extraction.taxYear) return blocked(`This document is for ${extraction.taxYear}, not ${input.preparation.taxYear}.`);
  if (!input.workspaceCurrency) return blocked("This workspace's currency isn't supported for tax preparation.");

  const items = mapped.map(({ field, factKey }): ProposalPlanItem => {
    const base = { fieldId: field.id, fieldKey: field.fieldKey, label: field.label, box: field.box, factKey, amountMinor: field.amountMinor, currency: field.currency };
    const not = (reason: string): ProposalPlanItem => ({ ...base, relation: "NOT_PROPOSABLE", reason, relatedFactIds: [] });

    if (!PROPOSABLE_REVIEW_STATES.includes(field.reviewState)) {
      return not(field.reviewState === "CONFLICT" ? "This value was read differently in different places." : "No value was read for this field.");
    }
    if (field.amountMinor === null || field.currency === null) return not("This amount has no stated currency, so it can't become a tax figure.");
    if (field.currency !== input.workspaceCurrency) return not(`This amount is in ${field.currency}; the workspace uses ${input.workspaceCurrency}. Nothing is converted.`);
    if (field.amountMinor < 0 && !factDefinition(factKey).allowsNegative) return not(`${factDefinition(factKey).label} can't be negative.`);

    const sameKey = input.currentFacts.filter((fact) => fact.key === factKey && fact.state !== "REJECTED");
    const fromThisField = sameKey.filter((fact) => fact.evidenceExtractionFieldId === field.id);
    if (fromThisField.length > 0) return { ...base, relation: "ALREADY_PROPOSED", reason: "Already sent to Tax preparation.", relatedFactIds: fromThisField.map((fact) => fact.id) };

    const fromThisDocument = sameKey.filter((fact) => fact.evidenceDocumentId === extraction.documentId);
    const matching = fromThisDocument.filter((fact) => fact.amountMinor === field.amountMinor && fact.currency === field.currency);
    if (matching.length > 0) {
      return { ...base, relation: "MATCHES_EXISTING", reason: "The same figure from this document is already in Tax preparation.", relatedFactIds: matching.map((fact) => fact.id) };
    }
    const disagreeing = fromThisDocument.filter((fact) => fact.amountMinor !== field.amountMinor);
    if (disagreeing.length > 0) {
      return {
        ...base,
        relation: "PROPOSE_CONFLICT",
        reason: "A different figure from this same document is already in Tax preparation. Both will be shown as conflicting; neither is chosen.",
        relatedFactIds: disagreeing.map((fact) => fact.id),
      };
    }

    const unlinked = sameKey.filter((fact) => fact.evidenceDocumentId === null && fact.state === "CONFIRMED");
    const unlinkedSame = unlinked.filter((fact) => fact.amountMinor === field.amountMinor && fact.currency === field.currency);
    if (unlinkedSame.length > 0) {
      return { ...base, relation: "MATCHES_EXISTING", reason: "A confirmed figure with the same amount was already entered, likely from this document.", relatedFactIds: unlinkedSame.map((fact) => fact.id) };
    }
    if (unlinked.length > 0) {
      return {
        ...base,
        relation: "PROPOSE_ALONGSIDE",
        reason: "Another figure of this kind is already confirmed. If it came from this document, reject one of them in Tax preparation.",
        relatedFactIds: unlinked.map((fact) => fact.id),
      };
    }
    return { ...base, relation: "PROPOSE", reason: "Will be added as a suggestion to review.", relatedFactIds: [] };
  });

  return { blocked: null, taxYear: extraction.taxYear, items };
}

// ── Conflicts between documents ─────────────────────────────────────────

export interface DocumentForConflicts {
  documentId: string;
  documentType: DocumentType;
  taxYear: number | null;
  fields: readonly (Pick<StoredField, "fieldKey" | "normalizedDecimal" | "reviewState"> & { normalizedDate?: string | null })[];
}

export interface CrossDocumentConflict {
  kind: "W2_WAGES_VS_PAY_STUB_YEAR_TO_DATE" | "POSSIBLE_DUPLICATE_DOCUMENT";
  documentIds: readonly [string, string];
  /** Safe to show. */
  message: string;
  values: readonly [string, string] | null;
}

const readable = (field: DocumentForConflicts["fields"][number] | undefined) => Boolean(field && PROPOSABLE_REVIEW_STATES.includes(field.reviewState) && field.normalizedDecimal !== null);

/**
 * Disagreements between documents, surfaced and never resolved.
 *
 * A W-2's box 1 and a December pay stub's year-to-date gross pay commonly
 * differ — pre-tax deductions come out of box 1 — so the difference is shown
 * with that explanation rather than as an error. Which figure is right is a
 * person's decision.
 */
export function detectCrossDocumentConflicts(documents: readonly DocumentForConflicts[]): CrossDocumentConflict[] {
  const conflicts: CrossDocumentConflict[] = [];
  const field = (document: DocumentForConflicts, key: string) => document.fields.find((candidate) => candidate.fieldKey === key);

  const w2s = documents.filter((document) => document.documentType === "W2" && document.taxYear !== null);
  const stubs = documents.filter((document) => document.documentType === "PAY_STUB");

  for (const w2 of w2s) {
    const wages = field(w2, "box1_wages");
    if (!readable(wages)) continue;
    for (const stub of stubs) {
      const payDate = field(stub, "pay_date")?.normalizedDate ?? null;
      const ytd = field(stub, "gross_pay_ytd");
      if (!payDate || !readable(ytd)) continue;
      // Only a year-end stub's year-to-date figure describes the whole year.
      if (Number(payDate.slice(0, 4)) !== w2.taxYear || payDate.slice(5, 7) !== "12") continue;
      if (ytd!.normalizedDecimal === wages!.normalizedDecimal) continue;
      conflicts.push({
        kind: "W2_WAGES_VS_PAY_STUB_YEAR_TO_DATE",
        documentIds: [w2.documentId, stub.documentId],
        values: [wages!.normalizedDecimal!, ytd!.normalizedDecimal!],
        message: "The W-2's box 1 wages differ from the December pay stub's year-to-date gross pay. Pre-tax deductions often explain this, but neither figure is chosen automatically.",
      });
    }
  }

  const byTypeAndYear = new Map<string, DocumentForConflicts[]>();
  for (const document of documents) {
    if (document.taxYear === null || !document.documentType.startsWith("FORM_") && document.documentType !== "W2") continue;
    const key = `${document.documentType}:${document.taxYear}`;
    byTypeAndYear.set(key, [...(byTypeAndYear.get(key) ?? []), document]);
  }
  for (const group of byTypeAndYear.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i].fields.filter(readable);
        const b = group[j].fields.filter(readable);
        if (a.length < 2 || a.length !== b.length) continue;
        const same = a.every((fieldA) => b.some((fieldB) => fieldB.fieldKey === fieldA.fieldKey && fieldB.normalizedDecimal === fieldA.normalizedDecimal));
        if (same) {
          conflicts.push({
            kind: "POSSIBLE_DUPLICATE_DOCUMENT",
            documentIds: [group[i].documentId, group[j].documentId],
            values: null,
            message: "Two documents of the same type and year carry identical figures. If one is a duplicate upload, only one should be used.",
          });
        }
      }
    }
  }
  return conflicts;
}
