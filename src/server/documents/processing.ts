import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { verifyFileSignature, type VerifiedMimeType } from "@/domain/documents/file-signature";
import { isKeyOwnedBy } from "@/domain/documents/storage-key";
import { MAX_UPLOAD_BYTES } from "@/domain/documents/upload-limits";
import { extractDocument } from "@/domain/documents/intelligence/extraction";
import { resolveProvider, runProvider, type TextExtractionProvider } from "@/domain/documents/intelligence/provider";
import { MAX_PROCESSING_ATTEMPTS, currentIdentity, decideProcessingRequest, idempotencyKeyFor } from "@/domain/documents/intelligence/state-machine";
import { FAILURE_MESSAGES, type ExtractionStatus, type FailureCategory, type ProcessingJobStatus } from "@/domain/documents/intelligence/types";
import { getVisibleDocument, type AppDocument } from "@/server/db/repositories/documents";
import { claimJob, failJob, insertQueuedJob, listJobsForDocument, recordExtraction, requeueJob, type ProcessingJob } from "@/server/db/repositories/document-intelligence";
import { reportError, reportEvent } from "@/lib/observability";

type Client = SupabaseClient<Database>;

/**
 * THE PROCESSING ENTRY POINT.
 *
 * Runs one read of one document, synchronously, inside the request that asked
 * for it. There is no background queue and nothing here pretends there is:
 *
 *   request ─▶ job QUEUED ─▶ claimed PROCESSING ─▶ download, re-validate
 *           ─▶ provider (bounded, timed out) ─▶ extraction (pure)
 *           ─▶ extraction + fields + job completion, one transaction
 *
 * A request that dies part-way leaves a job in QUEUED or PROCESSING. The next
 * request for the same document finds it: QUEUED is started, PROCESSING past
 * its lease is failed as LEASE_EXPIRED and retried while attempts remain.
 *
 * WORKER INTEGRATION POINT
 *
 * A scheduler, when one exists, calls `runQueuedJob` with a service-role
 * client and the job id. Everything below is already written for that caller:
 * it takes no user session, re-reads the document, and records the same way.
 *
 * WHAT NEVER LEAVES THIS FILE
 *
 * Observability records ids, durations, statuses, the provider and the document
 * TYPE. Never text, values, names, filenames, storage paths or signed URLs.
 */

export interface ProcessingDependencies {
  /** The caller's RLS-scoped client: reads the document and its bytes. */
  client: Client;
  /** Service role: writes jobs and extractions, after authorization. */
  admin: Client;
  providers: readonly TextExtractionProvider[];
  now: () => Date;
  download: (client: Client, storagePath: string, maxBytes: number) => Promise<DownloadResult>;
  /** Defaults to PROVIDER_TIMEOUT_MS. */
  providerTimeoutMs?: number;
}

export type DownloadResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: "missing" | "too_large" };

export type ProcessOutcome =
  | { kind: "unavailable"; message: string }
  | { kind: "not_configured"; message: string }
  | { kind: "in_progress"; jobId: string }
  | { kind: "already_processed"; jobId: string; status: ProcessingJobStatus }
  | { kind: "attempts_exhausted"; jobId: string; message: string }
  | { kind: "completed"; jobId: string; extractionId: string; status: ExtractionStatus; documentType: string; durationMs: number }
  | { kind: "failed"; jobId: string; category: FailureCategory; message: string; canRetry: boolean };

const VERIFIED_TYPES: readonly string[] = ["application/pdf", "image/png", "image/jpeg", "image/webp"];

export async function processDocument(deps: ProcessingDependencies, input: { organizationId: string; documentId: string; userId: string }): Promise<ProcessOutcome> {
  const document = await getVisibleDocument(deps.client, input.documentId);
  if (!document || document.organizationId !== input.organizationId || !isKeyOwnedBy(document.storagePath, input.organizationId) || !VERIFIED_TYPES.includes(document.mimeType ?? "")) {
    return { kind: "unavailable", message: "Document not found." };
  }

  const availability = resolveProvider(document.mimeType as VerifiedMimeType, deps.providers);
  if (!availability.available) return { kind: "not_configured", message: availability.message };
  const { provider } = availability;
  const identity = currentIdentity(document.id, provider);

  // Bounded: at most two decisions, the second after losing a race.
  for (let round = 0; round < 2; round++) {
    const jobs = await listJobsForDocument(deps.client, document.id);
    const decision = decideProcessingRequest(jobs, identity, deps.now());
    const job = "jobId" in decision ? jobs.find((candidate) => candidate.id === decision.jobId) : undefined;

    switch (decision.kind) {
      case "in_progress":
        return { kind: "in_progress", jobId: decision.jobId };
      case "already_processed":
        return { kind: "already_processed", jobId: decision.jobId, status: decision.status };
      case "attempts_exhausted":
        return { kind: "attempts_exhausted", jobId: decision.jobId, message: `This document couldn't be read after ${job?.maxAttempts ?? MAX_PROCESSING_ATTEMPTS} attempts.` };
      case "recover_expired": {
        await failJob(deps.admin, job!, "PROCESSING", "LEASE_EXPIRED", FAILURE_MESSAGES.LEASE_EXPIRED, deps.now());
        if (!decision.canRetryAfter) return { kind: "attempts_exhausted", jobId: decision.jobId, message: "This document couldn't be read after the maximum number of attempts." };
        const requeued = await requeueJob(deps.admin, job!);
        if (!requeued) continue;
        return runClaimed(deps, requeued, document, provider);
      }
      case "retry": {
        const requeued = await requeueJob(deps.admin, job!);
        if (!requeued) continue;
        return runClaimed(deps, requeued, document, provider);
      }
      case "start_existing":
        return runClaimed(deps, job!, document, provider);
      case "create": {
        const created = await insertQueuedJob(deps.admin, {
          organizationId: input.organizationId,
          documentId: document.id,
          idempotencyKey: idempotencyKeyFor(identity),
          processingVersion: identity.processingVersion,
          provider: identity.provider,
          providerVersion: identity.providerVersion,
          maxAttempts: MAX_PROCESSING_ATTEMPTS,
          requestedBy: input.userId,
        });
        if (created === "CONFLICT") {
          // Same job created concurrently, or another run active for this
          // document under an older version. Decide again from what exists.
          const active = (await listJobsForDocument(deps.client, document.id)).find((candidate) => candidate.status === "QUEUED" || candidate.status === "PROCESSING");
          if (active && active.idempotencyKey !== idempotencyKeyFor(identity)) return { kind: "in_progress", jobId: active.id };
          continue;
        }
        return runClaimed(deps, created, document, provider);
      }
    }
  }
  return { kind: "unavailable", message: "This document is being read by another request. Try again in a moment." };
}

