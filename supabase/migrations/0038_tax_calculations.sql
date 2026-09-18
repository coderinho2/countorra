-- Stored tax calculations, and the rule-set stamp that makes them reproducible.
--
-- WHY THIS TABLE EXISTS AT ALL
--
-- A tax figure is not like a dashboard total. A dashboard recomputes from
-- current data and that is correct; a tax estimate is a statement about a
-- specific year under a specific set of published rules, and re-deriving it
-- later under corrected rules would silently change what someone was told.
--
-- So a stored calculation records the RULE SET VERSION it was computed under
-- alongside its inputs and its result. When the 2026 figures are corrected
-- and the version becomes 2026.2, an old row still says 2026.1 — and
-- `findRuleSetVersion` returns null for it, which is the honest answer
-- ("this build can no longer reproduce that") rather than a different number
-- presented as the original.
--
-- IMMUTABLE BY OMISSION
--
-- There is no UPDATE policy and no DELETE policy for `authenticated`. A
-- calculation is a record of what was said at a point in time; editing one
-- would destroy the only thing it is for. Corrections are new rows.
--
-- The full trace is stored rather than just the totals, because "why is this
-- number what it is" is the question a tax figure always provokes, and
-- recomputing the trace later is exactly the thing that may no longer be
-- possible.

create table tax_calculations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,

  -- ── The stamp that makes this reproducible ───────────────────────────
  /** 'US_FEDERAL', later 'US_CA' and so on. Text rather than an enum: a new
   *  jurisdiction should not need a migration to be recordable. */
  jurisdiction text not null,
  tax_year int not null check (tax_year between 1900 and 2200),
  /** e.g. '2026.1'. The exact rules this result was computed under. */
  rule_set_version text not null,
  filing_status text not null,
  currency char(3) not null,

  -- ── What was calculated ──────────────────────────────────────────────
  /** The exact inputs, so the calculation can be re-run and compared. */
  inputs jsonb not null,
  /** Headline figures, duplicated out of the trace for querying. */
  totals jsonb not null,
  /** Every step, in order, with the amounts actually used. */
  trace jsonb not null,

  /** Denormalised for sorting and display without parsing jsonb. */
  total_federal_tax_minor bigint not null,

  calculated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index tax_calculations_organization_id_idx on tax_calculations (organization_id, tax_year, created_at desc);

comment on column tax_calculations.rule_set_version is
  'The tax rule-set version in force when this was computed. Never updated — a later correction to the published figures must not restate a historical result.';

alter table tax_calculations enable row level security;

-- Members read their own organization's calculations. Tax figures are
-- ordinary organization financial data.
create policy tax_calculations_select_member on tax_calculations
  for select using (is_org_member(organization_id));

-- Write-capable roles may record one, matching who may create any other
-- financial record. A viewer can read the workspace's calculations but not
-- produce new ones.
create policy tax_calculations_insert_member on tax_calculations
  for insert with check (
    is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[])
  );

-- Deliberately NO update or delete policy. See the header.
