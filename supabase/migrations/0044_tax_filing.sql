-- Tax filing foundation, tax year 2026: readiness, immutable filing snapshots
-- and explicit finalization.
--
-- WHAT THIS IS NOT
--
-- It is not e-filing. Nothing here submits, transmits or confirms anything.
-- There is no provider, no submission id, no confirmation number and no
-- acceptance, and the status CHECK below excludes SUBMISSION_PENDING,
-- SUBMITTED, ACCEPTED and REJECTED outright: those states belong to a real
-- provider integration that does not exist, and a column able to hold them
-- would be a place for a fake one.
--
-- THREE TABLES
--
--   tax_filing_cases           one prepared 2026 return being evaluated for filing
--   tax_filing_snapshots       exactly what was judged ready and packaged, frozen
--   tax_filing_finalizations   a person's explicit finalization of one snapshot
--
-- There is no readiness table. Readiness is derived every time from versioned
-- code, like preparation issues in 0042; a stored "ready" row would drift the
-- moment a rule or a fact changed. What IS stored is the readiness result a
-- snapshot was taken under, inside that immutable snapshot.
--
-- WHY MEMBERS CAN READ AND NOT WRITE
--
-- Every other financial table lets write-capable members insert through RLS.
-- These do not, and that is the central design decision of this migration.
--
-- A filing snapshot asserts "the engines produced these figures from these
-- confirmed inputs, and readiness passed". Postgres cannot re-run a tax engine
-- or a readiness rule, so it cannot check that assertion. If `authenticated`
-- could insert a snapshot or set a status, any member could — through the
-- REST API, bypassing the application — store a fabricated package, mark it
-- ready and finalize it. RLS would only confirm they belong to the workspace.
--
-- So `authenticated` has SELECT policies only. Every write happens in a server
-- action that authenticates, checks membership and permission, recomputes
-- readiness from the live data and re-runs the engines, and only then writes
-- with the service role. The triggers below hold the invariants that Postgres
-- CAN check, and they apply to the service role too — service role bypasses
-- RLS, not triggers.
--
-- IMMUTABILITY AND DELETION
--
-- Snapshots and finalizations cannot be updated by anyone. They cannot be
-- deleted directly by anyone either — including the service role — but they
-- ARE removed when their organization is deleted, because account deletion
-- deletes the organizations a person solely owns and must not be blocked by a
-- record in them. The distinction is `pg_trigger_depth()`: a direct DELETE runs
-- at depth 1 and is refused; a cascade from `organizations` runs nested inside
-- the referential-integrity trigger, at depth 2 or more. This was verified
-- against Postgres before this migration was written.
--
-- Attribution columns reference auth.users ON DELETE SET NULL, as everywhere
-- else since 0029. That SET NULL is also an UPDATE issued by Postgres at
-- depth 2+, and it is the one change the guards permit on otherwise immutable
-- rows — the same narrow exception 0043 makes for preparation cases.
--
-- The preparation case and preparation snapshot a filing record points at are
-- referenced with NO ACTION (the default) rather than CASCADE: deleting a
-- preparation case that has a filing history is refused, so finalized history
-- cannot disappear by deleting what it was built from. NO ACTION is checked at
-- the end of the statement, so an organization deletion that removes both
-- sides together still succeeds.

-- ── Filing cases ─────────────────────────────────────────────────────────

create table tax_filing_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,

  /** The preparation this return is prepared from. One filing case per
   *  preparation case; a new preparation for the year gets its own. */
  preparation_case_id uuid not null,

  /** Strictly 2026. Supporting another year is a deliberate migration, never
   *  a value someone can write. */
  tax_year int not null check (tax_year = 2026),

  /** Mirrors FilingCaseStatus. Provider-only states are absent by design. */
  status text not null default 'DRAFT' check (status in ('DRAFT', 'REVIEW_REQUIRED', 'BLOCKED', 'READY_FOR_FILING', 'FINALIZED')),

  /** The latest filing snapshot version; 0 before the first. Kept equal to the
   *  snapshots by the guard below, so it can never claim a version that does
   *  not exist. */
  current_version int not null default 0 check (current_version >= 0),

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tax_filing_cases_id_org_unique unique (id, organization_id),
  constraint tax_filing_cases_preparation_case_unique unique (preparation_case_id),
  constraint tax_filing_cases_preparation_case_fkey
    foreign key (preparation_case_id, organization_id) references tax_preparation_cases (id, organization_id)
);

