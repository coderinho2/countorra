import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { SIGNATURE_BYTES_NEEDED } from "@/domain/documents/file-signature";
import type { UploadObservation } from "@/domain/documents/upload-lifecycle";

type Client = SupabaseClient<Database>;

const BUCKET = "documents";

/**
 * Direct-to-Storage uploads: the bytes never pass through the application.
 *
 * The server decides the object key, authorizes the caller, and mints a signed
 * URL for that one key. The browser PUTs to Storage directly. A second request
 * then asks the server to confirm, and the server looks at what actually
 * landed rather than trusting what it was told.
 *
 * `createSignedUploadUrl` is issued with the *caller's* client, not an admin
 * one, so `documents_storage_insert_member` still decides whether that key may
 * be written (supabase/migrations/0018_document_storage.sql). Minting is
 * subject to the same tenant policy the old direct upload was.
 */
export interface SignedUploadTarget {
  storagePath: string;
  signedUrl: string;
  token: string;
}

export async function createSignedUploadTarget(client: Client, storagePath: string): Promise<SignedUploadTarget> {
  // No `upsert`. Every key contains a fresh UUID, so a collision means either
  // a UUID collision or a replay against an existing object — both of which
  // should fail loudly rather than overwrite someone's stored document.
  const { data, error } = await client.storage.from(BUCKET).createSignedUploadUrl(storagePath);
  if (error) throw error;
  return { storagePath, signedUrl: data.signedUrl, token: data.token };
}

/**
 * Looks at the object the browser claims to have uploaded.
 *
 * Two facts are needed and neither can come from the client: how large the
 * stored object is, and what its leading bytes are. Both are read back from
 * Storage.
 *
 * The header is fetched with a ranged GET over a short-lived signed URL. The
 * range is a request, not a guarantee — if Storage answers 200 with the whole
 * body instead of 206, the reader below still stops after the first chunk and
 * cancels the stream, so a 20 MB object never lands in application memory.
 */
export async function observeUploadedObject(client: Client, storagePath: string): Promise<UploadObservation> {
  const { data: info, error: infoError } = await client.storage.from(BUCKET).info(storagePath);

  // A missing object is the expected case for an abandoned upload, not an
  // exceptional one — the caller turns it into a rejection.
  if (infoError || !info) return { exists: false };

  const sizeBytes = typeof info.size === "number" ? info.size : 0;
  if (sizeBytes <= 0) return { exists: true, sizeBytes, header: new Uint8Array() };

  const { data: signed, error: signError } = await client.storage.from(BUCKET).createSignedUrl(storagePath, 60);
  if (signError || !signed) return { exists: false };

  const header = await readHeaderBytes(signed.signedUrl);
  return { exists: true, sizeBytes, header };
}

/** Reads at most `SIGNATURE_BYTES_NEEDED` bytes, then abandons the response. */
async function readHeaderBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { Range: `bytes=0-${SIGNATURE_BYTES_NEEDED - 1}` } });
  if (!response.ok || !response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < SIGNATURE_BYTES_NEEDED) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    // Stops the transfer whether the range was honoured or the whole object
    // was being streamed at us.
    //
    // NOT awaited, deliberately. Inside a Next.js server runtime `fetch` is
    // patched, and the patch clones responses with `body.tee()`
    // (next/dist/server/lib/clone-response.js). Per the Streams spec, cancelling
    // one branch of a tee only settles once the OTHER branch is cancelled or
    // drained too — and Next never touches its copy. Awaiting here therefore
    // hung document confirmation until the connection timed out (observed live
    // at 10s to 2.6 minutes), leaving every upload stuck `pending` and
    // invisible. The header bytes are already in hand; the cancel only needs to
    // be requested, not waited for.
    void reader.cancel().catch(() => {});
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined.subarray(0, SIGNATURE_BYTES_NEEDED);
}

/**
 * The whole stored object, for a server-side read — bounded.
 *
 * Used by document processing, which must parse the bytes. The size Storage
 * reports is checked BEFORE downloading, and the downloaded length is checked
 * again after, so neither a stale listing nor a replaced object can push more
 * than `maxBytes` into memory. The caller's RLS-scoped client is used, so the
 * storage tenant policy still decides whether this object may be read.
 */
export async function downloadDocumentBytes(
  client: Client,
  storagePath: string,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: "missing" | "too_large" }> {
  const { data: info, error: infoError } = await client.storage.from(BUCKET).info(storagePath);
  if (infoError || !info) return { ok: false, reason: "missing" };
  if (typeof info.size === "number" && info.size > maxBytes) return { ok: false, reason: "too_large" };

  const { data, error } = await client.storage.from(BUCKET).download(storagePath);
  if (error || !data) return { ok: false, reason: "missing" };
  if (data.size > maxBytes) return { ok: false, reason: "too_large" };
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.byteLength > maxBytes) return { ok: false, reason: "too_large" };
  return { ok: true, bytes };
}

export async function getDocumentDownloadUrl(client: Client, storagePath: string): Promise<string> {
  const { data, error } = await client.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 5);
  if (error) throw error;
  return data.signedUrl;
}

export async function deleteDocumentFile(client: Client, storagePath: string): Promise<void> {
  const { error } = await client.storage.from(BUCKET).remove([storagePath]);
  if (error) throw error;
}

/**
 * Deletes an object on a path where failing is worse than leaving it.
 *
 * Used when a rejection has already been decided: the row is being marked
 * `rejected` either way, and throwing here would abort the request and leave
 * the row `pending` — visible to nothing, retried by no one, and now with the
 * bad bytes still in the bucket AND no record of why. Reported, not swallowed
 * silently; the sweep picks up whatever this misses.
 */
export async function deleteDocumentFileIfPresent(client: Client, storagePath: string): Promise<boolean> {
  try {
    await deleteDocumentFile(client, storagePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes every object under one organization's storage prefix.
 *
 * Storage lives outside Postgres, so no foreign key or cascade can reach it.
 * `tests/rls/deletion-graph.test.ts` proves the consequence: deleting an
 * organization removes its `documents` rows and leaves the actual files in
 * the bucket forever — invisible to the product, still costing money, and
 * still containing whatever the user uploaded. For a deletion flow that
 * claims to remove someone's data, that is the difference between true and
 * false.
 *
 * Listed and removed in pages because the API caps a listing, and a workspace
 * with thousands of receipts would otherwise be silently half-cleaned — the
 * same truncation class as FIN-01.
 *
 * Takes an ADMIN client: this runs during account deletion, after the caller's
 * authorization has already been established, and at a point where the
 * membership granting them storage access may already be gone.
 */
export async function deleteAllOrganizationFiles(client: Client, organizationId: string): Promise<{ removed: number }> {
  let removed = 0;

  // Bounded: a runaway loop here would hammer storage rather than fail.
  for (let page = 0; page < 100; page++) {
    const { data, error } = await client.storage.from(BUCKET).list(organizationId, { limit: 100, offset: 0 });
    if (error) throw error;
    if (!data || data.length === 0) break;

    const paths = data.map((entry) => `${organizationId}/${entry.name}`);
    const { error: removeError } = await client.storage.from(BUCKET).remove(paths);
    if (removeError) throw removeError;

    removed += paths.length;
    // Always deleting the first page, so the next listing returns what
    // followed; when a page comes back short the prefix is exhausted.
    if (data.length < 100) break;
  }

  return { removed };
}
