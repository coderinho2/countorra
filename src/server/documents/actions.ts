"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { requireOrgMembership } from "@/server/auth/session";
import { can } from "@/domain/organizations/permissions";
import {
  createSignedUploadTarget,
  deleteDocumentFile,
  deleteDocumentFileIfPresent,
  getDocumentDownloadUrl,
  observeUploadedObject,
} from "@/server/storage/documents";
import {
  createPendingDocument,
  deleteDocument,
  getDocument,
  getVisibleDocument,
  markDocumentRejected,
  markDocumentUploaded,
} from "@/server/db/repositories/documents";
import { recordAuditEvent, AUDIT_ACTIONS } from "@/domain/audit/audit-log";
import { confirmDocumentUploadSchema, uploadDocumentSchema } from "@/validation/schemas/document";
import { storageKeyFor, isKeyOwnedBy } from "@/domain/documents/storage-key";
import { decideConfirmation, evaluateUpload } from "@/domain/documents/upload-lifecycle";
import type { VerifiedMimeType } from "@/domain/documents/file-signature";
import { enforceRateLimit } from "@/server/security/rate-limit";
import { reportError } from "@/lib/observability";

export interface DocumentActionResult {
  error?: string;
  success?: boolean;
}

/**
 * UPLOADS DO NOT PASS THROUGH THE APPLICATION.
 *
 * The old flow streamed the whole file into a Server Action, which forced
 * `experimental.serverActions.bodySizeLimit` up to 20 MB globally — every
 * authenticated Server Action in the product had to accept a 20 MB body before
 * its own validation could run, purely so that one of them could receive a
 * receipt (see src/domain/documents/upload-limits.ts, which flagged exactly
 * this trade). Direct-to-Storage removes the trade instead of tuning it.
 *
 * Two requests, with a database row as the commit point:
 *
 *   1. `requestDocumentUpload` — authorize, rate limit, choose the object key,
 *      write a `pending` row, mint a signed URL for that one key.
 *   2. The browser PUTs the bytes straight to Storage.
 *   3. `confirmDocumentUpload` — read the stored object back, and promote the
 *      row to `uploaded` only if what landed is what was declared.
 *
 * The window between (1) and (3) is why `pending` exists. Nothing in that
 * window is visible to any product read.
 */
export interface RequestUploadResult {
  error?: string;
  upload?: {
    documentId: string;
    storagePath: string;
    /** Storage's one-shot upload token, scoped to `storagePath`. */
    token: string;
  };
}

