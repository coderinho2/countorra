-- Security fixes from the red-team audit. Six independent problems, all
-- reproduced against this schema before being fixed here (the
-- reproductions now live as regression tests in tests/rls/security-audit.test.ts):
--
--   1. record_audit_event() was SECURITY DEFINER with no authorization
--      check and EXECUTE granted to `anon` (0023) — ANY authenticated
--      user, and any *unauthenticated* caller, could append arbitrary
--      rows to ANY organization's append-only audit trail, including
--      rows claiming actor_type='system'. Append-only means the victim
--      organization can never remove them.
--   2. ai_actions' UPDATE policy let any owner/admin/accountant/manager
--      rewrite a pending action's tool_name / operation_mode / input
--      AFTER a human had been shown it, jump straight to
--      status='executed', and set confirmed_by to somebody else's user
--      id — defeating both the confirmation gate's integrity and its
--      attribution.
--   3. ai_conversations/ai_messages were readable (and writable) by every
--      member of the organization, not just the person whose
--      conversation it is: a `viewer` could read the owner's private
--      financial Q&A and insert forged 'system'/'assistant' turns into it.
--   4. An `admin` could grant the `owner` role to an account they also
--      control and delete the real owner's membership — a full
--      organization takeover that walked straight around the
--      self-escalation guard (which only blocks editing your OWN row).
--   5. 0023 granted `anon` SELECT on every table and EXECUTE on every
--      function in `public`. RLS made that mostly inert, but it left
--      org_id_of_document/_invoice/_conversation callable by an
--      unauthenticated client as an id -> organization oracle.
--   6. No table guaranteed an organization always retains an owner.

-- ── 1. record_audit_event: authorize the caller ──────────────────────────
-- Same signature (callers in src/domain/audit/audit-log.ts are unchanged),
-- but the actor now has to be a real, authenticated member of the
-- organization the event is being written against, and cannot claim to be
-- the system. actor_id was already auth.uid() and stays that way.
create or replace function record_audit_event(
  p_organization_id uuid,
  p_action text,
  p_resource_type text default null,
  p_resource_id uuid default null,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_type text default 'user'
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'record_audit_event requires an authenticated session';
  end if;

  if p_organization_id is null or not is_org_member(p_organization_id) then
    raise exception 'record_audit_event: caller is not a member of that organization';
  end if;

  -- 'system' is reserved for service-role/back-end writers, which do not
  -- go through this function at all. A session-authenticated caller can
  -- only ever record a 'user' or 'ai' actor.
  if p_actor_type not in ('user', 'ai') then
    raise exception 'record_audit_event: actor_type % is not writable from a user session', p_actor_type;
  end if;

  insert into audit_logs (organization_id, actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (p_organization_id, v_actor, p_actor_type, p_action, p_resource_type, p_resource_id, p_metadata)
  returning id into v_id;

  return v_id;
end;
$$;

-- ── 2. ai_actions: immutability + legal state machine ────────────────────
-- The confirmation a human gives is a confirmation of *specific* tool +
-- input. Neither may change after the row is created, so what gets
-- executed is always what was shown. Status may only move along the real
-- lifecycle, which also makes replay/double-execution impossible at the
-- database level (an already-executed action can never go back to
-- confirmed).
create or replace function enforce_ai_action_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.conversation_id is distinct from old.conversation_id
     or new.operation_mode is distinct from old.operation_mode
     or new.tool_name is distinct from old.tool_name
     or new.input::text is distinct from old.input::text then
    raise exception 'ai_actions: organization_id, conversation_id, operation_mode, tool_name and input are immutable once proposed';
  end if;

  -- A user session can only ever record ITSELF as the confirmer. (A
  -- service-role caller has no auth.uid() and is left alone — it is the
  -- back end acting on an already-authorized request.)
  if new.confirmed_by is distinct from old.confirmed_by
     and auth.uid() is not null
     and new.confirmed_by is distinct from auth.uid() then
    raise exception 'ai_actions: confirmed_by must be the confirming user';
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'pending_confirmation' and new.status in ('confirmed', 'rejected', 'failed'))
      or (old.status = 'confirmed' and new.status in ('executed', 'failed'))
    ) then
      raise exception 'ai_actions: illegal status transition % -> %', old.status, new.status;
    end if;
  end if;

  return new;
end;
$$;

create trigger ai_actions_enforce_integrity
  before update on ai_actions
  for each row execute function enforce_ai_action_integrity();

-- ── 3. AI conversations are private to the person who had them ──────────
-- "Any member of the org" was the wrong grain: the product presents these
-- as *your* conversations (they are listed per-user, renamed per-user and
-- deleted per-user already), and they contain whatever the user chose to
-- ask about their finances.
create or replace function owns_conversation(target_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from ai_conversations c
    where c.id = target_conversation_id
      and c.user_id = auth.uid()
  );
