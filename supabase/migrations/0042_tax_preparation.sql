-- Tax preparation: collecting what a person has, so the engines can be given
-- something honest to compute from.
--
-- WHAT THIS IS NOT
--
-- It is not filing. Nothing here is a return, nothing is submitted, and there
-- is no column that says "filed". Preparation ends at a package a person —
-- or a tax professional — can read.
--
-- FOUR TABLES, AND WHY NOT FEWER OR MORE
--
--   tax_preparation_cases       one workspace's preparation for one tax year
--   tax_preparation_facts       append-only normalized figures with provenance
--   tax_preparation_dependents  people claimed, and how complete their data is
--   tax_preparation_snapshots   exactly what an engine was given, frozen
--
-- There is deliberately NO issues table. Issues are derived from the facts by
-- `assessCompleteness`, every time, from code that is versioned and tested.
-- Storing them would create a second source of truth that drifts the moment a
-- rule changes, and a stale "everything looks fine" row is far worse than no
-- row at all.
--
-- Documents are NOT duplicated either: a fact points at the existing
-- `documents` row it came from. `on delete set null` rather than cascade, so
-- deleting a document leaves the figure in place with its evidence link
-- broken — visible and reportable — instead of silently deleting a tax
-- figure, or silently keeping one whose evidence is gone.
--
-- WHAT IS DELIBERATELY ABSENT FROM EVERY TABLE
--
-- There is no column anywhere below that can hold a Social Security number,
-- an ITIN, or any other tax identifier. This is not a policy written in a
-- comment and enforced by hope — there is physically nowhere to put one.
-- `tax_identifier_type` records WHICH kind exists and
-- `tax_identifier_on_file` records THAT one exists, which is all completeness
-- needs. A later filing task that genuinely requires the number must
-- establish its own protection for it, and doing that deliberately is the
-- point.
--
-- Taxpayer details are plain columns rather than a jsonb blob for the same
-- reason: a jsonb column is a place an SSN can end up by accident.

-- ── Composite-FK support (0020's pattern) ────────────────────────────────
-- Redundant with the primary key, but a composite foreign key can only
-- reference a declared unique constraint. This is what lets Postgres itself
-- enforce that a fact's evidence document belongs to the same organization
-- as the fact, rather than trusting application code to check.
alter table documents add constraint documents_id_org_unique unique (id, organization_id);

-- ── Cases ────────────────────────────────────────────────────────────────

create table tax_preparation_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,

  /** Server-authoritative and never updated: a case IS its tax year. Moving
   *  one between years would silently reinterpret every fact in it. */
  tax_year int not null check (tax_year between 1900 and 2200),

  /** Mirrors PreparationStatus. Constrained rather than free text — an
   *  unrecognised status would read as "probably fine" to anything querying
   *  this table, including a future export. */
  status text not null default 'DRAFT' check (
    status in ('DRAFT', 'COLLECTING', 'READY_FOR_CALCULATION', 'CALCULATED', 'NEEDS_INFORMATION', 'BLOCKED', 'ARCHIVED')
  ),

  /** Null until chosen. Not defaulted to 'single': a defaulted filing status
   *  is a tax position nobody took. */
  filing_status text check (
    filing_status in ('single', 'married_filing_jointly', 'married_filing_separately', 'head_of_household', 'qualifying_surviving_spouse')
  ),

  -- ── Taxpayer. Identity, never identifiers. ─────────────────────────────
  legal_first_name text,
  legal_middle_name text,
  legal_last_name text,
  date_of_birth date,

  /** WHICH kind of identifier exists — never the identifier. */
  tax_identifier_type text check (tax_identifier_type in ('ssn', 'itin', 'none')),
  /** THAT one exists. Enough for completeness; useless to an attacker. */
  tax_identifier_on_file boolean not null default false,

  /** Defaulted from the organization, and the basis for the state engine. */
  primary_state_region char(2) check (primary_state_region is null or primary_state_region ~ '^[A-Z]{2}$'),
  /** Other states with income or residency. Collected and surfaced for
   *  review — income is NOT allocated between states anywhere. */
  additional_state_regions char(2)[] not null default '{}',

  spouse_first_name text,
  spouse_last_name text,
  spouse_date_of_birth date,
  spouse_tax_identifier_on_file boolean not null default false,

  /** Bumped each time a snapshot is taken, so facts, snapshots and stored
   *  calculations all agree on which state of the case they describe. */
  current_version int not null default 1 check (current_version >= 1),

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,

  constraint tax_preparation_cases_id_org_unique unique (id, organization_id)
);

