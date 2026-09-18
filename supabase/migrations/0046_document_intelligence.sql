-- Document intelligence: processing jobs, immutable extractions, extracted
-- fields with evidence, and the provenance link from a tax figure back to the
-- field it was read from.
--
-- WHAT THIS REPLACES, AND WHY THAT IS SAFE
--
-- 0006 created `document_processing_jobs` and `document_extracted_data` as the
-- shape of a pipeline that did not exist. Both are dropped here and rebuilt:
--
--   * Neither has ever held a row: no code path writes them (verified in the
--     repository and against the remote project before this migration).
--   * Their RLS (0011) lets any write-capable member INSERT and UPDATE them.
--     For extraction results that is the one thing that must not be true — a
--     member calling the REST API directly could write any "extracted" value,
--     confidence or evidence they liked, and it would read as the product's.
--   * `document_extracted_data.is_confirmed` was a second, mutable
--     confirmation mechanism. Confirmation already exists, append-only and
--     attributable, in `tax_preparation_facts`; a parallel flag would be two
--     answers to "has a person accepted this value?".
--
-- `documents` and `document_relationships` are untouched. Upload lifecycle
-- (`documents.status`: pending / uploaded / rejected) stays exactly as it is;
-- processing state lives on jobs and extractions, never on the document row,
-- so reading a document can never hide it from the product.
--
-- WHO WRITES
--
-- Members have SELECT on all three tables and nothing else. Jobs, extractions
-- and fields are written only by server code, after it has authenticated and
-- authorized the caller, using the service role — the same arrangement as the
-- filing tables in 0044. The guard triggers below apply to the service role
-- too, so a bug in that code still cannot rewrite history.

drop table if exists document_extracted_data;
drop table if exists document_processing_jobs;

-- ── Processing jobs ─────────────────────────────────────────────────────

create table document_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  document_id uuid not null,

  status text not null default 'QUEUED'
    check (status in ('QUEUED', 'PROCESSING', 'SUCCEEDED', 'PARTIAL', 'REVIEW_REQUIRED', 'UNSUPPORTED', 'FAILED')),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 3 check (max_attempts between 1 and 10),

  /** document | processing version | provider | provider version. The same
   *  read of the same document is one job, whatever retries or double-clicks
   *  happen. */
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 300),
  processing_version text not null check (char_length(processing_version) between 1 and 64),
  provider text not null check (char_length(provider) between 1 and 64),
  provider_version text not null check (char_length(provider_version) between 1 and 32),

  /** A category and a sentence written by Countorra. Never a provider's own
   *  message, which could carry file contents or credentials. */
  failure_category text check (
    failure_category in ('DOCUMENT_UNAVAILABLE', 'FILE_VALIDATION_FAILED', 'PROVIDER_ERROR', 'PROVIDER_TIMEOUT', 'MALFORMED_PROVIDER_RESPONSE', 'LEASE_EXPIRED', 'INTERNAL_ERROR')
  ),
  failure_message text check (failure_message is null or char_length(failure_message) <= 300),

  requested_by uuid references auth.users (id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint document_processing_jobs_document_fkey
    foreign key (document_id, organization_id) references documents (id, organization_id) on delete cascade,
  constraint document_processing_jobs_id_org_unique unique (id, organization_id),
  constraint document_processing_jobs_idempotency_unique unique (organization_id, idempotency_key),
  constraint document_processing_jobs_attempts_bounded check (attempts <= max_attempts),
  constraint document_processing_jobs_failure_only_when_failed check ((status = 'FAILED') = (failure_category is not null))
);

-- At most one run in flight per document.
create unique index document_processing_jobs_one_active_idx
  on document_processing_jobs (document_id)
  where status in ('QUEUED', 'PROCESSING');

create index document_processing_jobs_document_idx
  on document_processing_jobs (organization_id, document_id, created_at desc);

create trigger document_processing_jobs_set_updated_at
  before update on document_processing_jobs
  for each row execute function set_updated_at();