create index tax_filing_cases_organization_id_idx on tax_filing_cases (organization_id, tax_year);

create trigger tax_filing_cases_set_updated_at
  before update on tax_filing_cases
  for each row execute function set_updated_at();

comment on table tax_filing_cases is
  'A prepared 2026 individual return being evaluated for filing readiness. Not a filed return: Countorra does not file or submit, and no status here can say it did.';

-- ── Filing snapshots ─────────────────────────────────────────────────────

create table tax_filing_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  filing_case_id uuid not null,
  version int not null check (version >= 1),
  tax_year int not null check (tax_year = 2026),

  /** The immutable preparation snapshot, and its version, this was built from. */
  preparation_snapshot_id uuid not null,
  preparation_version int not null check (preparation_version >= 1),

  /** A snapshot is only taken when something can be finalized from it. */
  readiness_status text not null check (readiness_status in ('READY', 'REVIEW_REQUIRED')),
  /** The full readiness result the snapshot was taken under. */
  readiness jsonb not null,
  /** The Countorra Filing Package, exactly as generated. */
  package jsonb not null,
  /** SHA-256 of the canonical package JSON. */
  package_fingerprint text not null check (package_fingerprint ~ '^[0-9a-f]{64}$'),
  /** SHA-256 of the preparation snapshot and calculation it was built from —
   *  compared against the current preparation to detect a stale snapshot. */
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint tax_filing_snapshots_id_org_unique unique (id, organization_id),
  constraint tax_filing_snapshots_case_version_unique unique (filing_case_id, version),
  constraint tax_filing_snapshots_case_fkey
    foreign key (filing_case_id, organization_id) references tax_filing_cases (id, organization_id) on delete cascade,
  constraint tax_filing_snapshots_preparation_snapshot_fkey
    foreign key (preparation_snapshot_id, organization_id) references tax_preparation_snapshots (id, organization_id),

  -- The package states in its own data that it is not a filing, and a row that
  -- says otherwise is refused whoever writes it.
  constraint tax_filing_snapshots_package_is_not_a_filing check (
    package ->> 'filed' = 'false'
    and package ->> 'submitted' = 'false'
    and package ->> 'governmentForm' = 'false'
    and package ->> 'electronicFilingAvailable' = 'false'
  )
);

create index tax_filing_snapshots_organization_id_idx on tax_filing_snapshots (organization_id, created_at desc);
create index tax_filing_snapshots_preparation_snapshot_idx on tax_filing_snapshots (preparation_snapshot_id);

comment on table tax_filing_snapshots is
  'Immutable record of a prepared 2026 return: the readiness result and the Countorra Filing Package generated from one preparation snapshot. Never updated or deleted directly; a correction is a new version.';

-- ── Finalizations ────────────────────────────────────────────────────────

create table tax_filing_finalizations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  filing_case_id uuid not null,
  snapshot_id uuid not null,

  /** FULL, or FEDERAL_ONLY with every excluded state named. */
  scope text not null check (scope in ('FULL', 'FEDERAL_ONLY')),
  excluded_jurisdictions text[] not null default '{}',
  /** The warning codes the person saw and acknowledged when confirming. */
  acknowledged_issue_codes text[] not null default '{}',

  finalized_by uuid references auth.users (id) on delete set null,
  finalized_at timestamptz not null default now(),

  constraint tax_filing_finalizations_snapshot_unique unique (snapshot_id),
  constraint tax_filing_finalizations_case_fkey
    foreign key (filing_case_id, organization_id) references tax_filing_cases (id, organization_id) on delete cascade,
  constraint tax_filing_finalizations_snapshot_fkey
    foreign key (snapshot_id, organization_id) references tax_filing_snapshots (id, organization_id) on delete cascade,
  constraint tax_filing_finalizations_scope_exclusions check (
    (scope = 'FULL' and cardinality(excluded_jurisdictions) = 0)
    or (scope = 'FEDERAL_ONLY' and cardinality(excluded_jurisdictions) > 0)
  )
);

create index tax_filing_finalizations_case_idx on tax_filing_finalizations (filing_case_id, finalized_at desc);
create index tax_filing_finalizations_organization_id_idx on tax_filing_finalizations (organization_id);

comment on table tax_filing_finalizations is
  'A person explicitly finalized one filing snapshot. Finalized means reviewed and locked inside Countorra — NOT filed, submitted or accepted by any tax authority.';

-- ── Guards ───────────────────────────────────────────────────────────────