-- One live case per workspace per year. Partial, so archiving a year and
-- starting it again is allowed — which is a real thing people do after a
-- correction — while two concurrent live cases for 2026, quietly diverging,
-- are not.
create unique index tax_preparation_cases_one_live_per_year_idx
  on tax_preparation_cases (organization_id, tax_year)
  where status <> 'ARCHIVED';

create index tax_preparation_cases_organization_id_idx
  on tax_preparation_cases (organization_id, tax_year desc, updated_at desc);

create trigger tax_preparation_cases_set_updated_at
  before update on tax_preparation_cases
  for each row execute function set_updated_at();

comment on column tax_preparation_cases.tax_identifier_on_file is
  'Whether the taxpayer has an SSN or ITIN. The identifier itself is never stored in this schema; there is no column for it.';

comment on table tax_preparation_cases is
  'Preparation of individual tax information for one organization and tax year. Not a tax return and not a filing record — Countorra does not file.';

-- ── Facts ────────────────────────────────────────────────────────────────
--
-- APPEND-ONLY, INCLUDING STATE CHANGES.
--
-- Confirming or rejecting a proposed value does not update the row — it
-- inserts a new row that points back at the one it replaces. That costs an
-- anti-join to read "current facts", and buys the thing this layer exists
-- for: an AI-proposed value that became a tax figure leaves behind both the
-- proposal and the separate, attributed act of a person accepting it. An
-- UPDATE would overwrite the proposal's `created_by` with the reviewer's and
-- destroy exactly the evidence that matters.
--
-- So, like `tax_calculations`, there is no UPDATE policy and no DELETE
-- policy. Corrections are new rows.

create table tax_preparation_facts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  case_id uuid not null,
  /** The case version this fact was collected under. */
  version int not null check (version >= 1),

  /** Mirrors TaxFactKey. Text rather than an enum: the vocabulary grows as
   *  engines learn to consume more, and that should not need a migration.
   *  `facts.ts` is the authority on what is recognised, and an unrecognised
   *  key is reported as unrecognised rather than silently calculated. */
  key text not null check (char_length(key) between 1 and 64),

  /** Integer minor units — the project's money rule. Null for facts that are
   *  not amounts. Negative is permitted at the database level because some
   *  keys genuinely allow it (a capital loss); which ones is a domain rule,
   *  enforced in `validation.ts` where it can explain itself. */
  amount_minor bigint,
  currency char(3),
  text_value text,

  source text not null check (
    source in ('USER_ENTERED', 'DOCUMENT', 'TRANSACTION', 'INVOICE', 'IMPORT', 'SYSTEM_DERIVED', 'TAX_ENGINE', 'AI_PROPOSED')
  ),
  state text not null check (state in ('PROPOSED', 'CONFIRMED', 'REJECTED')),

  /** The document this figure came from. Composite FK: same organization,
   *  enforced by Postgres rather than by remembering to check. */
  evidence_document_id uuid,
  /** Describes the evidence, e.g. 'W-2 box 1, Acme Corp'. Never an
   *  identifier — see the table comment. */
  evidence_note text,

  /** The fact this one replaces, if any. Within the same organization. */
  supersedes_fact_id uuid,

  /** For a CONFIRMED row this is the person who accepted the value — which
   *  is why it must never be overwritten. */
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint tax_preparation_facts_case_fkey
    foreign key (case_id, organization_id) references tax_preparation_cases (id, organization_id) on delete cascade,
  -- The column list on SET NULL is load-bearing, not a flourish. A composite
  -- foreign key's plain `on delete set null` nulls EVERY referencing column,
  -- including `organization_id`, which is NOT NULL — so deleting a document
  -- would fail outright rather than breaking the link. Naming the column
  -- (Postgres 15+) nulls only the evidence pointer, which is the behaviour
  -- this whole design depends on.
  constraint tax_preparation_facts_document_fkey
    foreign key (evidence_document_id, organization_id) references documents (id, organization_id)
    on delete set null (evidence_document_id),
  constraint tax_preparation_facts_supersedes_fkey
    foreign key (supersedes_fact_id, organization_id) references tax_preparation_facts (id, organization_id) on delete restrict,

  constraint tax_preparation_facts_id_org_unique unique (id, organization_id),

  -- A fact is an amount or a text value, not neither. A row carrying no value
  -- at all is a collection bug that would otherwise reach a snapshot as a
  -- silent zero.
  constraint tax_preparation_facts_has_value check (amount_minor is not null or text_value is not null),
  -- An amount without a currency cannot be summed with anything.
  constraint tax_preparation_facts_currency_present check (amount_minor is null or currency is not null),
  -- A row cannot replace itself.
  constraint tax_preparation_facts_no_self_supersede check (supersedes_fact_id is null or supersedes_fact_id <> id)
);