/** A future scheduler's entry point: run a QUEUED job by id, with no user. */
export async function runQueuedJob(deps: Omit<ProcessingDependencies, "client"> & { client?: Client }, job: ProcessingJob): Promise<ProcessOutcome> {
  const reader = deps.client ?? deps.admin;
  const document = await getVisibleDocument(reader, job.documentId);
  if (!document || document.organizationId !== job.organizationId) return { kind: "unavailable", message: "Document not found." };
  const availability = resolveProvider(document.mimeType as VerifiedMimeType, deps.providers);
  if (!availability.available) return { kind: "not_configured", message: availability.message };
  if (availability.provider.id !== job.provider || availability.provider.version !== job.providerVersion) {
    return { kind: "unavailable", message: "This job was queued for a reader this deployment no longer has." };
  }
  return runClaimed({ ...deps, client: reader }, job, document, availability.provider);
}

async function runClaimed(deps: ProcessingDependencies, queued: ProcessingJob, document: AppDocument, provider: TextExtractionProvider): Promise<ProcessOutcome> {
  const started = Date.now();
  const job = await claimJob(deps.admin, queued, deps.now());
  if (!job) return { kind: "in_progress", jobId: queued.id };

  const detail = { jobId: job.id, provider: job.provider, providerVersion: job.providerVersion, processingVersion: job.processingVersion, attempt: job.attempts };
  reportEvent("documents.processing_started", { scope: "documents", organizationId: job.organizationId, detail });

  const fail = async (category: FailureCategory): Promise<ProcessOutcome> => {
    await failJob(deps.admin, job, "PROCESSING", category, FAILURE_MESSAGES[category], deps.now()).catch((error) =>
      reportError(error, { scope: "documents", organizationId: job.organizationId, detail: { step: "failJob", jobId: job.id } }),
    );
    reportEvent("documents.processing_failed", { scope: "documents", organizationId: job.organizationId, detail: { ...detail, errorCategory: category, durationMs: Date.now() - started } }, "warning");
    return { kind: "failed", jobId: job.id, category, message: FAILURE_MESSAGES[category], canRetry: job.attempts < job.maxAttempts };
  };

  // The bytes are read again and checked again: this run parses them, and a
  // parser is where a malformed file does its damage.
  let download: DownloadResult;
  try {
    download = await deps.download(deps.client, document.storagePath, MAX_UPLOAD_BYTES);
  } catch {
    return fail("DOCUMENT_UNAVAILABLE");
  }
  if (!download.ok) return fail(download.reason === "too_large" ? "FILE_VALIDATION_FAILED" : "DOCUMENT_UNAVAILABLE");
  if (download.bytes.byteLength === 0 || download.bytes.byteLength > MAX_UPLOAD_BYTES) return fail("FILE_VALIDATION_FAILED");
  if (!verifyFileSignature(download.bytes.subarray(0, 16), document.mimeType ?? "").ok) return fail("FILE_VALIDATION_FAILED");

  const outcome = await runProvider(provider, { bytes: download.bytes, mimeType: document.mimeType as VerifiedMimeType }, deps.providerTimeoutMs);
  if (!outcome.ok) return fail(outcome.category);

  const draft = extractDocument(outcome.result);
  const durationMs = Date.now() - started;

  let extractionId: string;
  try {
    extractionId = await recordExtraction(deps.admin, { organizationId: job.organizationId, jobId: job.id, method: outcome.result.method, draft, durationMs });
  } catch (error) {
    reportError(error, { scope: "documents", organizationId: job.organizationId, detail: { step: "recordExtraction", jobId: job.id } });
    return fail("INTERNAL_ERROR");
  }

  reportEvent("documents.processing_completed", {
    scope: "documents",
    organizationId: job.organizationId,
    detail: {
      ...detail,
      status: draft.status,
      documentType: draft.classification.documentType,
      classificationConfidence: draft.classification.confidence,
      fieldCount: draft.fields.length,
      pageCount: draft.pageCount,
      warnings: draft.warnings.join(","),
      providerMs: outcome.durationMs,
      durationMs,
    },
  });

  return { kind: "completed", jobId: job.id, extractionId, status: draft.status, documentType: draft.classification.documentType, durationMs };
}