export async function requestDocumentUpload(input: {
  organizationId: string;
  kind: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<RequestUploadResult> {
  const parsed = uploadDocumentSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That file can't be uploaded." };

  const { user, membership } = await requireOrgMembership(parsed.data.organizationId);
  if (!can(membership.role, "financial:write")) return { error: "You don't have permission to upload documents." };

  // Bounded after authorization. This is the step that costs storage, so the
  // budget is spent on minting a URL rather than on confirming one — a caller
  // who requests a thousand URLs and uploads nothing is exactly what the limit
  // is for, and the sweep reclaims what they left behind.
  const rateLimited = await enforceRateLimit("documentUpload", { documentUploadPerUser: user.id });
  if (!rateLimited.allowed) return { error: rateLimited.message };

  const mimeType = parsed.data.mimeType as VerifiedMimeType;
  // Server-chosen, from a fresh UUID and the validated type. The user's
  // filename is preserved as data on the row, never as a path segment.
  const storagePath = storageKeyFor(parsed.data.organizationId, crypto.randomUUID(), mimeType);

  const client = await createClient();

  // DB first, deliberately: an orphan row is recoverable, orphan bytes are
  // not. See createPendingDocument.
  const document = await createPendingDocument(client, {
    organizationId: parsed.data.organizationId,
    kind: parsed.data.kind,
    storagePath,
    originalFilename: parsed.data.originalFilename,
    mimeType,
    uploadedBy: user.id,
  });

  try {
    const target = await createSignedUploadTarget(client, storagePath);
    return { upload: { documentId: document.id, storagePath: target.storagePath, token: target.token } };
  } catch (error) {
    // No URL was issued, so no bytes can ever arrive for this row. Remove it
    // now rather than leaving the sweep a row it will never be able to
    // distinguish from a genuine abandoned upload.
    reportError(error, { scope: "storage", organizationId: parsed.data.organizationId, detail: { step: "createSignedUploadTarget" } });
    await deleteDocument(client, document.id).catch(() => {});
    return { error: "Couldn't start the upload. Please try again." };
  }
}

/**
 * Verifies what actually landed, then commits or refuses.
 *
 * Idempotent by construction: the decision comes from the row's status, and
 * both terminal states answer without re-running verification
 * (src/domain/documents/upload-lifecycle.ts). A double-click, a retried
 * request, and a browser that fires the confirm twice all produce one document
 * and one audit event.
 */
export async function confirmDocumentUpload(input: { organizationId: string; documentId: string }): Promise<DocumentActionResult> {
  const parsed = confirmDocumentUploadSchema.safeParse(input);
  if (!parsed.success) return { error: "That upload can't be confirmed." };

  const { membership } = await requireOrgMembership(parsed.data.organizationId);
  if (!can(membership.role, "financial:write")) return { error: "You don't have permission to upload documents." };

  const client = await createClient();
  const document = await getDocument(client, parsed.data.documentId);

  // Same-org check on top of RLS. `getDocument` is not status-filtered, so
  // this is the only thing standing between a guessed id and a cross-tenant
  // confirmation — belt and braces, in the order the rest of the codebase
  // uses.
  if (!document || document.organizationId !== parsed.data.organizationId) return { error: "Upload not found." };

  const decision = decideConfirmation(document.status);
  if (decision.kind === "already_uploaded") return { success: true };
  if (decision.kind === "already_rejected") return { error: "That file couldn't be accepted. Please try uploading it again." };
  if (decision.kind === "not_confirmable") return { error: "That upload can't be confirmed." };

  // A row whose path is not under this organization's prefix is not one this
  // request may act on, whatever the row says its organization is.
  if (!isKeyOwnedBy(document.storagePath, parsed.data.organizationId)) return { error: "Upload not found." };

  const observation = await observeUploadedObject(client, document.storagePath);
  const verdict = evaluateUpload(observation, document.mimeType ?? "");

  if (verdict.outcome === "reject") {
    // Row first, bytes second. If the delete fails the row is still terminal
    // and still invisible, and the sweep collects the object later. The
    // reverse order could leave a `pending` row pointing at nothing, which is
    // indistinguishable from an upload still in flight.
    const rejected = await markDocumentRejected(client, document.id, parsed.data.organizationId);
    if (rejected) {
      await deleteDocumentFileIfPresent(client, document.storagePath);
      await recordAuditEvent(client, {
        organizationId: parsed.data.organizationId,
        action: AUDIT_ACTIONS.documentRejected,
        resourceType: "document",
        resourceId: document.id,
      });
    }
    return { error: verdict.reason };
  }

  const promoted = await markDocumentUploaded(client, document.id, parsed.data.organizationId, verdict.sizeBytes);
  // `null` means a concurrent confirmation already moved the row out of
  // `pending`. Nothing further to do, and no second audit event.
  if (promoted) {
    await recordAuditEvent(client, {
      organizationId: parsed.data.organizationId,
      action: AUDIT_ACTIONS.documentUploaded,
      resourceType: "document",
      resourceId: document.id,
    });
  }

  revalidatePath(`/app/${parsed.data.organizationId}/documents`);
  return { success: true };
}

export async function deleteDocumentAction(organizationId: string, documentId: string) {
  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "financial:delete")) throw new Error("You don't have permission to delete documents.");

  // Bounded after authorization, so the limiter is keyed on an identity that
  // has already been verified (rate-limit-policy.ts: recordMutationPerUser).
  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) throw new Error(limited.message);

  const client = await createClient();
  // Unfiltered on purpose: delete removes bytes, and a `pending` or `rejected`
  // row's bytes are exactly the ones most worth being able to remove.
  const document = await getDocument(client, documentId);
  if (!document || document.organizationId !== organizationId) throw new Error("Document not found.");

  await deleteDocumentFile(client, document.storagePath);
  await deleteDocument(client, documentId);
  await recordAuditEvent(client, { organizationId, action: AUDIT_ACTIONS.documentDeleted, resourceType: "document", resourceId: documentId });
  revalidatePath(`/app/${organizationId}/documents`);
}

export async function getDocumentUrlAction(organizationId: string, documentId: string): Promise<string> {
  await requireOrgMembership(organizationId);
  const client = await createClient();
  // Status-filtered: handing out a signed URL for a `pending` row would serve
  // bytes no server has verified, and for a `rejected` row would serve the
  // exact bytes verification refused.
  const document = await getVisibleDocument(client, documentId);
  if (!document || document.organizationId !== organizationId) throw new Error("Document not found.");
  return getDocumentDownloadUrl(client, document.storagePath);
}
