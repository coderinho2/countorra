-- Financial core: accounts, categories, merchants, transactions.
--
-- Money is always an integer minor-unit column (`*_minor`, e.g. cents) plus
-- an explicit `currency` column — never a float, never an implicit currency.
-- See src/domain/money for the arithmetic that must be used against these
-- columns instead of raw SQL math or client-side floating point.

create table accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('cash', 'bank', 'credit_card', 'wallet', 'other')),
  currency char(3) not null,
  opening_balance_minor bigint not null default 0,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index accounts_organization_id_idx on accounts (organization_id);

create trigger accounts_set_updated_at
  before update on accounts
  for each row execute function set_updated_at();

-- Categories are always organization-owned (never a shared global row) so
-- every category-scoped policy can use the same is_org_member() check with
-- no "or it's a system row" special case — the kind of exception that tends
-- to become an accidental cross-tenant read. Default categories are seeded
-- per-organization instead; see 0012_org_bootstrap.sql.
create table transaction_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  parent_category_id uuid references transaction_categories (id) on delete set null,
  kind text not null check (kind in ('income', 'expense')),
  name text not null,
  color text,
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

create index transaction_categories_organization_id_idx on transaction_categories (organization_id);

create table merchants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name text not null,
  normalized_name text not null,
  created_at timestamptz not null default now()
);

create index merchants_organization_id_idx on merchants (organization_id);
create index merchants_normalized_name_idx on merchants (organization_id, normalized_name);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete restrict,
  category_id uuid references transaction_categories (id) on delete set null,
  merchant_id uuid references merchants (id) on delete set null,
  kind transaction_kind not null,
  -- Always non-negative; direction comes from `kind`, not from the sign of
  -- this column. Mixing sign-as-direction with a `kind` enum is a common
  -- source of double-negation bugs — this schema picks one mechanism.
  amount_minor bigint not null check (amount_minor >= 0),
  currency char(3) not null,
  occurred_on date not null,
  description text,
  memo text,
  is_reconciled boolean not null default false,
  source text not null default 'manual' check (source in ('manual', 'import', 'bank_sync', 'ai')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index transactions_organization_id_idx on transactions (organization_id);
create index transactions_account_id_idx on transactions (account_id);
create index transactions_category_id_idx on transactions (category_id);
create index transactions_occurred_on_idx on transactions (organization_id, occurred_on desc);

create trigger transactions_set_updated_at
  before update on transactions
  for each row execute function set_updated_at();
