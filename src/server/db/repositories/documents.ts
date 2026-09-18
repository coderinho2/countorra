import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { VISIBLE_DOCUMENT_STATUSES } from "@/domain/documents/upload-lifecycle";

type Client = SupabaseClient<Database>;
type DocumentRow = Database["public"]["Tables"]["documents"]["Row"];

export interface AppDocument {
  id: string;
  organizationId: string;
  kind: DocumentRow["kind"];
  storageBucket: string;
  storagePath: string;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  status: DocumentRow["status"];
  createdAt: string;
}

function toDocument(row: DocumentRow): AppDocument {
  return {
    id: row.id,
    organizationId: row.organization_id,
    kind: row.kind,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * The ONE read every product surface goes through — the documents page, both
 * AI document tools, and global search.
 *
 * The status filter is here rather than at each call site on purpose. With
 * direct-to-Storage uploads a `documents` row can exist before its file does
 * (see src/domain/documents/upload-lifecycle.ts), so "row exists" no longer
 * means "document exists". Every caller filtering for itself is four chances
 * to forget; one funnel is zero. A `pending` row that leaked into a listing
 * would render a document whose download URL 404s, and a `rejected` row would
 * advertise a file the server already refused.
 */
export async function listDocuments(client: Client, organizationId: string): Promise<AppDocument[]> {
  const { data, error } = await client
    .from("documents")
    .select("*")
    .eq("organization_id", organizationId)
    .in("status", [...VISIBLE_DOCUMENT_STATUSES])
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data.map(toDocument);
}

/**
 * Any row by id, whatever its status.
 *
 * Used by the confirm step (which exists to act on `pending`) and by delete
 * (which must be able to remove bytes regardless of state). NOT for rendering
 * — a caller that wants to show a document to a user wants `listDocuments` or
 * `getVisibleDocument`.
 */
export async function getDocument(client: Client, documentId: string): Promise<AppDocument | null> {
  const { data, error } = await client.from("documents").select("*").eq("id", documentId).maybeSingle();
  if (error) throw error;
  return data ? toDocument(data) : null;
}

/** As `getDocument`, but only for a document the product is allowed to show. */
export async function getVisibleDocument(client: Client, documentId: string): Promise<AppDocument | null> {
  const document = await getDocument(client, documentId);
  if (!document) return null;
  return (VISIBLE_DOCUMENT_STATUSES as readonly string[]).includes(document.status) ? document : null;
}

export interface CreatePendingDocumentInput {
  organizationId: string;
  kind: DocumentRow["kind"];
  storagePath: string;
  originalFilename: string;
  mimeType: string;
  uploadedBy: string;
}

/**
 * Records the intent to upload, BEFORE any bytes exist.
 *
 * Deliberately ordered this way. The alternative — mint the URL, let the
 * browser upload, then insert — leaves a window where bytes are in the bucket
 * with nothing in the database pointing at them. Those are unreachable: no
 * listing shows them, no cleanup query finds them, and they are billed
 * forever. An orphan row is the strictly better failure: it is invisible
 * (status `pending`), it is queryable, and the sweep can reclaim it.
 *
 * `size_bytes` is left null on purpose. The client's declared size was used to
 * fail fast; it is not evidence, and writing it here would put an unverified
 * number in the column that `markDocumentUploaded` later fills from what
 * Storage actually reports.
 */
export async function createPendingDocument(client: Client, input: CreatePendingDocumentInput): Promise<AppDocument> {
  const { data, error } = await client
    .from("documents")
    .insert({
      organization_id: input.organizationId,
      kind: input.kind,
      storage_path: input.storagePath,
      original_filename: input.originalFilename,
      mime_type: input.mimeType,
      size_bytes: null,
      uploaded_by: input.uploadedBy,
      status: "pending",
    })
    .select("*")
    .single();
  if (error) throw error;
  return toDocument(data);
}

/**
 * Promotes a verified upload. This is the commit point of the whole flow — the
 * moment a row becomes a document the product will show and serve.
 *
 * The `status = 'pending'` predicate is what makes confirmation safe under
 * concurrency. Two confirmations racing each other both read `pending`, both
 * issue this update, and exactly one matches a row; the loser gets `null` and
 * treats it as already-committed rather than writing a second audit event.
 * The same predicate is what stops a `rejected` row being walked back.
 *
 * `sizeBytes` is the size Storage reported, never the size the browser
 * claimed.
 */
export async function markDocumentUploaded(
  client: Client,
  documentId: string,
  organizationId: string,
  sizeBytes: number,
): Promise<AppDocument | null> {
  const { data, error } = await client
    .from("documents")
    .update({ status: "uploaded", size_bytes: sizeBytes })
    .eq("id", documentId)
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? toDocument(data) : null;
}

/** Terminal failure, under the same `pending`-only predicate as promotion. */
export async function markDocumentRejected(
  client: Client,
  documentId: string,
  organizationId: string,
): Promise<AppDocument | null> {
  const { data, error } = await client
    .from("documents")
    .update({ status: "rejected" })
    .eq("id", documentId)
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? toDocument(data) : null;
}

/**
 * Rows the sweep may reclaim: never-confirmed or refused, past the TTL.
 *
 * Ordered oldest-first and capped so one invocation does a bounded amount of
 * work — the caller re-runs until a page comes back short rather than trying
 * to drain an arbitrarily large backlog in a single request.
 */
export async function listReclaimableDocuments(
  client: Client,
  before: string,
  limit: number,
): Promise<AppDocument[]> {
  const { data, error } = await client
    .from("documents")
    .select("*")
    .in("status", ["pending", "rejected"])
    .lt("created_at", before)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data.map(toDocument);
}

export async function deleteDocument(client: Client, documentId: string): Promise<void> {
  const { error } = await client.from("documents").delete().eq("id", documentId);
  if (error) throw error;
}
