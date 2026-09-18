"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/server/supabase/server";
import { createAdminClient } from "@/server/supabase/admin";
import { requireOrgMembership } from "@/server/auth/session";
import { can } from "@/domain/organizations/permissions";
import { recordAuditEvent, AUDIT_ACTIONS } from "@/domain/audit/audit-log";
import { enforceRateLimit } from "@/server/security/rate-limit";
import { reportError } from "@/lib/observability";
import { isSupportedCurrency } from "@/domain/money/currency";
import { planFactProposals, willPropose } from "@/domain/documents/intelligence/proposals";
import { DOCUMENT_TYPE_LABELS } from "@/domain/documents/intelligence/types";
import { reopenedStatusFor } from "@/domain/tax-preparation/types";
import { getVisibleDocument } from "@/server/db/repositories/documents";
import { getExtraction, listFieldsForExtraction } from "@/server/db/repositories/document-intelligence";
import { getOrganization } from "@/server/db/repositories/organizations";
import { findLivePreparationCase, listCurrentFacts, recordFact, updatePreparationCase } from "@/server/db/repositories/tax-preparation";
import { downloadDocumentBytes } from "@/server/storage/documents";
import { processDocument } from "./processing";
import { configuredProviders } from "./providers";

/**
 * Document intelligence actions.
 *
 * The same order as every other mutation in this codebase: validate the form,
 * authenticate and authorize, rate limit, re-read what is being acted on
 * through the caller's RLS-scoped client, then write. Nothing the browser
 * sends besides two ids is used — not a document type, not a confidence, not
 * a value. Every one of those is re-derived server-side.
 */

export interface DocumentIntelligenceActionResult {
  error?: string;
  success?: boolean;
  message?: string;
}

const processSchema = z.object({ organizationId: z.uuid(), documentId: z.uuid() });
const proposeSchema = z.object({ organizationId: z.uuid(), extractionId: z.uuid() });

const GENERIC_FAILURE = "That couldn't be completed, and nothing was changed. Please try again.";

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

const STATUS_MESSAGE: Record<string, string> = {
  SUCCEEDED: "Read. Review the figures below — nothing is used until you confirm it.",
  PARTIAL: "Read, but some fields couldn't be found. Review what was read.",
  REVIEW_REQUIRED: "Read, and it needs review before any figure can be used.",
  UNSUPPORTED: "Nothing could be read from this file with the readers configured.",
};