$$;

drop policy ai_conversations_select_member on ai_conversations;
create policy ai_conversations_select_own on ai_conversations
  for select using (is_org_member(organization_id) and user_id = auth.uid());

drop policy ai_messages_select_member on ai_messages;
create policy ai_messages_select_own on ai_messages
  for select using (
    is_org_member(org_id_of_conversation(conversation_id))
    and owns_conversation(conversation_id)
  );

drop policy ai_messages_insert_member on ai_messages;
create policy ai_messages_insert_own on ai_messages
  for insert with check (
    is_org_member(org_id_of_conversation(conversation_id))
    and owns_conversation(conversation_id)
  );

-- ── 4/6. Only an owner may create, alter or remove an owner ─────────────
-- The previous policies stopped a member editing their own row, which an
-- admin trivially side-steps with a second account. `owner` is now a
-- role only an existing owner can hand out, take away, or delete.
drop policy memberships_insert_admin on memberships;
create policy memberships_insert_admin on memberships
  for insert with check (
    is_org_role(organization_id, array['owner', 'admin']::org_role[])
    and (role <> 'owner' or is_org_role(organization_id, array['owner']::org_role[]))
  );

drop policy memberships_update_admin_not_self on memberships;
create policy memberships_update_admin_not_self on memberships
  for update
  using (
    is_org_role(organization_id, array['owner', 'admin']::org_role[])
    and user_id <> auth.uid()
    -- demoting/altering an existing owner requires being an owner
    and (role <> 'owner' or is_org_role(organization_id, array['owner']::org_role[]))
  )
  with check (
    is_org_role(organization_id, array['owner', 'admin']::org_role[])
    and user_id <> auth.uid()
    -- granting the owner role requires being an owner
    and (role <> 'owner' or is_org_role(organization_id, array['owner']::org_role[]))
  );

drop policy memberships_delete_admin_not_self on memberships;
create policy memberships_delete_admin_not_self on memberships
  for delete using (
    is_org_role(organization_id, array['owner', 'admin']::org_role[])
    and user_id <> auth.uid()
    and (role <> 'owner' or is_org_role(organization_id, array['owner']::org_role[]))
  );

-- An organization can never be left ownerless — otherwise the owner-only
-- operations above (and organizations_delete_owner) become permanently
-- unreachable for everyone.
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

create trigger memberships_keep_an_owner
  before update or delete on memberships
  for each row execute function enforce_last_owner_remains();

-- ── 5. Shrink the unauthenticated surface ───────────────────────────────
-- 0023 handed `anon` blanket SELECT on every table and EXECUTE on every
-- function so that RLS could run at all. RLS did hold, but `plans` is the
-- only table a signed-out visitor has any reason to read, and the
-- org_id_of_* helpers were usable as an unauthenticated
-- "which organization owns this uuid?" oracle. is_org_member/is_org_role
-- keep their anon grant on purpose: they only ever report on auth.uid()
-- (always null for anon), and revoking them would turn a clean
-- zero-rows denial into a function-permission error on any anon query.
revoke select on all tables in schema public from anon;
grant select on plans to anon;

-- Revoked from PUBLIC as well as `anon`: Postgres grants EXECUTE on a new
-- function to PUBLIC by default, so revoking the role grant alone leaves
-- the function callable. `authenticated`/`service_role` keep the explicit
-- grants 0023 gave them.
revoke execute on function record_audit_event(uuid, text, text, uuid, jsonb, text) from public, anon;
revoke execute on function org_id_of_document(uuid) from public, anon;
revoke execute on function org_id_of_invoice(uuid) from public, anon;
revoke execute on function org_id_of_conversation(uuid) from public, anon;
revoke execute on function owns_conversation(uuid) from public, anon;
grant execute on function record_audit_event(uuid, text, text, uuid, jsonb, text) to authenticated, service_role;
grant execute on function org_id_of_document(uuid) to authenticated, service_role;
grant execute on function org_id_of_invoice(uuid) to authenticated, service_role;
grant execute on function org_id_of_conversation(uuid) to authenticated, service_role;
grant execute on function owns_conversation(uuid) to authenticated, service_role;

-- ── 7. notification_reads could be written for any notification id ──────
-- The old policy only checked `user_id = auth.uid()`, so a member could
-- insert a read receipt for another organization's notification uuid.
-- Harmless on its own, but it is a write into a row keyed on data the
-- caller should not be able to reference at all.
drop policy notification_reads_insert_own on notification_reads;
create policy notification_reads_insert_own on notification_reads
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1
      from notifications n
      where n.id = notification_id
        and is_org_member(n.organization_id)
        and (n.user_id is null or n.user_id = auth.uid())
    )
  );

alter default privileges in schema public revoke select on tables from anon;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public
  grant execute on functions to authenticated, service_role;