create or replace function tax_filing_cases_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_preparation_year int;
  v_latest_version int;
  v_has_finalization boolean;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'tax_filing_cases cannot be deleted directly: filing history is removed only with its organization'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    select tax_year into v_preparation_year
      from tax_preparation_cases
     where id = new.preparation_case_id and organization_id = new.organization_id;

    if v_preparation_year is null then
      raise exception 'tax_filing_cases: the preparation case does not exist in this organization'
        using errcode = 'foreign_key_violation';
    end if;
    if v_preparation_year <> new.tax_year then
      raise exception 'tax_filing_cases.tax_year must equal the preparation case''s tax year'
        using errcode = 'check_violation';
    end if;
    if new.status <> 'DRAFT' or new.current_version <> 0 then
      raise exception 'tax_filing_cases: a filing case starts as DRAFT at version 0'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- UPDATE. Account deletion clearing the creator is the one change permitted
  -- without the checks below, and it may only clear it.
  if new.created_by is distinct from old.created_by then
    if not (new.created_by is null and pg_trigger_depth() > 1) then
      raise exception 'tax_filing_cases.created_by cannot be changed: only deleting the creator''s account may clear it'
        using errcode = 'check_violation';
    end if;
    if (new.id, new.organization_id, new.preparation_case_id, new.tax_year, new.status, new.current_version, new.created_at)
       is not distinct from
       (old.id, old.organization_id, old.preparation_case_id, old.tax_year, old.status, old.current_version, old.created_at) then
      return new;
    end if;
  end if;

  if new.id is distinct from old.id then
    raise exception 'tax_filing_cases.id cannot be changed' using errcode = 'check_violation';
  end if;
  if new.organization_id is distinct from old.organization_id then
    raise exception 'tax_filing_cases.organization_id cannot be changed: a filing case cannot move between workspaces' using errcode = 'check_violation';
  end if;
  if new.preparation_case_id is distinct from old.preparation_case_id then
    raise exception 'tax_filing_cases.preparation_case_id cannot be changed: a filing case is prepared from one preparation' using errcode = 'check_violation';
  end if;
  if new.tax_year is distinct from old.tax_year then
    raise exception 'tax_filing_cases.tax_year cannot be changed' using errcode = 'check_violation';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'tax_filing_cases.created_at cannot be changed' using errcode = 'check_violation';
  end if;

  select coalesce(max(version), 0) into v_latest_version from tax_filing_snapshots where filing_case_id = new.id;
  if new.current_version <> v_latest_version then
    raise exception 'tax_filing_cases.current_version must equal the latest filing snapshot version (%)', v_latest_version
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status and not (
       (old.status = 'DRAFT' and new.status in ('REVIEW_REQUIRED', 'BLOCKED', 'READY_FOR_FILING'))
    or (old.status = 'REVIEW_REQUIRED' and new.status in ('BLOCKED', 'READY_FOR_FILING', 'FINALIZED'))
    or (old.status = 'BLOCKED' and new.status in ('REVIEW_REQUIRED', 'READY_FOR_FILING'))
    or (old.status = 'READY_FOR_FILING' and new.status in ('REVIEW_REQUIRED', 'BLOCKED', 'FINALIZED'))
    or (old.status = 'FINALIZED' and new.status in ('REVIEW_REQUIRED', 'BLOCKED', 'READY_FOR_FILING'))
  ) then
    raise exception 'tax_filing_cases.status cannot move from % to %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if new.status = 'FINALIZED' then
    select exists (
      select 1
        from tax_filing_finalizations f
        join tax_filing_snapshots s on s.id = f.snapshot_id
       where f.filing_case_id = new.id and s.version = new.current_version
    ) into v_has_finalization;

    if not v_has_finalization then
      raise exception 'tax_filing_cases: FINALIZED requires a finalization of the current filing snapshot'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger tax_filing_cases_guard
  before insert or update or delete on tax_filing_cases
  for each row execute function tax_filing_cases_guard();