comment on table document_processing_jobs is
  'One request to read a document under one processing version and provider version. Status moves only along the state machine in src/domain/documents/intelligence/state-machine.ts, enforced by document_processing_jobs_guard. There is no background worker: a job is run by an explicit, authorized request.';

-- ── Extractions ─────────────────────────────────────────────────────────

create table document_extractions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  document_id uuid not null,
  job_id uuid not null,
  /** 1, 2, 3 … per document. A newer extraction never replaces an older one. */
  version int not null check (version >= 1),

  status text not null check (status in ('SUCCEEDED', 'PARTIAL', 'REVIEW_REQUIRED', 'UNSUPPORTED')),
  processing_version text not null check (char_length(processing_version) between 1 and 64),
  provider text not null check (char_length(provider) between 1 and 64),
  provider_version text not null check (char_length(provider_version) between 1 and 32),
  method text not null check (method in ('PDF_TEXT_LAYER', 'OCR')),

  document_type text not null check (
    document_type in ('W2', 'FORM_1099_NEC', 'FORM_1099_MISC', 'FORM_1099_INT', 'FORM_1099_DIV', 'FORM_1099_B', 'FORM_1099_R', 'FORM_1098', 'FORM_1098_T', 'FORM_1095_A', 'PAY_STUB', 'BANK_STATEMENT', 'INVOICE', 'RECEIPT', 'OTHER_FINANCIAL', 'UNKNOWN')
  ),
  classification_confidence text not null check (classification_confidence in ('HIGH', 'MEDIUM', 'LOW', 'NONE')),
  classification_method text not null check (classification_method in ('CONTENT_SIGNALS', 'NO_TEXT')),
  classification_signals text[] not null default '{}' check (cardinality(classification_signals) <= 40),
  classification_review_reason text check (classification_review_reason is null or char_length(classification_review_reason) <= 300),

  /** Only when printed in the document. Never inferred from a date. */
  tax_year int check (tax_year is null or tax_year between 1990 and 2100),
  page_count int not null check (page_count >= 0),
  text_char_count int not null check (text_char_count >= 0),
  text_truncated boolean not null default false,
  warnings text[] not null default '{}' check (cardinality(warnings) <= 20),
  field_count int not null check (field_count between 0 and 500),
  duration_ms int check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now(),

  constraint document_extractions_document_fkey
    foreign key (document_id, organization_id) references documents (id, organization_id) on delete cascade,
  constraint document_extractions_job_fkey
    foreign key (job_id, organization_id) references document_processing_jobs (id, organization_id) on delete cascade,
  constraint document_extractions_id_org_unique unique (id, organization_id),
  constraint document_extractions_version_unique unique (document_id, version),
  constraint document_extractions_one_per_job unique (job_id)
);

create index document_extractions_document_idx
  on document_extractions (organization_id, document_id, version desc);

comment on table document_extractions is
  'Immutable result of one completed processing run. The full OCR or PDF text is deliberately NOT stored: only counts, the classification and its evidence, and the structured fields.';

-- ── Extracted fields ────────────────────────────────────────────────────

