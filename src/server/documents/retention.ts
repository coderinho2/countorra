import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { listExpiredDocumentOriginals, markDocumentOriginalRemoved } from "@/server/db/repositories/documents";
import { deleteDocumentFileIfPresent } from "@/server/storage/documents";
import { RETENTION_SWEEP_BATCH } from "@/domain/documents/retention";
import { reportError, reportEvent } from "@/lib/observability";

type Client = SupabaseClient<Database>;

/**
 * THE SWEEP: deletes identity-document originals whose retention window has
 * passed, and nothing else.
 *
 * WHAT MAKES IT SAFE TO RUN REPEATEDLY
 *
 * Every step is idempotent, and the order is chosen so that a crash between
 * any two of them leaves a state the next run fixes rather than one it cannot
 * see:
 *
 *   1. ask the database what is due (bounded, oldest first)
 *   2. delete the object — MISSING COUNTS AS DONE. A half-finished previous
 *      run leaves objects already gone, and treating that as a failure would
 *      wedge the sweep on exactly the rows it had already handled.
 *   3. mark the row removed, scoped by organization
 *
 * Bytes before row, deliberately. Marking first and then failing to delete
 * would record a file as gone while it sat in the bucket, and nothing would
 * ever look at it again — the one outcome this whole feature exists to
 * prevent.
 *
 * WHAT IT CANNOT DO
 *
 * It cannot touch a financial document: the expiry that makes a row visible
 * here is set only by the identity branch of 0058's trigger, and a document
 * with no expiry is never returned. It cannot cross tenants: the organization
 * comes back with each row and is passed to the mark function, which matches
 * on both ids. It cannot run away: the database caps the page, and the caller
 * is told whether more is waiting rather than looping here.
 *
 * WHAT IT REPORTS
 *
 * Counts. No organization id, no storage path, no filename — a storage path
 * contains a document id and a sweep log is an operator's log, not a tenant's.
 */
export interface RetentionSweepResult {
  /** Rows the database offered as due. */
  considered: number;
  /** Objects this run actually deleted from Storage. */
  filesRemoved: number;
  /** Rows marked removed, including those whose object was already gone. */
  rowsMarked: number;
  /** Rows that could not be completed this run; retried on the next. */
  failed: number;
  /** True when the page came back full — the caller should run again. */
  remaining: boolean;
}

export async function sweepExpiredIdentityOriginals(client: Client, options: { batchSize?: number } = {}): Promise<RetentionSweepResult> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? RETENTION_SWEEP_BATCH, RETENTION_SWEEP_BATCH));
  const due = await listExpiredDocumentOriginals(client, batchSize);

  let filesRemoved = 0;
  let rowsMarked = 0;
  let failed = 0;

  for (const document of due) {
    try {
      // `IfPresent`: an object that is already gone is the expected state of a
      // re-run, not an error. The row still needs marking either way.
      if (await deleteDocumentFileIfPresent(client, document.storagePath)) filesRemoved += 1;
      if (await markDocumentOriginalRemoved(client, document.organizationId, document.documentId)) rowsMarked += 1;
    } catch (error) {
      // One bad row must not stop the rest. It keeps its expiry, so the next
      // run picks it up; the detail carries no path and no organization.
      failed += 1;
      reportError(error, { scope: "documents", detail: { step: "retention_sweep" } });
    }
  }

  reportEvent(
    "documents.retention_swept",
    { scope: "documents", detail: { considered: due.length, filesRemoved, rowsMarked, failed } },
    failed > 0 ? "warning" : "info",
  );

  return { considered: due.length, filesRemoved, rowsMarked, failed, remaining: due.length === batchSize };
}
