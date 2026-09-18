import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { VerifiedMimeType } from "@/domain/documents/file-signature";
import { buildDocumentExplanation } from "@/domain/documents/intelligence/explain";
import { detectCrossDocumentConflicts, planFactProposals, type CrossDocumentConflict, type ProposalPlan } from "@/domain/documents/intelligence/proposals";
import { resolveProvider } from "@/domain/documents/intelligence/provider";
import { isSupportedCurrency } from "@/domain/money/currency";
import { getVisibleDocument, listDocuments, type AppDocument } from "@/server/db/repositories/documents";
import {
  latestProcessingByDocument,
  listExtractionsForDocument,
  listFieldsForExtraction,
  listFieldsForExtractions,
  listJobsForDocument,
  type ProcessingJob,
  type StoredExtractedField,
  type StoredExtraction,
} from "@/server/db/repositories/document-intelligence";
import { getOrganization } from "@/server/db/repositories/organizations";
import { findLivePreparationCase, listCurrentFacts, listFactsForDocument } from "@/server/db/repositories/tax-preparation";
import { configuredProviders } from "./providers";

type Client = SupabaseClient<Database>;

/**
 * Everything about one document's intelligence, assembled once — for the
 * document page and for the assistant alike, so neither develops its own
 * answer to "what was read, and what happened to it?".
 *
 * Read entirely through the caller's RLS-scoped client.
 */

export type PreparationState = "PROPOSED" | "CONFIRMED" | "REJECTED";

export interface DocumentIntelligence {
  document: AppDocument;
  reader: { available: boolean; message: string | null; method: string | null; providerId: string | null; providerVersion: string | null };
  jobs: readonly ProcessingJob[];
  latestJob: ProcessingJob | null;
  extractions: readonly StoredExtraction[];
  extraction: StoredExtraction | null;
  fields: readonly StoredExtractedField[];
  /** Current Tax preparation state of the figure proposed from each field. */
  preparationStateByField: ReadonlyMap<string, PreparationState>;
  proposalPlan: ProposalPlan | null;
  conflicts: readonly CrossDocumentConflict[];
}

export async function loadDocumentIntelligence(client: Client, organizationId: string, documentId: string): Promise<DocumentIntelligence | null> {
  const document = await getVisibleDocument(client, documentId);
  if (!document || document.organizationId !== organizationId) return null;

  const availability = resolveProvider((document.mimeType ?? "application/octet-stream") as VerifiedMimeType, configuredProviders());
  const [jobs, extractions, documentFacts] = await Promise.all([
    listJobsForDocument(client, documentId),
    listExtractionsForDocument(client, documentId),
    listFactsForDocument(client, organizationId, documentId),
  ]);
  const extraction = extractions[0] ?? null;
  const fields = extraction ? await listFieldsForExtraction(client, extraction.id) : [];

  // The current state of each proposal chain: the row nothing supersedes.
  const superseded = new Set(documentFacts.map((fact) => fact.supersedesFactId).filter((id): id is string => id !== null));
  const preparationStateByField = new Map<string, PreparationState>();
  for (const fact of documentFacts) {
    if (!fact.evidenceExtractionFieldId || superseded.has(fact.id)) continue;
    preparationStateByField.set(fact.evidenceExtractionFieldId, fact.state);
  }

  let proposalPlan: ProposalPlan | null = null;
  if (extraction) {
    const organization = await getOrganization(client, organizationId);
    const live = extraction.taxYear !== null ? await findLivePreparationCase(client, organizationId, extraction.taxYear) : null;
    const currentFacts = live ? await listCurrentFacts(client, live.id) : [];
    proposalPlan = planFactProposals({
      extraction: {
        id: extraction.id,
        documentId,
        documentType: extraction.documentType,
        status: extraction.status,
        classificationConfidence: extraction.classificationConfidence,
        taxYear: extraction.taxYear,
      },
      fields,
      preparation: live ? { caseId: live.id, taxYear: live.taxYear } : null,
      workspaceCurrency: organization && isSupportedCurrency(organization.baseCurrency) ? organization.baseCurrency : null,
      currentFacts: currentFacts.map((fact) => ({
        id: fact.id,
        key: fact.key,
        amountMinor: fact.amountMinor,
        currency: fact.currency,
        state: fact.state,
        source: fact.source,
        evidenceDocumentId: fact.evidenceDocumentId,
        evidenceExtractionFieldId: fact.evidenceExtractionFieldId ?? null,
      })),
    });
  }

  const conflicts = (await loadCrossDocumentConflicts(client, organizationId)).filter((conflict) => conflict.documentIds.includes(documentId));

  return {
    document,
    reader: availability.available
      ? { available: true, message: null, method: availability.provider.method, providerId: availability.provider.id, providerVersion: availability.provider.version }
      : { available: false, message: availability.message, method: null, providerId: null, providerVersion: null },
    jobs,
    latestJob: jobs[0] ?? null,
    extractions,
    extraction,
    fields,
    preparationStateByField,
    proposalPlan,
    conflicts,
  };
}

/** Conflicts across this organization's most recent extractions. Bounded. */
export async function loadCrossDocumentConflicts(client: Client, organizationId: string): Promise<CrossDocumentConflict[]> {
  const documents = (await listDocuments(client, organizationId)).slice(0, 100);
  const processing = await latestProcessingByDocument(client, organizationId, documents.map((document) => document.id));
  const extractions = [...processing.values()].map((entry) => entry.extraction).filter((extraction): extraction is StoredExtraction => extraction !== null);
  const relevant = extractions.filter((extraction) => ["W2", "PAY_STUB"].includes(extraction.documentType) || extraction.documentType.startsWith("FORM_"));
  if (relevant.length < 2) return [];

  const fields = await listFieldsForExtractions(client, organizationId, relevant.map((extraction) => extraction.id));
  return detectCrossDocumentConflicts(
    relevant.map((extraction) => ({
      documentId: extraction.documentId,
      documentType: extraction.documentType,
      taxYear: extraction.taxYear,
      fields: fields.filter((field) => field.extractionId === extraction.id),
    })),
  );
}

/** The assistant's view: structured, bounded, and labelled as document data. */
export async function explainDocumentForAssistant(client: Client, organizationId: string, documentId: string) {
  const intelligence = await loadDocumentIntelligence(client, organizationId, documentId);
  if (!intelligence) return { available: false, message: "No document with that id is visible in this workspace." };

  return buildDocumentExplanation({
    document: { id: intelligence.document.id, kind: intelligence.document.kind },
    readerAvailable: intelligence.reader.available,
    readerUnavailableMessage: intelligence.reader.message,
    latestJob: intelligence.latestJob
      ? { status: intelligence.latestJob.status, attempts: intelligence.latestJob.attempts, maxAttempts: intelligence.latestJob.maxAttempts, failureMessage: intelligence.latestJob.failureMessage }
      : null,
    extraction: intelligence.extraction
      ? {
          id: intelligence.extraction.id,
          version: intelligence.extraction.version,
          status: intelligence.extraction.status,
          documentType: intelligence.extraction.documentType,
          classificationConfidence: intelligence.extraction.classificationConfidence,
          classificationReviewReason: intelligence.extraction.classificationReviewReason,
          taxYear: intelligence.extraction.taxYear,
          method: intelligence.extraction.method,
          warnings: intelligence.extraction.warnings,
          createdAt: intelligence.extraction.createdAt,
        }
      : null,
    fields: intelligence.fields,
    preparationStateByField: intelligence.preparationStateByField,
    conflicts: intelligence.conflicts,
  });
}
