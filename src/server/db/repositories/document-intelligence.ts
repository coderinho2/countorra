import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, DocumentExtractedFieldRow, DocumentExtractionRow, DocumentProcessingJobRow, Json } from "@/types/database";
import type { ProviderMethod } from "@/domain/documents/intelligence/provider";
import type { StoredField } from "@/domain/documents/intelligence/proposals";
import type {
  ClassificationConfidence,
  ClassificationMethod,
  CurrencySource,
  DocumentType,
  ExtractedFieldDraft,
  ExtractionDraft,
  ExtractionStatus,
  ExtractionWarning,
  FailureCategory,
  FieldReviewState,
  FieldSection,
  FieldValueKind,
  ProcessingJobStatus,
  SourcePosition,
} from "@/domain/documents/intelligence/types";

type Client = SupabaseClient<Database>;

/**
 * Document intelligence persistence.
 *
 * READS take the caller's RLS-scoped client: a member sees their own
 * organization's jobs, extractions and fields, and nothing else.
 *
 * WRITES take the service-role client, and only ever after the calling server
 * action has authenticated and authorized the member (0046: members have no
 * write policy on these tables). The guard triggers still apply to that
 * client, so these functions cannot break the state machine or rewrite an
 * extraction even if they were called wrongly.
 */

// ── Shapes ──────────────────────────────────────────────────────────────