create or replace function tax_filing_snapshots_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_case record;
  v_preparation record;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'tax_filing_snapshots are immutable and cannot be deleted' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if new.created_by is null
       and old.created_by is not null
       and pg_trigger_depth() > 1
       and (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by') then
      return new;
    end if;
    raise exception 'tax_filing_snapshots are immutable: a correction is a new version' using errcode = 'check_violation';
  end if;

  select id, organization_id, preparation_case_id, tax_year, current_version
    into v_case
    from tax_filing_cases
   where id = new.filing_case_id and organization_id = new.organization_id;

  if v_case.id is null then
    raise exception 'tax_filing_snapshots: the filing case does not exist in this organization' using errcode = 'foreign_key_violation';
  end if;
  if new.tax_year <> v_case.tax_year then
    raise exception 'tax_filing_snapshots.tax_year must equal the filing case''s tax year' using errcode = 'check_violation';
  end if;
  if new.version <> v_case.current_version + 1 then
    raise exception 'tax_filing_snapshots.version must be the next version (%)', v_case.current_version + 1 using errcode = 'check_violation';
  end if;

  select case_id, tax_year, version
    into v_preparation
    from tax_preparation_snapshots
   where id = new.preparation_snapshot_id and organization_id = new.organization_id;

  if v_preparation.case_id is null then
    raise exception 'tax_filing_snapshots: the preparation snapshot does not exist in this organization' using errcode = 'foreign_key_violation';
  end if;
  if v_preparation.case_id <> v_case.preparation_case_id then
    raise exception 'tax_filing_snapshots: the preparation snapshot belongs to a different preparation case' using errcode = 'check_violation';
  end if;
  if v_preparation.tax_year <> new.tax_year or v_preparation.version <> new.preparation_version then
    raise exception 'tax_filing_snapshots: tax year and preparation version must match the preparation snapshot' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger tax_filing_snapshots_guard
  before insert or update or delete on tax_filing_snapshots
  for each row execute function tax_filing_snapshots_guard();

create or replace function tax_filing_finalizations_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_case record;
  v_snapshot record;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'tax_filing_finalizations are immutable and cannot be deleted' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if new.finalized_by is null
       and old.finalized_by is not null
       and pg_trigger_depth() > 1
       and (to_jsonb(new) - 'finalized_by') = (to_jsonb(old) - 'finalized_by') then
      return new;
    end if;
    raise exception 'tax_filing_finalizations are immutable' using errcode = 'check_violation';
  end if;

  select id, status, current_version
    into v_case
    from tax_filing_cases
   where id = new.filing_case_id and organization_id = new.organization_id;

  if v_case.id is null then
    raise exception 'tax_filing_finalizations: the filing case does not exist in this organization' using errcode = 'foreign_key_violation';
  end if;
  if v_case.status not in ('READY_FOR_FILING', 'REVIEW_REQUIRED') then
    raise exception 'tax_filing_finalizations: a % filing case cannot be finalized', v_case.status using errcode = 'check_violation';
  end if;

  select filing_case_id, version, readiness_status
    into v_snapshot
    from tax_filing_snapshots
   where id = new.snapshot_id and organization_id = new.organization_id;

  if v_snapshot.filing_case_id is null or v_snapshot.filing_case_id <> new.filing_case_id then
    raise exception 'tax_filing_finalizations: the snapshot belongs to a different filing case' using errcode = 'check_violation';
  end if;
  if v_snapshot.version <> v_case.current_version then
    raise exception 'tax_filing_finalizations: only the latest filing snapshot can be finalized' using errcode = 'check_violation';
  end if;
  if new.scope = 'FULL' and v_snapshot.readiness_status <> 'READY' then
    raise exception 'tax_filing_finalizations: FULL finalization requires a READY snapshot' using errcode = 'check_violation';
  end if;
  if new.scope = 'FEDERAL_ONLY' and v_snapshot.readiness_status <> 'REVIEW_REQUIRED' then
    raise exception 'tax_filing_finalizations: FEDERAL_ONLY is for a snapshot whose states are not all ready' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger tax_filing_finalizations_guard
  before insert or update or delete on tax_filing_finalizations
  for each row execute function tax_filing_finalizations_guard();

-- ── Row level security ───────────────────────────────────────────────────
--
-- Read is membership. There is no INSERT, UPDATE or DELETE policy for anyone,
-- so `authenticated` is refused every write by default. See the header.

alter table tax_filing_cases enable row level security;
alter table tax_filing_snapshots enable row level security;
alter table tax_filing_finalizations enable row level security;

create policy tax_filing_cases_select_member on tax_filing_cases
  for select using (is_org_member(organization_id));

create policy tax_filing_snapshots_select_member on tax_filing_snapshots
  for select using (is_org_member(organization_id));

create policy tax_filing_finalizations_select_member on tax_filing_finalizations
  for select using (is_org_member(organization_id));
