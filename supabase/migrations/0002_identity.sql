-- Identity: profiles, organizations (financial entities), memberships.
--
-- "Organization" is used generically for any financial entity a user
-- operates — a personal budget, a freelancer/self-employed entity, or a business —
-- per DESIGN.md's product model (a user may hold several). Modeling all
-- three as rows in one table, distinguished by `entity_type`, means every
-- other domain table (accounts, transactions, invoices, ...) is scoped by a
-- single `organization_id` foreign key and a single RLS pattern, regardless
-- of which of the three the row belongs to — avoiding parallel schemas and
-- parallel authorization logic for what is structurally the same concept.

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  avatar_url text,
  default_currency text not null default 'USD',
  locale text not null default 'en-US',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function set_updated_at();

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  entity_type user_entity_type not null default 'personal',
  country char(2) not null default 'US',
  base_currency char(3) not null default 'USD',
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index organizations_created_by_idx on organizations (created_by);

create trigger organizations_set_updated_at
  before update on organizations
  for each row execute function set_updated_at();

create table memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role org_role not null default 'viewer',
  invited_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index memberships_user_id_idx on memberships (user_id);
create index memberships_organization_id_idx on memberships (organization_id);

-- A user's own profile row is created reactively from auth signup, not by
-- application code guessing at the right moment — see the trigger on
-- auth.users below. This is the one place we hook Supabase Auth directly;
-- everything else in the schema is domain tables the app queries normally.
create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();
