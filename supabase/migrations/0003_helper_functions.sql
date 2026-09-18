-- Authorization helper functions used throughout RLS policies (0011).
--
-- Each is `security definer` so it can read `memberships` (and, for the
-- org_id_of_* helpers, a parent table) regardless of the calling row's own
-- RLS — without this, a policy that calls another RLS-protected table from
-- inside itself risks silent recursion or false negatives. `search_path` is
-- pinned to prevent search-path hijacking, the standard hardening for
-- `security definer` functions in Postgres.

create or replace function is_org_member(target_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from memberships m
    where m.organization_id = target_org_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function is_org_role(target_org_id uuid, allowed_roles org_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from memberships m
    where m.organization_id = target_org_id
      and m.user_id = auth.uid()
      and m.role = any (allowed_roles)
  );
$$;

-- org_id_of_document / org_id_of_invoice / org_id_of_conversation are
-- defined alongside their respective tables (0006, 0007, 0008) rather than
-- here, since those tables don't exist yet at this point in the migration
-- sequence.
