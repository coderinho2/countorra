-- ════════════════════════════════════════════════════════════════════════════
-- 0058 — an identity document's ORIGINAL expires; what was read from it stays
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
--
--   0055 made the database enforce what an identity document may leave behind:
--   no money, no identifier, at most a masked four-digit tail. It said nothing
--   about the FILE, and the file is the photograph of the licence — the name,
--   the date of birth, the address, the document number and the MRZ that the
--   normalizer was so careful to discard, all still there.
--
--   Storage has no expiry of its own, and the only sweep that existed
--   (reclaimAbandonedUploads) covers uploads that were never confirmed. So a
--   CONFIRMED identity document was kept until somebody deleted it by hand,
--   which for most people is never. The extraction was minimal and the
--   original was permanent, and the second fact undid the first.
--
-- ── WHAT IT DOES ────────────────────────────────────────────────────────────
--
--   1. documents gains two timestamps: when the original expires, and when it
--      was actually removed. No new table — a retention window is a property
--      of a document, not an entity of its own.
--   2. A partial index so the sweep reads only what is due.
--   3. A trigger: recording an extraction whose document_type is an identity
--      class sets the expiry to seven days out. In the DATABASE, so that no
--      application path can forget to — including a direct service-role write.
--   4. Two service-role functions: list what is due, and mark one removed.
--      Both take the organization id, so a wrong document id cannot reach
--      another tenant's row.
--   5. operations_schema_version() -> '0058'.
--
-- ── WHY SEVEN DAYS ──────────────────────────────────────────────────────────
--
--   An operational window, not a legal one, and no law is being cited. The
--   product reads an identity document once; afterwards the image has no
--   downstream use at all, and its only remaining purpose is a person
--   confirming they uploaded the right thing. Seven days covers a retry, a
--   weekend and a second look. See src/domain/documents/retention.ts, which
--   holds the same number and is what the product explains; a test asserts the
--   two agree.
--
--   FINANCIAL DOCUMENTS ARE UNTOUCHED. A receipt is evidence for a figure in a
--   tax return and may be wanted years later. The trigger fires for identity
--   classes only, and every other document keeps NULL — which this migration
--   treats as "no expiry", so the default for everything that exists today is
--   exactly the behaviour it has now.
--
-- ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
--
--   Nothing is deleted BY this migration. No existing row is given an expiry:
--   the trigger fires on new extractions only, so identity documents already
--   stored keep their originals until they are read again or removed by hand.
--   That is deliberate — a migration that silently deleted people's files on
--   deploy would be the wrong way to introduce a retention policy. It also
--   means the first sweep has nothing to do, which is the safest possible
--   first run.
--
--   No policy changes. No column is dropped. No RLS is altered: the two new
--   columns are read under the same documents policies as every other column.
--
-- ── DEPLOY ORDER ────────────────────────────────────────────────────────────
--
--   MIGRATE FIRST, THEN DEPLOY, and 0057 before this one. The new code reads
--   the two columns and calls the two functions; the old code writes nothing
--   this migration forbids, so running it ahead of the deploy is safe and
--   leaves no window where a read fails.
--
--   To roll back:
--
--   drop trigger if exists document_extractions_set_identity_retention on document_extractions;
--   drop function if exists documents_set_identity_retention();
--   drop function if exists documents_expired_originals(int);
--   drop function if exists document_original_removed(uuid, uuid);
--   drop index if exists documents_retention_due_idx;
--   alter table documents drop column if exists retention_expires_at, drop column if exists original_removed_at;
--   create or replace function operations_schema_version() returns text language sql immutable as $$ select '0057'::text $$;

-- ── 1. The two timestamps ──────────────────────────────────────────────────

alter table documents
  add column if not exists retention_expires_at timestamptz,
  add column if not exists original_removed_at timestamptz;

comment on column documents.retention_expires_at is
  'When this document''s ORIGINAL FILE stops being kept. NULL means no automatic expiry, which is every financial document. Set by the trigger below when an identity document is read.';