create table document_extracted_fields (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  extraction_id uuid not null,
  document_id uuid not null,
  position int not null check (position between 0 and 499),

  schema_id text not null check (char_length(schema_id) between 1 and 64),
  field_key text not null check (field_key ~ '^[a-z0-9_]{1,64}$'),
  label text not null check (char_length(label) between 1 and 200),
  section text not null check (
    section in ('DOCUMENT', 'PARTIES', 'INCOME', 'WITHHOLDING', 'DEDUCTIONS', 'STATE', 'LOCAL', 'PERIOD', 'BALANCES', 'TOTALS', 'LINE_ITEMS', 'TRANSACTIONS')
  ),
  box text check (box is null or char_length(box) <= 8),
  value_kind text not null check (value_kind in ('MONEY', 'DATE', 'TAX_YEAR', 'TEXT', 'CODE', 'PRESENCE')),

  /** As read, with identifiers masked. */
  raw_value text check (raw_value is null or char_length(raw_value) <= 200),
  normalized_decimal text check (normalized_decimal is null or normalized_decimal ~ '^-?[0-9]{1,15}(\.[0-9]{1,2})?$'),
  amount_minor bigint,
  currency char(3) check (currency is null or currency ~ '^[A-Z]{3}$'),
  currency_source text check (currency_source is null or currency_source in ('FORM_DEFINITION', 'DOCUMENT_TEXT')),
  normalized_date date,
  normalized_text text check (normalized_text is null or char_length(normalized_text) <= 200),

  review_state text not null check (
    review_state in ('HIGH_CONFIDENCE', 'MEDIUM_CONFIDENCE', 'LOW_CONFIDENCE', 'UNREADABLE', 'MISSING', 'CONFLICT')
  ),
  review_reason text check (review_reason is null or char_length(review_reason) <= 300),
  /** Only what the provider reported. Never computed. */
  provider_confidence numeric(4, 3) check (provider_confidence is null or (provider_confidence >= 0 and provider_confidence <= 1)),
  page_number int check (page_number is null or page_number >= 1),
  line_index int check (line_index is null or line_index >= 0),
  /** Only coordinates the provider reported. */
  source_position jsonb check (source_position is null or jsonb_typeof(source_position) = 'object'),
  method text not null check (char_length(method) between 1 and 120),
  created_at timestamptz not null default now(),

  constraint document_extracted_fields_extraction_fkey
    foreign key (extraction_id, organization_id) references document_extractions (id, organization_id) on delete cascade,
  constraint document_extracted_fields_document_fkey
    foreign key (document_id, organization_id) references documents (id, organization_id) on delete cascade,
  constraint document_extracted_fields_id_org_unique unique (id, organization_id),
  constraint document_extracted_fields_key_unique unique (extraction_id, field_key),
  constraint document_extracted_fields_amount_has_currency check (amount_minor is null or currency is not null),
  -- A field that was not read carries no value — not a zero, not a guess.
  constraint document_extracted_fields_no_value_when_unread check (
    review_state not in ('UNREADABLE', 'MISSING', 'CONFLICT')
    or (normalized_decimal is null and amount_minor is null and normalized_date is null and normalized_text is null)
  ),
  -- Backstop for the masking in normalization.ts: nothing shaped like an SSN
  -- or ITIN is ever stored, whatever the application does.
  constraint document_extracted_fields_no_ssn check (
    (raw_value is null or raw_value !~ '(^|[^0-9])[0-9]{3}[- .]?[0-9]{2}[- .]?[0-9]{4}([^0-9]|$)')
    and (normalized_text is null or normalized_text !~ '(^|[^0-9])[0-9]{3}[- .]?[0-9]{2}[- .]?[0-9]{4}([^0-9]|$)')
  )
);

create index document_extracted_fields_extraction_idx
  on document_extracted_fields (extraction_id, position);
create index document_extracted_fields_document_idx
  on document_extracted_fields (organization_id, document_id);

comment on table document_extracted_fields is
  'One extracted value with its evidence: page, box, method, raw and normalized value, review state. Immutable. EXTRACTED IS NOT CONFIRMED — a value becomes a tax figure only as a PROPOSED tax_preparation_facts row that a person later confirms.';

-- ── Guards ──────────────────────────────────────────────────────────────