export interface ProcessingJob {
  id: string;
  organizationId: string;
  documentId: string;
  status: ProcessingJobStatus;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
  processingVersion: string;
  provider: string;
  providerVersion: string;
  failureCategory: FailureCategory | null;
  failureMessage: string | null;
  requestedBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredExtraction {
  id: string;
  organizationId: string;
  documentId: string;
  jobId: string;
  version: number;
  status: ExtractionStatus;
  processingVersion: string;
  provider: string;
  providerVersion: string;
  method: ProviderMethod;
  documentType: DocumentType;
  classificationConfidence: ClassificationConfidence;
  classificationMethod: ClassificationMethod;
  classificationSignals: readonly string[];
  classificationReviewReason: string | null;
  taxYear: number | null;
  pageCount: number;
  textCharCount: number;
  textTruncated: boolean;
  warnings: readonly ExtractionWarning[];
  fieldCount: number;
  durationMs: number | null;
  createdAt: string;
}

export interface StoredExtractedField extends StoredField {
  organizationId: string;
  position: number;
  section: FieldSection;
  valueKind: FieldValueKind;
  rawValue: string | null;
  currencySource: CurrencySource | null;
  normalizedDate: string | null;
  normalizedText: string | null;
  reviewReason: string | null;
  providerConfidence: number | null;
  lineIndex: number | null;
  sourcePosition: SourcePosition | null;
  method: string;
  createdAt: string;
}

const JOB_COLUMNS =
  "id, organization_id, document_id, status, attempts, max_attempts, idempotency_key, processing_version, provider, provider_version, failure_category, failure_message, requested_by, started_at, completed_at, created_at, updated_at";
const EXTRACTION_COLUMNS =
  "id, organization_id, document_id, job_id, version, status, processing_version, provider, provider_version, method, document_type, classification_confidence, classification_method, classification_signals, classification_review_reason, tax_year, page_count, text_char_count, text_truncated, warnings, field_count, duration_ms, created_at";
const FIELD_COLUMNS =
  "id, organization_id, extraction_id, document_id, position, schema_id, field_key, label, section, box, value_kind, raw_value, normalized_decimal, amount_minor, currency, currency_source, normalized_date, normalized_text, review_state, review_reason, provider_confidence, page_number, line_index, source_position, method, created_at";

function toJob(row: DocumentProcessingJobRow): ProcessingJob {
  return {
    id: row.id,
    organizationId: row.organization_id,
    documentId: row.document_id,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    idempotencyKey: row.idempotency_key,
    processingVersion: row.processing_version,
    provider: row.provider,
    providerVersion: row.provider_version,
    failureCategory: row.failure_category,
    failureMessage: row.failure_message,
    requestedBy: row.requested_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toExtraction(row: DocumentExtractionRow): StoredExtraction {
  return {
    id: row.id,
    organizationId: row.organization_id,
    documentId: row.document_id,
    jobId: row.job_id,
    version: row.version,
    status: row.status,
    processingVersion: row.processing_version,
    provider: row.provider,
    providerVersion: row.provider_version,
    method: row.method,
    documentType: row.document_type,
    classificationConfidence: row.classification_confidence,
    classificationMethod: row.classification_method,
    classificationSignals: row.classification_signals ?? [],
    classificationReviewReason: row.classification_review_reason,
    taxYear: row.tax_year,
    pageCount: row.page_count,
    textCharCount: row.text_char_count,
    textTruncated: row.text_truncated,
    warnings: (row.warnings ?? []) as ExtractionWarning[],
    fieldCount: row.field_count,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

function toField(row: DocumentExtractedFieldRow): StoredExtractedField {
  const position = row.source_position as Record<string, unknown> | null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    extractionId: row.extraction_id,
    documentId: row.document_id,
    position: row.position,
    schemaId: row.schema_id,
    fieldKey: row.field_key,
    label: row.label,
    section: row.section,
    box: row.box,
    valueKind: row.value_kind,
    rawValue: row.raw_value,
    normalizedDecimal: row.normalized_decimal,
    amountMinor: row.amount_minor,
    currency: row.currency,
    currencySource: row.currency_source,
    normalizedDate: row.normalized_date,
    normalizedText: row.normalized_text,
    reviewState: row.review_state as FieldReviewState,
    reviewReason: row.review_reason,
    providerConfidence: row.provider_confidence === null ? null : Number(row.provider_confidence),
    pageNumber: row.page_number,
    lineIndex: row.line_index,
    sourcePosition:
      position && typeof position.x === "number" && typeof position.y === "number"
        ? {
            x: position.x,
            y: position.y,
            width: typeof position.width === "number" ? position.width : null,
            height: typeof position.height === "number" ? position.height : null,
            units: position.units === "pixels" ? "pixels" : "pdf_points",
          }
        : null,
    method: row.method,
    createdAt: row.created_at,
  };
}

// ── Reads (caller's client) ─────────────────────────────────────────────

export async function listJobsForDocument(client: Client, documentId: string): Promise<ProcessingJob[]> {
  const { data, error } = await client.from("document_processing_jobs").select(JOB_COLUMNS).eq("document_id", documentId).order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data as DocumentProcessingJobRow[]).map(toJob);
}

export async function getJob(client: Client, jobId: string): Promise<ProcessingJob | null> {
  const { data, error } = await client.from("document_processing_jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle();
  if (error) throw error;
  return data ? toJob(data as DocumentProcessingJobRow) : null;
}

export async function listExtractionsForDocument(client: Client, documentId: string): Promise<StoredExtraction[]> {
  const { data, error } = await client.from("document_extractions").select(EXTRACTION_COLUMNS).eq("document_id", documentId).order("version", { ascending: false }).limit(25);
  if (error) throw error;
  return (data as DocumentExtractionRow[]).map(toExtraction);
}

export async function getExtraction(client: Client, extractionId: string): Promise<StoredExtraction | null> {
  const { data, error } = await client.from("document_extractions").select(EXTRACTION_COLUMNS).eq("id", extractionId).maybeSingle();
  if (error) throw error;
  return data ? toExtraction(data as DocumentExtractionRow) : null;
}

export async function listFieldsForExtraction(client: Client, extractionId: string): Promise<StoredExtractedField[]> {
  const { data, error } = await client.from("document_extracted_fields").select(FIELD_COLUMNS).eq("extraction_id", extractionId).order("position", { ascending: true }).limit(500);
  if (error) throw error;
  return (data as DocumentExtractedFieldRow[]).map(toField);
}

/**
 * The latest job and latest extraction for many documents, in two queries —
 * for the document list, which must not issue one query per row.
 */
export async function latestProcessingByDocument(
  client: Client,
  organizationId: string,
  documentIds: readonly string[],
): Promise<Map<string, { job: ProcessingJob | null; extraction: StoredExtraction | null }>> {
  const result = new Map<string, { job: ProcessingJob | null; extraction: StoredExtraction | null }>();
  if (documentIds.length === 0) return result;
  const ids = [...documentIds].slice(0, 200);

  const [jobs, extractions] = await Promise.all([
    client.from("document_processing_jobs").select(JOB_COLUMNS).eq("organization_id", organizationId).in("document_id", ids).order("created_at", { ascending: false }).limit(1000),
    client.from("document_extractions").select(EXTRACTION_COLUMNS).eq("organization_id", organizationId).in("document_id", ids).order("version", { ascending: false }).limit(1000),
  ]);
  if (jobs.error) throw jobs.error;
  if (extractions.error) throw extractions.error;

  for (const id of ids) result.set(id, { job: null, extraction: null });
  for (const row of jobs.data as DocumentProcessingJobRow[]) {
    const entry = result.get(row.document_id);
    if (entry && !entry.job) entry.job = toJob(row);
  }
  for (const row of extractions.data as DocumentExtractionRow[]) {
    const entry = result.get(row.document_id);
    if (entry && !entry.extraction) entry.extraction = toExtraction(row);
  }
  return result;
}

/** Fields of many extractions at once, for cross-document checks. Bounded. */
export async function listFieldsForExtractions(client: Client, organizationId: string, extractionIds: readonly string[]): Promise<StoredExtractedField[]> {
  if (extractionIds.length === 0) return [];
  const { data, error } = await client
    .from("document_extracted_fields")
    .select(FIELD_COLUMNS)
    .eq("organization_id", organizationId)
    .in("extraction_id", [...extractionIds].slice(0, 100))
    .in("value_kind", ["MONEY", "DATE"])
    .limit(2000);
  if (error) throw error;
  return (data as DocumentExtractedFieldRow[]).map(toField);
}

// ── Writes (service-role client, after authorization) ───────────────────

const UNIQUE_VIOLATION = "23505";

export async function insertQueuedJob(
  admin: Client,
  input: { organizationId: string; documentId: string; idempotencyKey: string; processingVersion: string; provider: string; providerVersion: string; maxAttempts: number; requestedBy: string },
): Promise<ProcessingJob | "CONFLICT"> {
  const { data, error } = await admin
    .from("document_processing_jobs")
    .insert({
      organization_id: input.organizationId,
      document_id: input.documentId,
      idempotency_key: input.idempotencyKey,
      processing_version: input.processingVersion,
      provider: input.provider,
      provider_version: input.providerVersion,
      max_attempts: input.maxAttempts,
      requested_by: input.requestedBy,
    })
    .select(JOB_COLUMNS)
    .single();
  // A concurrent request created the same job, or another run is active for
  // this document. The caller re-reads and decides again.
  if (error && (error as { code?: string }).code === UNIQUE_VIOLATION) return "CONFLICT";
  if (error) throw error;
  return toJob(data as DocumentProcessingJobRow);
}

/** QUEUED → PROCESSING, counting an attempt. Null when another run claimed it. */
export async function claimJob(admin: Client, job: ProcessingJob, now: Date): Promise<ProcessingJob | null> {
  const { data, error } = await admin
    .from("document_processing_jobs")
    .update({ status: "PROCESSING", attempts: job.attempts + 1, started_at: now.toISOString() })
    .eq("id", job.id)
    .eq("organization_id", job.organizationId)
    .eq("status", "QUEUED")
    .eq("attempts", job.attempts)
    .select(JOB_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return data ? toJob(data as DocumentProcessingJobRow) : null;
}

export async function failJob(
  admin: Client,
  job: Pick<ProcessingJob, "id" | "organizationId">,
  from: Extract<ProcessingJobStatus, "QUEUED" | "PROCESSING">,
  category: FailureCategory,
  message: string,
  now: Date,
): Promise<ProcessingJob | null> {
  const { data, error } = await admin
    .from("document_processing_jobs")
    .update({ status: "FAILED", failure_category: category, failure_message: message.slice(0, 300), completed_at: now.toISOString() })
    .eq("id", job.id)
    .eq("organization_id", job.organizationId)
    .eq("status", from)
    .select(JOB_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return data ? toJob(data as DocumentProcessingJobRow) : null;
}

/** FAILED → QUEUED, for a retry. The trigger refuses it once attempts run out. */
export async function requeueJob(admin: Client, job: Pick<ProcessingJob, "id" | "organizationId">): Promise<ProcessingJob | null> {
  const { data, error } = await admin
    .from("document_processing_jobs")
    .update({ status: "QUEUED", failure_category: null, failure_message: null, started_at: null, completed_at: null })
    .eq("id", job.id)
    .eq("organization_id", job.organizationId)
    .eq("status", "FAILED")
    .select(JOB_COLUMNS)
    .maybeSingle();
  if (error && (error as { code?: string }).code === UNIQUE_VIOLATION) return null;
  if (error) throw error;
  return data ? toJob(data as DocumentProcessingJobRow) : null;
}

/** The extraction, its fields and the job's completion, in one transaction. */
export async function recordExtraction(
  admin: Client,
  input: { organizationId: string; jobId: string; method: ProviderMethod; draft: ExtractionDraft; durationMs: number },
): Promise<string> {
  const { draft } = input;
  const extraction = {
    status: draft.status,
    method: input.method,
    document_type: draft.classification.documentType,
    classification_confidence: draft.classification.confidence,
    classification_method: draft.classification.method,
    classification_signals: draft.classification.signals.slice(0, 40),
    classification_review_reason: draft.classification.reviewReason,
    tax_year: draft.taxYear,
    page_count: draft.pageCount,
    text_char_count: draft.textCharCount,
    text_truncated: draft.textTruncated,
    warnings: draft.warnings.slice(0, 20),
    field_count: draft.fields.length,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
  };
  const fields = draft.fields.map((field: ExtractedFieldDraft) => ({
    schema_id: field.schemaId,
    field_key: field.fieldKey,
    label: field.label,
    section: field.section,
    box: field.box,
    value_kind: field.valueKind,
    raw_value: field.rawValue,
    normalized_decimal: field.normalizedDecimal,
    amount_minor: field.amountMinor,
    currency: field.currency,
    currency_source: field.currencySource,
    normalized_date: field.normalizedDate,
    normalized_text: field.normalizedText,
    review_state: field.reviewState,
    review_reason: field.reviewReason,
    provider_confidence: field.providerConfidence,
    page_number: field.pageNumber,
    line_index: field.lineIndex,
    source_position: field.position as unknown as Json,
    method: field.method,
  }));

  const { data, error } = await admin.rpc("record_document_extraction", {
    p_organization_id: input.organizationId,
    p_job_id: input.jobId,
    p_extraction: extraction as unknown as Json,
    p_fields: fields as unknown as Json,
  });
  if (error) throw error;
  return data as string;
}
