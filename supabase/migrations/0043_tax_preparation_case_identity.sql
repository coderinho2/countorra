-- A preparation case's identity cannot be rewritten after it is created.
--
-- FOUND DURING LIVE VERIFICATION (Task 7.1), NOT A FEATURE.
--
-- 0042 grants write-capable members an UPDATE policy on
-- tax_preparation_cases, and that is right: a case is edited all the time —
-- filing status, taxpayer names, workflow status, version. But RLS policies are
-- row-level. They answer "may this person update this row?", never "which
-- columns?". So the same member, calling the REST API directly instead of using
-- the app, could rewrite the columns that give a case its meaning:
--
--   id               the case's identity. Audit events, facts, dependents and
--                    snapshots all refer to it; a case with no children yet
--                    could be re-keyed, orphaning its audit trail
--   tax_year         every fact, snapshot and stored calculation is about THIS
--                    year; moving the case silently reinterprets all of them
--   organization_id  the tenant boundary. The WITH CHECK clause only requires
--                    membership of the NEW workspace, so an owner of two
--                    workspaces could move a year's preparation between them
--   created_at       when the year was opened
--   created_by       who opened it
--
-- The application never sends any of these on update (see
-- updatePreparationCase in src/server/db/repositories/tax-preparation.ts).
-- "The app never sends it" is precisely the guarantee that ends at the first
-- hand-written request, so it is enforced here, for every path: the UI, an
-- authenticated REST call, an upsert (ON CONFLICT DO UPDATE fires this
-- trigger too), and service-role code, which RLS does not see at all.
--
-- ONE NARROW EXCEPTION: created_by may become NULL, but only when PostgreSQL
-- itself does it. The foreign key to auth.users is `on delete set null`, and
-- account deletion (auth.admin.deleteUser) relies on exactly that. PostgreSQL
-- performs the SET NULL as an UPDATE issued from inside its referential-
-- integrity trigger, so this trigger then runs nested: pg_trigger_depth() > 1.
-- A direct UPDATE from any client runs at depth 1 and is refused — whether it
-- tries to reassign the creator or merely clear it. Nothing in this codebase
-- clears created_by directly; if something ever needs to, it must be a
-- deliberate change here, not a quiet workaround.
--
-- primary_state_region is deliberately NOT locked. The organization's own
-- setting is the authority for jurisdiction (src/domain/tax-preparation/
-- jurisdiction.ts), and the stored column is kept in step with it when a case
-- is calculated — so it must remain updatable, and a value written to it by
-- hand is ignored rather than trusted.
--
-- Additive: one function and one trigger. No row is inserted, updated or
-- deleted, no existing column or constraint changes, and a correct update —
-- including one that repeats the existing values — is unaffected.

create or replace function tax_preparation_cases_identity_is_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'tax_preparation_cases.id cannot be changed: it is the identity every fact, snapshot and audit event refers to'
      using errcode = 'check_violation';
  end if;

  if new.tax_year is distinct from old.tax_year then
    raise exception 'tax_preparation_cases.tax_year cannot be changed: a preparation case is its tax year'
      using errcode = 'check_violation';
  end if;

  if new.organization_id is distinct from old.organization_id then
    raise exception 'tax_preparation_cases.organization_id cannot be changed: a preparation case cannot move between workspaces'
      using errcode = 'check_violation';
  end if;

  if new.created_at is distinct from old.created_at then
    raise exception 'tax_preparation_cases.created_at cannot be changed'
      using errcode = 'check_violation';
  end if;

  if new.created_by is distinct from old.created_by then
    -- Only the foreign key's own ON DELETE SET NULL, which runs nested inside
    -- PostgreSQL's referential-integrity trigger. See the header.
    if not (new.created_by is null and pg_trigger_depth() > 1) then
      raise exception 'tax_preparation_cases.created_by cannot be changed: only deleting the creator''s account may clear it'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function tax_preparation_cases_identity_is_immutable() is
  'Refuses any change to a preparation case''s id, tax_year, organization_id, created_at and created_by. The single exception is created_by becoming NULL through the auth.users foreign key''s ON DELETE SET NULL (account deletion). RLS cannot express column-level immutability.';

create trigger tax_preparation_cases_identity_immutable
  before update on tax_preparation_cases
  for each row execute function tax_preparation_cases_identity_is_immutable();