create or replace function document_processing_jobs_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'document_processing_jobs are history and cannot be deleted directly' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'QUEUED' or new.attempts <> 0 or new.started_at is not null or new.completed_at is not null or new.failure_category is not null then
      raise exception 'a document processing job starts QUEUED, with no attempts' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.id <> old.id or new.organization_id <> old.organization_id or new.document_id <> old.document_id
     or new.idempotency_key <> old.idempotency_key or new.processing_version <> old.processing_version
     or new.provider <> old.provider or new.provider_version <> old.provider_version
     or new.max_attempts <> old.max_attempts or new.created_at <> old.created_at then
    raise exception 'a document processing job''s identity cannot change' using errcode = 'check_violation';
  end if;

  if new.requested_by is distinct from old.requested_by
     and not (new.requested_by is null and pg_trigger_depth() > 1) then
    raise exception 'document_processing_jobs.requested_by cannot be changed' using errcode = 'check_violation';
  end if;

  if new.status = old.status then
    if (to_jsonb(new) - 'requested_by' - 'updated_at') <> (to_jsonb(old) - 'requested_by' - 'updated_at') then
      raise exception 'a document processing job changes only by moving to another status' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if not (
    (old.status = 'QUEUED' and new.status in ('PROCESSING', 'FAILED'))
    or (old.status = 'PROCESSING' and new.status in ('SUCCEEDED', 'PARTIAL', 'REVIEW_REQUIRED', 'UNSUPPORTED', 'FAILED'))
    or (old.status = 'FAILED' and new.status = 'QUEUED')
  ) then
    raise exception 'a document processing job cannot move from % to %', old.status, new.status using errcode = 'check_violation';
  end if;

  if old.status = 'QUEUED' and new.status = 'PROCESSING' then
    if new.attempts <> old.attempts + 1 or new.started_at is null then
      raise exception 'starting a run records one attempt and its start time' using errcode = 'check_violation';
    end if;
  elsif new.attempts <> old.attempts then
    raise exception 'attempts change only when a run starts' using errcode = 'check_violation';
  end if;

  if old.status = 'FAILED' and new.status = 'QUEUED' and old.attempts >= old.max_attempts then
    raise exception 'no attempts remain for this document processing job' using errcode = 'check_violation';
  end if;

  if new.status in ('SUCCEEDED', 'PARTIAL', 'REVIEW_REQUIRED', 'UNSUPPORTED') then
    if new.completed_at is null then
      raise exception 'a completed job records when it completed' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from document_extractions e where e.job_id = new.id and e.status = new.status) then
      raise exception 'a completed job must have its extraction, with the same status' using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger document_processing_jobs_guard
  before insert or update or delete on document_processing_jobs
  for each row execute function document_processing_jobs_guard();

create or replace function document_extractions_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_job record;
  v_next int;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'document_extractions are immutable evidence and cannot be deleted directly' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    raise exception 'document_extractions are immutable: reading again creates a new version' using errcode = 'check_violation';
  end if;

  select id, organization_id, document_id, status, provider, provider_version, processing_version
    into v_job
    from document_processing_jobs
   where id = new.job_id and organization_id = new.organization_id;

  if v_job.id is null then
    raise exception 'document_extractions: the job does not exist in this organization' using errcode = 'foreign_key_violation';
  end if;
  if v_job.status <> 'PROCESSING' then
    raise exception 'document_extractions: only a running job can record an extraction' using errcode = 'check_violation';
  end if;
  if v_job.document_id <> new.document_id or v_job.provider <> new.provider or v_job.provider_version <> new.provider_version or v_job.processing_version <> new.processing_version then
    raise exception 'document_extractions must match the job that produced them' using errcode = 'check_violation';
  end if;

  select coalesce(max(version), 0) + 1 into v_next from document_extractions where document_id = new.document_id;
  if new.version <> v_next then
    raise exception 'document_extractions.version must be the next version (%)', v_next using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger document_extractions_guard
  before insert or update or delete on document_extractions
  for each row execute function document_extractions_guard();

create or replace function document_extracted_fields_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_extraction record;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'document_extracted_fields are immutable evidence and cannot be deleted directly' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    raise exception 'document_extracted_fields are immutable evidence' using errcode = 'check_violation';
  end if;

  select e.id, e.document_id, j.status as job_status
    into v_extraction
    from document_extractions e
    join document_processing_jobs j on j.id = e.job_id
   where e.id = new.extraction_id and e.organization_id = new.organization_id;

  if v_extraction.id is null then
    raise exception 'document_extracted_fields: the extraction does not exist in this organization' using errcode = 'foreign_key_violation';
  end if;
  if v_extraction.document_id <> new.document_id then
    raise exception 'document_extracted_fields must belong to the extraction''s document' using errcode = 'check_violation';
  end if;
  if v_extraction.job_status <> 'PROCESSING' then
    raise exception 'document_extracted_fields can only be recorded while their run is in progress' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger document_extracted_fields_guard
  before insert or update or delete on document_extracted_fields
  for each row execute function document_extracted_fields_guard();

