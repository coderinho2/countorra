-- Accounting: periods, tax configuration, VAT configuration.
--
-- Tax logic itself is explicitly NOT implemented here (DESIGN brief §12,
-- §40 rule 12: tax rules change often and require a dedicated research
-- phase). This migration only establishes storage for country-specific
-- configuration, keyed by country + tax_year, so src/domain/tax's
-- TaxEngine has somewhere real to read from once specific country logic
-- is implemented. `config` is jsonb rather than typed columns precisely
-- because its shape is country-specific and unknown in Phase 1.

create table accounting_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  period_start date not null,
  period_end date not null,
  status text not null default 'open' check (status in ('open', 'closed', 'locked')),
  closed_at timestamptz,
  closed_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (period_end > period_start),
  unique (organization_id, period_start, period_end)
);

create index accounting_periods_organization_id_idx on accounting_periods (organization_id);

create table tax_configurations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  country char(2) not null,
  tax_year int not null,
  config jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, country, tax_year)
);

create index tax_configurations_organization_id_idx on tax_configurations (organization_id);

create trigger tax_configurations_set_updated_at
  before update on tax_configurations
  for each row execute function set_updated_at();

create table vat_configurations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  is_vat_registered boolean not null default false,
  vat_number text,
  vat_scheme text,
  default_vat_rate numeric(5, 2),
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);

create index vat_configurations_organization_id_idx on vat_configurations (organization_id);