export async function processDocumentAction(_prev: DocumentIntelligenceActionResult, formData: FormData): Promise<DocumentIntelligenceActionResult> {
  const parsed = processSchema.safeParse({ organizationId: field(formData, "organizationId"), documentId: field(formData, "documentId") });
  if (!parsed.success) return { error: "That document can't be read." };

  const { user, membership } = await requireOrgMembership(parsed.data.organizationId);
  if (!can(membership.role, "financial:write")) return { error: "You don't have permission to read documents in this workspace." };

  const limited = await enforceRateLimit("documentProcessing", { documentProcessingPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const client = await createClient();
  try {
    const outcome = await processDocument(
      { client, admin: createAdminClient(), providers: configuredProviders(), now: () => new Date(), download: downloadDocumentBytes },
      { organizationId: parsed.data.organizationId, documentId: parsed.data.documentId, userId: user.id },
    );

    if (outcome.kind === "completed") {
      await recordAuditEvent(client, {
        organizationId: parsed.data.organizationId,
        action: AUDIT_ACTIONS.documentProcessingCompleted,
        resourceType: "document",
        resourceId: parsed.data.documentId,
        metadata: { jobId: outcome.jobId, extractionId: outcome.extractionId, status: outcome.status, documentType: outcome.documentType },
      }).catch((error) => reportError(error, { scope: "documents", organizationId: parsed.data.organizationId, detail: { step: "audit" } }));
    } else if (outcome.kind === "failed") {
      await recordAuditEvent(client, {
        organizationId: parsed.data.organizationId,
        action: AUDIT_ACTIONS.documentProcessingFailed,
        resourceType: "document",
        resourceId: parsed.data.documentId,
        metadata: { jobId: outcome.jobId, category: outcome.category },
      }).catch((error) => reportError(error, { scope: "documents", organizationId: parsed.data.organizationId, detail: { step: "audit" } }));
    }

    revalidatePath(`/app/${parsed.data.organizationId}/documents`);
    revalidatePath(`/app/${parsed.data.organizationId}/documents/${parsed.data.documentId}`);

    switch (outcome.kind) {
      case "completed":
        return { success: true, message: STATUS_MESSAGE[outcome.status] };
      case "already_processed":
        return { success: true, message: "This document has already been read with the current reader. The result below is that reading." };
      case "in_progress":
        return { error: "This document is already being read. Refresh in a moment." };
      case "failed":
        return { error: `${outcome.message}${outcome.canRetry ? " You can try again." : ""}` };
      default:
        return { error: outcome.message };
    }
  } catch (error) {
    reportError(error, { scope: "documents", organizationId: parsed.data.organizationId, detail: { step: "processDocument" } });
    return { error: GENERIC_FAILURE };
  }
}

/**
 * Offers readable figures from an extraction to Tax preparation as PROPOSALS.
 *
 * Never confirms, never overwrites, never converts a currency, never assumes
 * a year. Which figures are offered is decided by `planFactProposals` from
 * what the server re-reads here. The database trigger from 0046 then refuses
 * any proposal whose amount differs from the extracted one.
 */
export async function proposeDocumentFactsAction(_prev: DocumentIntelligenceActionResult, formData: FormData): Promise<DocumentIntelligenceActionResult> {
  const parsed = proposeSchema.safeParse({ organizationId: field(formData, "organizationId"), extractionId: field(formData, "extractionId") });
  if (!parsed.success) return { error: "Those figures can't be proposed." };
  const organizationId = parsed.data.organizationId;

  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "financial:write")) return { error: "You don't have permission to change tax preparation for this workspace." };

  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const client = await createClient();
  try {
    const extraction = await getExtraction(client, parsed.data.extractionId);
    if (!extraction || extraction.organizationId !== organizationId) return { error: "That reading isn't in this workspace." };

    const document = await getVisibleDocument(client, extraction.documentId);
    if (!document || document.organizationId !== organizationId) return { error: "That document isn't in this workspace." };

    const [fields, organization] = await Promise.all([listFieldsForExtraction(client, extraction.id), getOrganization(client, organizationId)]);
    const live = extraction.taxYear !== null ? await findLivePreparationCase(client, organizationId, extraction.taxYear) : null;
    if (live && live.status === "ARCHIVED") return { error: "That tax year's preparation is archived." };
    const currentFacts = live ? await listCurrentFacts(client, live.id) : [];

    const plan = planFactProposals({
      extraction: { id: extraction.id, documentId: document.id, documentType: extraction.documentType, status: extraction.status, classificationConfidence: extraction.classificationConfidence, taxYear: extraction.taxYear },
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
    if (plan.blocked || !live) return { error: plan.blocked ?? "No tax preparation is open for this document's year." };

    const toPropose = plan.items.filter((item) => willPropose(item.relation));
    if (toPropose.length === 0) return { success: true, message: "Nothing new to propose — every readable figure is already in Tax preparation or can't be used." };

    const proposedKeys: string[] = [];
    for (const item of toPropose) {
      try {
        await recordFact(client, {
          organizationId,
          caseId: live.id,
          version: live.currentVersion,
          key: item.factKey,
          amountMinor: item.amountMinor,
          currency: item.currency,
          source: "DOCUMENT",
          state: "PROPOSED",
          evidenceDocumentId: document.id,
          evidenceExtractionFieldId: item.fieldId,
          evidenceNote: `${DOCUMENT_TYPE_LABELS[extraction.documentType]}${item.box ? ` box ${item.box}` : ""}, read from the document (reading ${extraction.version})`,
          // A suggestion, attributed to no person. Whoever confirms it is
          // recorded on the confirming row.
          createdBy: null,
        });
        proposedKeys.push(item.factKey);
      } catch (error) {
        // The one-proposal-per-field index: a concurrent request got there
        // first. Anything else is a real failure and is reported.
        if ((error as { code?: string }).code !== "23505") throw error;
      }
    }

    if (proposedKeys.length > 0) {
      const reopened = reopenedStatusFor(live.status);
      if (reopened) await updatePreparationCase(client, live.id, { status: reopened });
      await recordAuditEvent(client, {
        organizationId,
        action: AUDIT_ACTIONS.documentFactsProposed,
        resourceType: "document",
        resourceId: document.id,
        metadata: { extractionId: extraction.id, caseId: live.id, keys: proposedKeys, count: proposedKeys.length },
      }).catch((error) => reportError(error, { scope: "documents", organizationId, detail: { step: "audit" } }));
    }

    revalidatePath(`/app/${organizationId}/documents/${document.id}`);
    revalidatePath(`/app/${organizationId}/tax-preparation`);
    return {
      success: true,
      message: `${proposedKeys.length} ${proposedKeys.length === 1 ? "figure was" : "figures were"} added to Tax preparation ${extraction.taxYear} as suggestions. Nothing is used until you confirm it there.`,
    };
  } catch (error) {
    reportError(error, { scope: "documents", organizationId, detail: { step: "proposeDocumentFacts" } });
    return { error: GENERIC_FAILURE };
  }
}