-- History is a chain, never a tree: at most one row may replace any given
-- fact. Without this, two concurrent confirmations of the same proposal would
-- both succeed and the snapshot would contain the figure twice.
create unique index tax_preparation_facts_single_successor_idx
  on tax_preparation_facts (supersedes_fact_id)
  where supersedes_fact_id is not null;

create index tax_preparation_facts_case_idx
  on tax_preparation_facts (case_id, version, key);

create index tax_preparation_facts_organization_id_idx
  on tax_preparation_facts (organization_id, created_at desc);

create index tax_preparation_facts_document_idx
  on tax_preparation_facts (evidence_document_id)
  where evidence_document_id is not null;

comment on table tax_preparation_facts is
  'Append-only normalized tax figures with provenance. Confirming or rejecting inserts a superseding row; nothing is ever updated, so an AI proposal and the person who accepted it remain separately attributable.';

comment on column tax_preparation_facts.state is
  'PROPOSED values are shown to the user and never reach a snapshot. Only CONFIRMED facts are calculated.';

comment on column tax_preparation_facts.evidence_note is
  'Free text describing where the figure came from. Must never contain a tax identifier, an account number or a credential.';

-- ── Dependents ───────────────────────────────────────────────────────────
--
-- Editable, unlike facts: a mistyped name is a typo, not a tax position, and
-- forcing a superseding row for one would bury the fact history in noise.
-- Nothing here decides that a dependent QUALIFIES for anything — `status`
-- describes how complete the information is, and `NEEDS_REVIEW` means a human
-- has to look, not that a credit was denied.

create table tax_preparation_dependents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  case_id uuid not null,

  first_name text not null check (char_length(trim(first_name)) > 0),
  last_name text not null check (char_length(trim(last_name)) > 0),
  relationship text not null check (char_length(trim(relationship)) > 0),
  date_of_birth date,
  months_lived_with_taxpayer int check (months_lived_with_taxpayer is null or months_lived_with_taxpayer between 0 and 12),
  is_student boolean not null default false,
  is_disabled boolean not null default false,

  /** Whether a TIN exists — never the TIN. Same rule as the taxpayer's. */
  has_tax_identifier boolean not null default false,
  /** Someone else may already be claiming this person. Collected because it
   *  changes what a reviewer must look at, not because anything here
   *  adjudicates it. */
  claimed_by_another boolean not null default false,

  status text not null default 'INCOMPLETE' check (status in ('VERIFIED', 'NEEDS_REVIEW', 'INCOMPLETE', 'NOT_SUPPORTED')),

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tax_preparation_dependents_case_fkey
    foreign key (case_id, organization_id) references tax_preparation_cases (id, organization_id) on delete cascade
);

create index tax_preparation_dependents_case_idx on tax_preparation_dependents (case_id, created_at);
create index tax_preparation_dependents_organization_id_idx on tax_preparation_dependents (organization_id);

create trigger tax_preparation_dependents_set_updated_at
  before update on tax_preparation_dependents
  for each row execute function set_updated_at();

comment on column tax_preparation_dependents.status is
  'How complete this dependent''s INFORMATION is. Never a determination that a dependency exemption or credit is allowed — nothing in this product decides that.';

-- ── Snapshots ────────────────────────────────────────────────────────────
--
-- Exactly what the engines were handed, frozen, and the reason the fact
-- versioning above exists. A stored tax result that cannot be tied to the
-- inputs that produced it is not auditable, and inputs that change underneath
-- an existing result are worse than no record at all.
--
-- Immutable by omission, like `tax_calculations`: no UPDATE policy, no DELETE
-- policy. A correction takes a new snapshot at a new version.

create table tax_preparation_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  case_id uuid not null,
  version int not null check (version >= 1),

  tax_year int not null check (tax_year between 1900 and 2200),
  filing_status text not null check (
    filing_status in ('single', 'married_filing_jointly', 'married_filing_separately', 'head_of_household', 'qualifying_surviving_spouse')
  ),

  /** The jurisdictions this snapshot was built to be calculated for. */
  jurisdictions text[] not null check (array_length(jurisdictions, 1) >= 1),

  /** The whole TaxInputSnapshot, verbatim — taxpayer, dependents and every
   *  confirmed fact with its provenance. Stored as one document rather than
   *  re-derived from the fact rows on demand, because re-deriving it is
   *  precisely the thing that may no longer be possible later: a document
   *  deleted, a fact superseded, a definition changed. The fact rows remain
   *  the live working set; this is the record of what was actually used. */
  payload jsonb not null,

  /** The preparation layer's classified result for these inputs, exactly as
   *  it is shown — per-jurisdiction status, figures, the refund statement and
   *  the not-modelled list. Frozen in the same row as the inputs, so what a
   *  person was told cannot be restated by re-running the engines after a
   *  rule correction. Null only if a snapshot is ever taken without running
   *  a calculation. */
  calculation jsonb,

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint tax_preparation_snapshots_case_fkey
    foreign key (case_id, organization_id) references tax_preparation_cases (id, organization_id) on delete cascade,
  constraint tax_preparation_snapshots_id_org_unique unique (id, organization_id),
  -- One snapshot per case version. Two snapshots claiming the same version
  -- would make "which inputs produced this result" ambiguous, which is the
  -- one question the table exists to answer.
  constraint tax_preparation_snapshots_case_version_unique unique (case_id, version)
);

