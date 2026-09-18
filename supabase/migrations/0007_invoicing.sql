-- Invoicing foundation: customers, invoices, line items. UI is deferred to
-- a later phase (DESIGN brief §3); this is the data model it will sit on.

create table customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  display_name text not null,
  email text,
  billing_address jsonb,
  tax_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index customers_organization_id_idx on customers (organization_id);

create trigger customers_set_updated_at
  before update on customers
  for each row execute function set_updated_at();

create table invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  customer_id uuid not null references customers (id) on delete restrict,
  invoice_number text not null,
  status invoice_status not null default 'draft',
  currency char(3) not null,
  issue_date date not null default current_date,
  due_date date,
  -- Totals are denormalized onto the invoice for fast list rendering, and
  -- recomputed from line items in the application layer (never trusted
  -- from client input) whenever line items change.
  subtotal_minor bigint not null default 0,
  tax_minor bigint not null default 0,
  total_minor bigint not null default 0,
  notes text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, invoice_number)
);

create index invoices_organization_id_idx on invoices (organization_id);
create index invoices_customer_id_idx on invoices (customer_id);
create index invoices_status_idx on invoices (organization_id, status);

create trigger invoices_set_updated_at
  before update on invoices
  for each row execute function set_updated_at();

-- See 0003_helper_functions.sql for the pattern this follows.
create or replace function org_id_of_invoice(target_invoice_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select i.organization_id from invoices i where i.id = target_invoice_id;
$$;

create table invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices (id) on delete cascade,
  position int not null default 0,
  description text not null,
  quantity numeric(12, 3) not null default 1 check (quantity > 0),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  tax_rate numeric(5, 2) not null default 0 check (tax_rate >= 0),
  amount_minor bigint not null check (amount_minor >= 0),
  created_at timestamptz not null default now()
);

create index invoice_line_items_invoice_id_idx on invoice_line_items (invoice_id, position);
