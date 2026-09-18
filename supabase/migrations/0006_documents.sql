-- Documents: upload → storage → processing job → extracted data →
-- human confirmation (DESIGN brief §15). OCR/extraction providers are not
-- implemented in Phase 1 — this establishes the pipeline's shape so a real
-- provider can be plugged into document_processing_jobs.provider later.

create table documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  uploaded_by uuid references auth.users (id),
  kind document_kind not null default 'other',
  storage_bucket text not null default 'documents',
  storage_path text not null,
  original_filename text,
  mime_type text,
  size_bytes bigint,
  status document_status not null default 'uploaded',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index documents_organization_id_idx on documents (organization_id);
create index documents_status_idx on documents (status);

create trigger documents_set_updated_at
  before update on documents
  for each row execute function set_updated_at();

-- See 0003_helper_functions.sql for the pattern this follows.
create or replace function org_id_of_document(target_document_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select d.organization_id from documents d where d.id = target_document_id;
$$;

create table document_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents (id) on delete cascade,
  provider text not null,
  status document_status not null default 'uploaded',
  attempts int not null default 0,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index document_processing_jobs_document_id_idx on document_processing_jobs (document_id);

create table document_extracted_data (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents (id) on delete cascade,
  field_path text not null,
  value text,
  confidence numeric(4, 3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  is_confirmed boolean not null default false,
  confirmed_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

create index document_extracted_data_document_id_idx on document_extracted_data (document_id);

-- Polymorphic link between a document and the record it supports (a
-- transaction, an invoice, ...). Deliberately (document_id, related_type,
-- related_id) rather than several nullable FK columns, since the set of
-- linkable record types will grow. Trade-off, stated plainly: Postgres
-- can't enforce referential integrity across a polymorphic target, so an
-- orphaned related_id is possible if the target row is deleted outside a
-- transaction that also cleans this table up. Acceptable for Phase 1;
-- revisit with a trigger-based integrity check if this becomes load-bearing.
create table document_relationships (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents (id) on delete cascade,
  related_type text not null check (related_type in ('transaction', 'invoice')),
  related_id uuid not null,
  relationship text not null default 'attachment_for' check (relationship in ('source_of', 'attachment_for')),
  created_at timestamptz not null default now()
);

create index document_relationships_document_id_idx on document_relationships (document_id);
create index document_relationships_related_idx on document_relationships (related_type, related_id);
