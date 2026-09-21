-- Personal-only launch scope.
--
-- THE DECISION
--
-- Countorra launches as a personal finance and personal tax product. Freelancer
-- and Business workspaces are deferred (src/domain/organizations/launch-scope.ts).
--
-- WHAT THIS DOES — AND DELIBERATELY DOES NOT DO
--
--   * The `user_entity_type` enum keeps all three values. Removing a value from
--     a live Postgres enum means recreating the type and rewriting every row of
--     `organizations`; it buys nothing, and Freelancer/Business may return.
--   * No row is updated or deleted. Workspaces already stored as 'freelancer'
--     or 'business' keep that value and all of their data. The application
--     presents every workspace as personal, and hides the deferred invoicing
--     module; its tables and rows are untouched.
--   * From now on no organization can be CREATED with any type but 'personal',
--     and no organization can be CHANGED to 'freelancer' or 'business' — by any
--     caller, the service role included, so the rule does not depend on every
--     code path remembering it. A legacy workspace may still be changed TO
--     'personal'.
--
-- RLS, membership, roles and tenant isolation are unaffected: no policy reads
-- `entity_type`, and none is altered here.
--
-- To see the legacy workspaces this leaves in place:
--
--   select entity_type, count(*) from organizations group by entity_type;
--
-- REVERSAL (when Freelancer/Business return):
--
--   drop trigger if exists organizations_personal_launch_scope on organizations;
--   drop function if exists enforce_personal_launch_scope();

create or replace function enforce_personal_launch_scope()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.entity_type is distinct from 'personal' then
    raise exception 'Countorra currently supports personal workspaces only (entity_type %)', new.entity_type
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
     and new.entity_type is distinct from old.entity_type
     and new.entity_type is distinct from 'personal' then
    raise exception 'Countorra currently supports personal workspaces only (entity_type %)', new.entity_type
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function enforce_personal_launch_scope() is
  'Launch scope: only personal organizations may be created, and none may be changed to freelancer or business. Legacy rows keep their value. See 0051_personal_launch_scope.sql for the reversal.';

drop trigger if exists organizations_personal_launch_scope on organizations;
create trigger organizations_personal_launch_scope
  before insert or update of entity_type on organizations
  for each row
  execute function enforce_personal_launch_scope();