comment on column documents.original_removed_at is
  'When the stored bytes were actually deleted by the retention sweep. The row and its extraction survive; only the file is gone.';

-- A removal cannot precede the expiry that authorised it. Cheap, and it makes
-- a sweep that ran against the wrong rows impossible to record.
alter table documents
  drop constraint if exists documents_original_removed_needs_expiry;

alter table documents
  add constraint documents_original_removed_needs_expiry check (
    original_removed_at is null or retention_expires_at is not null
  );

-- ── 2. The sweep reads only what is due ────────────────────────────────────
--
--   Partial, so the index holds only rows that still have bytes to remove and
--   shrinks as they are swept — rather than growing with every document ever
--   uploaded.

create index if not exists documents_retention_due_idx
  on documents (retention_expires_at)
  where retention_expires_at is not null and original_removed_at is null;

-- ── 3. Reading an identity document starts the clock ───────────────────────
--
--   In the database rather than in the pipeline, because "set the expiry" is
--   exactly the kind of step a later refactor drops silently. Here it is a
--   consequence of recording the extraction at all.
--
--   `least(...)` so re-processing never EXTENDS a window that is already
--   running. A document read three times expires seven days after the FIRST
--   read, not the last.

create or replace function documents_set_identity_retention()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.document_type in ('DRIVER_LICENSE', 'PASSPORT', 'SSN_DOCUMENT', 'GOVERNMENT_ID') then
    update documents
       set retention_expires_at = least(coalesce(retention_expires_at, 'infinity'::timestamptz), now() + interval '7 days')
     where id = new.document_id
       and organization_id = new.organization_id
       and original_removed_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists document_extractions_set_identity_retention on document_extractions;

create trigger document_extractions_set_identity_retention
  after insert on document_extractions
  for each row
  execute function documents_set_identity_retention();

-- ── 4. What the sweep calls ────────────────────────────────────────────────
--
--   Two functions rather than direct table access, for the same reason the
--   bank functions exist: the tenant scoping is written once, here, instead of
--   in every caller.

/**
 * The originals that are due, oldest first.
 *
 * Bounded twice — by the caller's limit and by a hard ceiling — so that no
 * invocation can turn into a full scan however it is called. Returns the
 * organization with each row, because the caller must pass it back and the
 * mark function will not act without it.
 */
create or replace function documents_expired_originals(p_limit int)
returns table (document_id uuid, organization_id uuid, storage_path text)
language sql
security definer
set search_path = public
as $$
  select d.id, d.organization_id, d.storage_path
    from documents d
   where d.retention_expires_at is not null
     and d.retention_expires_at <= now()
     and d.original_removed_at is null
   order by d.retention_expires_at asc, d.id asc
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

/**
 * Records that one document's bytes are gone.
 *
 * BOTH ids are required and both are matched. A sweep that somehow held a
 * document id from another workspace would update nothing rather than mark a
 * stranger's document as deleted.
 *
 * Returns false when the row was already marked, which is what makes the
 * sweep idempotent: a re-run after a partial failure re-deletes an object
 * that is already gone (harmless) and is told the row needed no change.
 */
create or replace function document_original_removed(p_organization_id uuid, p_document_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  update documents
     set original_removed_at = now()
   where id = p_document_id
     and organization_id = p_organization_id
     and retention_expires_at is not null
     and original_removed_at is null;
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- Service role only. These run from a scheduled sweep that acts for every
-- organization at once and belongs to no member, so no browser role may reach
-- them — the same rule the bank functions follow.
revoke all on function documents_expired_originals(int) from public, anon, authenticated;
revoke all on function document_original_removed(uuid, uuid) from public, anon, authenticated;
grant execute on function documents_expired_originals(int) to service_role;
grant execute on function document_original_removed(uuid, uuid) to service_role;

-- ── 5. Schema version ──────────────────────────────────────────────────────

create or replace function operations_schema_version()
returns text
language sql
immutable
as $$
  select '0058'::text
$$;
