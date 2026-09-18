import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { deleteDocument, listReclaimableDocuments } from "@/server/db/repositories/documents";
import { deleteDocumentFileIfPresent } from "@/server/storage/documents";
import { ABANDONED_UPLOAD_TTL_HOURS } from "@/domain/documents/upload-lifecycle";
import { reportEvent } from "@/lib/observability";

type Client = SupabaseClient<Database>;

/**
 * ⚠️ NOTHING CALLS THIS ON A SCHEDULE. IT IS NOT AUTOMATIC CLEANUP.
 *
 * This project has no scheduler. There is no `pg_cron` (stated explicitly in
 * supabase/migrations/0026_rate_limiting.sql, which works around its absence
 * the same way), no `vercel.json` cron block, and no job runner. This function
 * is the reclaim *capability*; invoking it is a deployment decision that has
 * not been made, and inventing a background-job platform to call it is out of
 * scope.
 *
 * Until something invokes it, abandoned uploads accumulate. That is a cost and
 * storage-growth issue, not a security or correctness one — `pending` and
 * `rejected` rows are invisible to every product read and no signed download
 * URL is issued for them (src/server/db/repositories/documents.ts). The
 * failure mode of not running this is a slowly growing bucket, not a leaked or
 * a phantom document.
 *
 * To wire it up later, call it from whatever scheduled context is chosen with
 * an admin client, in a loop, until `remaining` is false.
 *
 * WHY AN ADMIN CLIENT
 *
 * A sweep is by definition not acting on behalf of any member, and the rows it
 * reclaims may belong to organizations no caller is a member of. RLS would
 * make it see nothing. This is the same reason account deletion uses one.
 */
export interface CleanupResult {
  /** Rows removed from the database. */
  rowsRemoved: number;
  /** Storage objects actually deleted (fewer, when an upload never landed). */
  filesRemoved: number;
  /** True when the page came back full — the caller should run again. */
  remaining: boolean;
}

export async function reclaimAbandonedUploads(
  client: Client,
  options: { now?: Date; ttlHours?: number; batchSize?: number } = {},
): Promise<CleanupResult> {
  const now = options.now ?? new Date();
  const ttlHours = options.ttlHours ?? ABANDONED_UPLOAD_TTL_HOURS;
  const batchSize = options.batchSize ?? 100;

  const cutoff = new Date(now.getTime() - ttlHours * 60 * 60 * 1000).toISOString();
  const candidates = await listReclaimableDocuments(client, cutoff, batchSize);

  let filesRemoved = 0;
  let rowsRemoved = 0;

  for (const document of candidates) {
    // Bytes first here, unlike the confirm path. There is no visibility
    // concern left — the row is already invisible and already past its TTL —
    // so the only ordering that matters is the one that cannot strand bytes.
    // Delete the row first and a failed object delete would lose the pointer
    // to it forever.
    if (await deleteDocumentFileIfPresent(client, document.storagePath)) filesRemoved += 1;
    await deleteDocument(client, document.id);
    rowsRemoved += 1;
  }

  reportEvent("documents.reclaim_abandoned_uploads", { scope: "documents", detail: { rowsRemoved, filesRemoved, ttlHours } });

  return { rowsRemoved, filesRemoved, remaining: candidates.length === batchSize };
}
