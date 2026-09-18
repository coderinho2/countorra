-- Fixes from the LIVE verification against the real Supabase project. Three
-- problems, all reproduced against the remote database, two of which only
-- appear once you actually try to delete something.
--
--   1. A cross-tenant information leak that survived 0024: the org_id_of_*
--      helpers are SECURITY DEFINER (so they ignore RLS by design) and
--      0024 correctly revoked EXECUTE from `anon`/`PUBLIC` — but they must
--      stay executable by `authenticated`, because the RLS policies on
--      invoice_line_items / ai_messages / document_* call them. That left
--      them callable DIRECTLY, as `POST /rest/v1/rpc/org_id_of_document`,
--      by any logged-in user, for any uuid in the system. Verified live:
--      tenant A's owner passed tenant B's document/invoice/conversation ids
--      and got B's organization_id back every time.
--
--   2. 0024's `enforce_last_owner_remains` made it impossible to delete an
--      organization AT ALL. Deleting an organization cascades to
--      `memberships`; the trigger fires on the owner's row, counts zero
--      remaining owners, and aborts the whole statement. The invariant is
--      right, its scope was not: it must protect a LIVE organization from
--      losing its last owner, not object to a membership disappearing
--      because the organization itself is being removed. Verified live:
--      `delete from organizations` failed with "An organization must always
--      have at least one owner".
--
--   3. The append-only triggers on audit_logs/security_events also reject
--      the UPDATEs that Postgres itself performs for `ON DELETE SET NULL`.
--      `audit_logs.organization_id` is declared exactly that way, so an
--      organization with any audit history (i.e. every organization —
--      bootstrap records `organization.created`) could not be deleted even
--      after fixing 2. The same shape blocks user deletion:
--      `audit_logs.actor_id` references auth.users with no ON DELETE
--      action, so anyone who has ever performed an audited action can never
--      be removed from auth.users — a right-to-erasure problem, not just a
--      housekeeping one. Verified live: three test users were undeletable,
--      each pinned by a single audit row.

-- ── 1. org_id_of_* must not answer for organizations you aren't in ───────
-- Adding the membership test INSIDE the function preserves every existing
-- policy exactly. Each call site is already wrapped in
-- `is_org_member(...)` / `is_org_role(...)` of the returned value, so for a
-- member the function returns the same id it always did, and for a
-- non-member it now returns NULL — which those wrappers evaluate as false,
-- the same denial they produced before. The difference is only visible to a
-- caller invoking the function directly, which is precisely the leak.
create or replace function org_id_of_document(target_document_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select d.organization_id
  from documents d
  where d.id = target_document_id
    and is_org_member(d.organization_id);
$$;

create or replace function org_id_of_invoice(target_invoice_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select i.organization_id
  from invoices i
  where i.id = target_invoice_id
    and is_org_member(i.organization_id);
$$;

create or replace function org_id_of_conversation(target_conversation_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.organization_id
  from ai_conversations c
  where c.id = target_conversation_id
    and is_org_member(c.organization_id);
$$;

-- ── 2. The last-owner invariant applies to live organizations only ──────
create or replace function enforce_last_owner_remains()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_remaining int;
begin
  if old.role <> 'owner' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' then
    return new;
  end if;

  -- The organization is being deleted and this membership is going with it
  -- (FK cascade). Postgres removes the parent row before running the
  -- cascade, so its absence here is the reliable signal. Guarding on this
  -- rather than on tg_op keeps the invariant intact for every path that
  -- removes a membership from an organization that still exists.
  if not exists (select 1 from organizations o where o.id = old.organization_id) then
    return coalesce(new, old);
  end if;

  select count(*) into v_remaining
  from memberships m
  where m.organization_id = old.organization_id
    and m.role = 'owner'
    and m.id <> old.id;

  if v_remaining = 0 then
    raise exception 'An organization must always have at least one owner';
  end if;

  return coalesce(new, old);
end;
$$;

-- ── 3. Append-only means the EVENT is immutable, not that rows pin rows ─
-- The record of what happened stays untouchable: no column that describes
-- the event (action, resource, metadata, timestamp, actor_type) can ever be
-- changed, and DELETE remains rejected outright. The single exception is
-- Postgres nulling a foreign key it owns — `organization_id ON DELETE SET
-- NULL`, and `actor_id` once it is given the same treatment below. That is
-- a reference being severed, not history being rewritten, and without it
-- neither an organization nor a user can ever be deleted.
create or replace function reject_audit_log_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'audit_logs is append-only: DELETE is not permitted';
  end if;

  -- Permit ONLY the severing of an actor/organization reference, and only
  -- towards NULL. Every other column must be byte-identical.
  if (new.organization_id is not distinct from old.organization_id or new.organization_id is null)
     and (new.actor_id is not distinct from old.actor_id or new.actor_id is null)
     and new.id is not distinct from old.id
     and new.actor_type is not distinct from old.actor_type
     and new.action is not distinct from old.action
     and new.resource_type is not distinct from old.resource_type
     and new.resource_id is not distinct from old.resource_id
     and new.metadata::text is not distinct from old.metadata::text
     and new.created_at is not distinct from old.created_at
  then
    return new;
  end if;

  raise exception 'audit_logs is append-only: UPDATE is not permitted';
end;
$$;

-- security_events shares the trigger function but has a different column
-- set; give it its own so neither table's rules are loosened by the other's.
create or replace function reject_security_event_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'security_events is append-only: DELETE is not permitted';
  end if;

  if (new.organization_id is not distinct from old.organization_id or new.organization_id is null)
     and (new.user_id is not distinct from old.user_id or new.user_id is null)
     and new.id is not distinct from old.id
     and new.event_type is not distinct from old.event_type
     and new.severity is not distinct from old.severity
     and new.metadata::text is not distinct from old.metadata::text
     and new.created_at is not distinct from old.created_at
  then
    return new;
  end if;

  raise exception 'security_events is append-only: UPDATE is not permitted';
end;
$$;

drop trigger security_events_no_update on security_events;
drop trigger security_events_no_delete on security_events;

create trigger security_events_no_update
  before update on security_events
  for each row execute function reject_security_event_mutation();

create trigger security_events_no_delete
  before delete on security_events
  for each row execute function reject_security_event_mutation();

-- Now the actor references can be severed on account deletion. The audit
-- entry itself survives in full — action, resource, metadata, timestamp —
-- it simply stops naming a user row that no longer exists.
alter table audit_logs drop constraint audit_logs_actor_id_fkey;
alter table audit_logs
  add constraint audit_logs_actor_id_fkey
  foreign key (actor_id) references auth.users (id) on delete set null;

alter table security_events drop constraint security_events_user_id_fkey;
alter table security_events
  add constraint security_events_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete set null;