-- ── Recording a result: one transaction ─────────────────────────────────
--
-- The extraction, every field and the job's completion either all happen or
-- none do. Without this, a failure between the inserts would leave an
-- extraction with half its fields, which reads as a complete result.

create or replace function record_document_extraction(p_organization_id uuid, p_job_id uuid, p_extraction jsonb, p_fields jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_job record;
  v_version int;
  v_extraction_id uuid;
  v_field jsonb;
  v_position int := 0;
begin
  select id, document_id, status, provider, provider_version, processing_version
    into v_job
    from document_processing_jobs
   where id = p_job_id and organization_id = p_organization_id
   for update;

  if v_job.id is null then
    raise exception 'record_document_extraction: job not found' using errcode = 'foreign_key_violation';
  end if;
  if jsonb_typeof(p_fields) <> 'array' or jsonb_array_length(p_fields) > 500 then
    raise exception 'record_document_extraction: fields must be an array of at most 500' using errcode = 'check_violation';
  end if;
  if (p_extraction->>'field_count')::int <> jsonb_array_length(p_fields) then
    raise exception 'record_document_extraction: field_count does not match the fields supplied' using errcode = 'check_violation';
  end if;

  select coalesce(max(version), 0) + 1 into v_version from document_extractions where document_id = v_job.document_id;

  insert into document_extractions (
    organization_id, document_id, job_id, version, status, processing_version, provider, provider_version, method,
    document_type, classification_confidence, classification_method, classification_signals, classification_review_reason,
    tax_year, page_count, text_char_count, text_truncated, warnings, field_count, duration_ms
  ) values (
    p_organization_id, v_job.document_id, v_job.id, v_version, p_extraction->>'status', v_job.processing_version, v_job.provider, v_job.provider_version, p_extraction->>'method',
    p_extraction->>'document_type', p_extraction->>'classification_confidence', p_extraction->>'classification_method',
    coalesce(array(select jsonb_array_elements_text(p_extraction->'classification_signals')), '{}'),
    p_extraction->>'classification_review_reason',
    (p_extraction->>'tax_year')::int, (p_extraction->>'page_count')::int, (p_extraction->>'text_char_count')::int,
    coalesce((p_extraction->>'text_truncated')::boolean, false),
    coalesce(array(select jsonb_array_elements_text(p_extraction->'warnings')), '{}'),
    (p_extraction->>'field_count')::int, (p_extraction->>'duration_ms')::int
  )
  returning id into v_extraction_id;

  for v_field in select value from jsonb_array_elements(p_fields) loop
    insert into document_extracted_fields (
      organization_id, extraction_id, document_id, position, schema_id, field_key, label, section, box, value_kind,
      raw_value, normalized_decimal, amount_minor, currency, currency_source, normalized_date, normalized_text,
      review_state, review_reason, provider_confidence, page_number, line_index, source_position, method
    ) values (
      p_organization_id, v_extraction_id, v_job.document_id, v_position, v_field->>'schema_id', v_field->>'field_key', v_field->>'label', v_field->>'section', v_field->>'box', v_field->>'value_kind',
      v_field->>'raw_value', v_field->>'normalized_decimal', (v_field->>'amount_minor')::bigint, v_field->>'currency', v_field->>'currency_source',
      (v_field->>'normalized_date')::date, v_field->>'normalized_text',
      v_field->>'review_state', v_field->>'review_reason', (v_field->>'provider_confidence')::numeric,
      (v_field->>'page_number')::int, (v_field->>'line_index')::int,
      case when jsonb_typeof(v_field->'source_position') = 'object' then v_field->'source_position' else null end,
      v_field->>'method'
    );
    v_position := v_position + 1;
  end loop;

  update document_processing_jobs
     set status = p_extraction->>'status', completed_at = now()
   where id = v_job.id;

  return v_extraction_id;
end;
$$;

-- Service role only. A member must not be able to call this through the Data
-- API and record an extraction of their choosing.
revoke execute on function record_document_extraction(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function record_document_extraction(uuid, uuid, jsonb, jsonb) to service_role;

-- ── Row-level security: read-only for members ───────────────────────────

alter table document_processing_jobs enable row level security;
alter table document_extractions enable row level security;
alter table document_extracted_fields enable row level security;

create policy document_processing_jobs_select_member on document_processing_jobs
  for select using (is_org_member(organization_id));
create policy document_extractions_select_member on document_extractions
  for select using (is_org_member(organization_id));
create policy document_extracted_fields_select_member on document_extracted_fields
  for select using (is_org_member(organization_id));

-- Defence in depth under the absent write policies.
revoke insert, update, delete on document_processing_jobs, document_extractions, document_extracted_fields from anon, authenticated;

-- ── Provenance from a tax figure to the field it was read from ──────────

alter table tax_preparation_facts add column evidence_extraction_field_id uuid;

-- Composite, same organization; SET NULL of the column only, for the reason
-- given on tax_preparation_facts_document_fkey in 0042.
alter table tax_preparation_facts
  add constraint tax_preparation_facts_extraction_field_fkey
  foreign key (evidence_extraction_field_id, organization_id) references document_extracted_fields (id, organization_id)
  on delete set null (evidence_extraction_field_id);

create index tax_preparation_facts_extraction_field_idx
  on tax_preparation_facts (evidence_extraction_field_id)
  where evidence_extraction_field_id is not null;

-- One proposal per extracted field. Reviewing it (confirm, reject) supersedes
-- the proposal and carries the link forward, so only the original is unique.
create unique index tax_preparation_facts_one_proposal_per_field_idx
  on tax_preparation_facts (evidence_extraction_field_id)
  where evidence_extraction_field_id is not null and supersedes_fact_id is null;

comment on column tax_preparation_facts.evidence_extraction_field_id is
  'The extracted field this figure was read from, if any. A figure with this set entered as a PROPOSED DOCUMENT fact carrying exactly the extracted amount; only a person''s review makes it CONFIRMED.';

create or replace function tax_preparation_facts_extraction_evidence_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_field record;
begin
  if new.evidence_extraction_field_id is null then
    return new;
  end if;

  select f.id, f.document_id, f.amount_minor, f.currency, f.review_state
    into v_field
    from document_extracted_fields f
   where f.id = new.evidence_extraction_field_id and f.organization_id = new.organization_id;

  if v_field.id is null then
    raise exception 'tax_preparation_facts: the extracted field does not exist in this organization' using errcode = 'foreign_key_violation';
  end if;
  if new.source <> 'DOCUMENT' then
    raise exception 'a figure linked to an extracted field must have source DOCUMENT' using errcode = 'check_violation';
  end if;
  if new.evidence_document_id is distinct from v_field.document_id then
    raise exception 'a figure linked to an extracted field must name that field''s document' using errcode = 'check_violation';
  end if;

  -- The original link: a proposal, carrying exactly what was extracted. A
  -- reviewer's later row (supersedes_fact_id set) may correct the amount —
  -- that correction is the person's, and is attributed to them.
  if new.supersedes_fact_id is null then
    if new.state <> 'PROPOSED' then
      raise exception 'an extracted value enters Tax preparation only as a proposal' using errcode = 'check_violation';
    end if;
    if v_field.review_state not in ('HIGH_CONFIDENCE', 'MEDIUM_CONFIDENCE', 'LOW_CONFIDENCE') then
      raise exception 'this extracted field has no readable value to propose' using errcode = 'check_violation';
    end if;
    if new.amount_minor is distinct from v_field.amount_minor or new.currency is distinct from v_field.currency then
      raise exception 'a proposal must carry the extracted amount and currency' using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger tax_preparation_facts_extraction_evidence_guard
  before insert on tax_preparation_facts
  for each row execute function tax_preparation_facts_extraction_evidence_guard();
