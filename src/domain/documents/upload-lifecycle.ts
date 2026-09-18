import { MAX_UPLOAD_BYTES } from "./upload-limits";
import { verifyFileSignature } from "./file-signature";

/**
 * The upload state machine, as a pure function of what the server observed.
 *
 * WHY THIS IS SEPARATE FROM THE ACTION
 *
 * Everything that decides whether an uploaded file becomes a real document
 * lives here, with no Supabase client, no network, and no `File`. The rules
 * that matter — a missing object is not a document, a 30 MB object is not a
 * document, HTML stored as `application/pdf` is not a document — are then
 * testable exhaustively rather than only reachable through a live upload.
 *
 * THE INVARIANT
 *
 * `pending` is the only status a confirmation can act on, and it can only move
 * to `uploaded` or `rejected`. Both are terminal. A retry against a terminal
 * row returns that row's existing outcome instead of re-deciding it, which is
 * what makes confirmation idempotent: a double-submitted confirm, a retried
 * fetch, and a user hitting the button twice all produce one document and one
 * audit event.
 *
 * Deliberately terminal in both directions. If `rejected` could return to
 * `pending`, a caller who failed verification could upload a second time
 * against the same signed URL window and try again — the check would become
 * advisory. If `uploaded` could be re-decided, a later sweep observing a
 * deleted object could un-publish a document someone is relying on.
 */

export type UploadObservation =
  | { exists: false }
  | { exists: true; sizeBytes: number; header: Uint8Array };

export type UploadVerdict =
  | { outcome: "accept"; sizeBytes: number }
  | { outcome: "reject"; reason: string };

/**
 * Decides whether the object the server just looked at is the document that
 * was declared.
 *
 * The declared size is not passed in on purpose. The browser's `file.size` was
 * a claim used only to fail fast before minting a URL; what gets recorded is
 * the size Storage reports, because that is the number that is actually true.
 */
export function evaluateUpload(observation: UploadObservation, declaredMimeType: string): UploadVerdict {
  if (!observation.exists) {
    // The signed URL was minted but nothing was ever PUT to it, or the PUT
    // failed. The row exists; the file does not.
    return { outcome: "reject", reason: "The file never finished uploading. Please try again." };
  }

  const { sizeBytes, header } = observation;

  if (sizeBytes <= 0) {
    return { outcome: "reject", reason: "That file is empty." };
  }

  if (sizeBytes > MAX_UPLOAD_BYTES) {
    // The client-side check was on a claimed size. This one is on the bytes
    // that actually landed, which is the only version an attacker cannot
    // choose — they simply upload a large file and declare a small one.
    return { outcome: "reject", reason: "That file is larger than the 20MB limit." };
  }

  const signature = verifyFileSignature(header, declaredMimeType);
  if (!signature.ok) {
    return { outcome: "reject", reason: signature.error ?? "That file can't be accepted." };
  }

  return { outcome: "accept", sizeBytes };
}

export type ConfirmDecision =
  | { kind: "verify" }
  | { kind: "already_uploaded" }
  | { kind: "already_rejected" }
  | { kind: "not_confirmable" };

/**
 * What a confirmation request should do, given the row's current status.
 *
 * `not_confirmable` covers the legacy states ('processing', 'processed',
 * 'failed', 'needs_review'). Those belong to a processing pipeline that does
 * not exist yet; a confirm arriving for one of them is a bug or a forged
 * request, and re-running verification on it could demote a real document.
 */
export function decideConfirmation(status: string): ConfirmDecision {
  switch (status) {
    case "pending":
      return { kind: "verify" };
    case "uploaded":
      return { kind: "already_uploaded" };
    case "rejected":
      return { kind: "already_rejected" };
    default:
      return { kind: "not_confirmable" };
  }
}

/** Statuses a product read is allowed to surface. */
export const VISIBLE_DOCUMENT_STATUSES = ["uploaded"] as const;

/**
 * How long an unconfirmed upload may sit before the sweep reclaims it.
 *
 * Longer than any plausible browser upload (a 20 MB file on a slow connection,
 * plus the signed URL's own two-hour validity) so the sweep can never race a
 * user who is still uploading. Short enough that abandoned bytes are not paid
 * for indefinitely.
 */
export const ABANDONED_UPLOAD_TTL_HOURS = 24;