create index tax_preparation_snapshots_organization_id_idx
  on tax_preparation_snapshots (organization_id, created_at desc);

comment on table tax_preparation_snapshots is
  'Immutable record of exactly what was given to the tax engines. Never updated or deleted — a correction is a new snapshot at a new case version.';

-- ── Linking a stored calculation back to its inputs ──────────────────────
--
-- Additive and nullable: every existing `tax_calculations` row was produced
-- by the direct calculation path, which has no preparation case behind it.
-- Backfilling a snapshot id would be inventing one.
--
-- `on delete restrict` is deliberate and is the stronger half of this
-- column's purpose. A calculation whose inputs had been deleted would still
-- show its number, now unexplainable. Refusing the delete keeps the pair
-- intact.
alter table tax_calculations add column preparation_snapshot_id uuid;

alter table tax_calculations
  add constraint tax_calculations_preparation_snapshot_fkey
  foreign key (preparation_snapshot_id, organization_id)
  references tax_preparation_snapshots (id, organization_id) on delete restrict;

create index tax_calculations_preparation_snapshot_idx
  on tax_calculations (preparation_snapshot_id)
  where preparation_snapshot_id is not null;

comment on column tax_calculations.preparation_snapshot_id is
  'The frozen preparation inputs this calculation was run against. Null for calculations made outside a preparation case.';

-- ── Row level security ───────────────────────────────────────────────────
--
-- Every table above is organization-scoped, so every table above has RLS.
-- Read is membership; write is the same set of roles that may create any
-- other financial record — a viewer can see the workspace's preparation and
-- cannot alter it.
--
-- Note what has no policy: UPDATE and DELETE on facts and snapshots. That is
-- not an oversight, it is the immutability. `authenticated` has the
-- table-level GRANT from 0023, and RLS denies by default in the absence of a
-- matching policy, so the attempt returns zero rows rather than succeeding.

alter table tax_preparation_cases enable row level security;
alter table tax_preparation_facts enable row level security;
alter table tax_preparation_dependents enable row level security;
alter table tax_preparation_snapshots enable row level security;

-- Cases: readable by members, writable by write-capable roles.
create policy tax_preparation_cases_select_member on tax_preparation_cases
  for select using (is_org_member(organization_id));

create policy tax_preparation_cases_insert_member on tax_preparation_cases
  for insert with check (
    is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[])
  );

create policy tax_preparation_cases_update_member on tax_preparation_cases
  for update
  using (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]))
  with check (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

-- Deleting a whole year's preparation is not an ordinary edit. Restricted to
-- the roles that can delete other financial records outright.
create policy tax_preparation_cases_delete_privileged on tax_preparation_cases
  for delete using (is_org_role(organization_id, array['owner', 'admin']::org_role[]));

-- Facts: append-only. Select and insert only, by design.
create policy tax_preparation_facts_select_member on tax_preparation_facts
  for select using (is_org_member(organization_id));

create policy tax_preparation_facts_insert_member on tax_preparation_facts
  for insert with check (
    is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[])
  );

-- Dependents: editable, because a typo in a name is a typo.
create policy tax_preparation_dependents_select_member on tax_preparation_dependents
  for select using (is_org_member(organization_id));

create policy tax_preparation_dependents_insert_member on tax_preparation_dependents
  for insert with check (
    is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[])
  );

create policy tax_preparation_dependents_update_member on tax_preparation_dependents
  for update
  using (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]))
  with check (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy tax_preparation_dependents_delete_member on tax_preparation_dependents
  for delete using (
    is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[])
  );

-- Snapshots: append-only, like the calculations they feed.
create policy tax_preparation_snapshots_select_member on tax_preparation_snapshots
  for select using (is_org_member(organization_id));

create policy tax_preparation_snapshots_insert_member on tax_preparation_snapshots
  for insert with check (
    is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[])
  );
