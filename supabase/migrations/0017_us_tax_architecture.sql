-- US-first tax architecture (Phase 2 direction update: the United States,
-- not Romania, is the first supported market). Nothing here encodes any
-- actual tax rule or rate — see src/domain/tax/countries/us.ts, which
-- throws deliberately rather than guess at federal/state/local tax law.
-- This migration only adds the storage a real, verified US tax
-- implementation will eventually read from, using country-agnostic column
-- names so the same shape serves other jurisdictions later (a UK UTR, an
-- EU VAT ID, a Romanian CUI all fit `tax_identifier` equally).

-- An organization's tax identifier: an EIN for a US business, an SSN/ITIN
-- for a US individual/sole proprietor, or the equivalent for another
-- country later. Nullable — not knowing this yet must never block using
-- the product (product spec §23: progressive onboarding, skip what's not
-- essential).
alter table organizations
  add column tax_identifier text,
  add column tax_identifier_type text check (tax_identifier_type is null or tax_identifier_type in ('ein', 'ssn', 'itin', 'other'));

-- US sales tax is a state-and-local concept — there is no federal VAT
-- equivalent, and a business's obligation depends on which states it has
-- "nexus" in (physical presence, economic thresholds, etc.), not one
-- national rate. This is deliberately a separate table from
-- `vat_configurations` (0005_accounting.sql, kept for EU/Romania) rather
-- than a renamed/repurposed one: VAT registration and sales-tax nexus are
-- genuinely different concepts, not the same field with a different label.
create table sales_tax_configurations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  -- Two-letter US state code (or another jurisdiction's subdivision code,
  -- for a future non-US market that also uses sub-national sales tax).
  state char(2) not null,
  has_nexus boolean not null default false,
  registered boolean not null default false,
  -- Rate storage only — never used to compute an authoritative amount
  -- until a verified TaxEngine reads it (see the module comment above).
  rate_percent numeric(5, 2),
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  unique (organization_id, state, effective_from)
);

create index sales_tax_configurations_organization_id_idx on sales_tax_configurations (organization_id);

create trigger sales_tax_configurations_set_updated_at
  before update on sales_tax_configurations
  for each row execute function set_updated_at();

alter table sales_tax_configurations enable row level security;

create policy sales_tax_configurations_select_member on sales_tax_configurations
  for select using (is_org_member(organization_id));

create policy sales_tax_configurations_write_privileged on sales_tax_configurations
  for insert with check (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

create policy sales_tax_configurations_update_privileged on sales_tax_configurations
  for update using (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

create policy sales_tax_configurations_delete_privileged on sales_tax_configurations
  for delete using (is_org_role(organization_id, array['owner', 'admin']::org_role[]));

-- Document pipeline support for US tax forms (W-9, 1099 variants) —
-- storage and status tracking only; see src/domain/documents for the
-- same "no OCR/extraction provider implemented" boundary these already
-- follow for receipts/invoices/bills.
alter type document_kind add value 'tax_form';

alter table documents
  add column form_type text check (form_type is null or form_type in ('w9', '1099-nec', '1099-misc', '1099-k', 'other'));
