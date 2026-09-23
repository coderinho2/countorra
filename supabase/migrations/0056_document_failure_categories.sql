-- ════════════════════════════════════════════════════════════════════════════
-- 0056 — finer document-processing failure categories
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
--
--   Every failure of a document read collapsed into `PROVIDER_ERROR`. That is
--   one row for six different problems with six different answers: expired
--   credentials (an operator's problem), a rate limit (wait), a file the
--   reader cannot parse (try another format), a file over the reader's size
--   ceiling (split it), an unreadable photo (retake it), and a genuine
--   outage. A person got the same sentence for all of them, and nobody could
--   tell from the table which had happened.
--
--   The categories below are Countorra's own, not a vendor's. The adapter
--   translates its provider's errors into them
--   (TextExtractionProvider.classifyError), so no AWS error name, request id
--   or ARN is ever stored here.
--
-- ── WHAT IT DOES ────────────────────────────────────────────────────────────
--
--   1. Widens document_processing_jobs.failure_category with six categories.
--   2. operations_schema_version() → '0056'.
--
-- ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
--
--   PURELY ADDITIVE. No row is rewritten and no existing value is remapped:
--   jobs that already failed keep `PROVIDER_ERROR`, which remains a valid
--   category and is still what the application writes when the adapter cannot
--   place an error. Nothing is dropped, no table, policy, grant or index
--   changes, and no financial record is touched.
--
--   Re-running is harmless: the constraint is dropped by name if present and
--   recreated.
--
-- ── DEPLOY ORDER ────────────────────────────────────────────────────────────
--
--   MIGRATE FIRST, THEN DEPLOY, for the same reason as 0055: the new code
--   writes the new categories and the old constraint would reject them. The
--   previous build writes only categories this constraint still accepts, so
--   pushing ahead of the deploy is safe.
--
--   Rollback (only if no job has recorded a new category):
--
--   alter table document_processing_jobs drop constraint document_processing_jobs_failure_category_check;
--   alter table document_processing_jobs add constraint document_processing_jobs_failure_category_check check (
--     failure_category in ('DOCUMENT_UNAVAILABLE', 'FILE_VALIDATION_FAILED', 'PROVIDER_ERROR', 'PROVIDER_TIMEOUT', 'MALFORMED_PROVIDER_RESPONSE', 'LEASE_EXPIRED', 'INTERNAL_ERROR'));
--   create or replace function operations_schema_version() returns text language sql immutable as $$ select '0055'::text $$;

alter table document_processing_jobs
  drop constraint if exists document_processing_jobs_failure_category_check;

alter table document_processing_jobs
  add constraint document_processing_jobs_failure_category_check check (
    failure_category in (
      -- 0046, unchanged and still written.
      'DOCUMENT_UNAVAILABLE',
      'FILE_VALIDATION_FAILED',
      'PROVIDER_ERROR',
      'PROVIDER_TIMEOUT',
      'MALFORMED_PROVIDER_RESPONSE',
      'LEASE_EXPIRED',
      'INTERNAL_ERROR',
      -- 0056. Each maps to one sentence a person can act on, and to whether
      -- trying again could possibly help (PERMANENT_FAILURES in
      -- src/domain/documents/intelligence/types.ts).
      'UNSUPPORTED_DOCUMENT',
      'DOCUMENT_TOO_LARGE',
      'DOCUMENT_UNREADABLE',
      'PROVIDER_AUTH_ERROR',
      'PROVIDER_THROTTLED',
      'PROVIDER_UNAVAILABLE'
    )
  );

create or replace function operations_schema_version() returns text language sql immutable as $$ select '0056'::text $$;
