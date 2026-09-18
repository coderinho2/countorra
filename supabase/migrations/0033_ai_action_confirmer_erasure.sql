-- The last foreign key that could block account deletion, and the reason it
-- produced a PARTIAL deletion rather than a clean refusal.
--
-- THE REPRODUCED FAILURE
--
-- `ai_actions.confirmed_by` referenced `auth.users` with no ON DELETE action.
-- Migration 0029 converted every other attribution column to SET NULL but
-- deliberately skipped this one, because 0008's CHECK forbids a null
-- `confirmed_by` on a confirmed/executed WRITE or DELETE action — SET NULL
-- would have violated it. The deletion flow compensated by nulling only the
-- rows the CHECK permits (`pending_confirmation`, `rejected`).
--
-- That left a real, ordinary path broken. A user who confirmed an AI write in
-- a workspace they merely LEAVE (rather than delete) keeps a
-- confirmed/executed row pointing at them, in an organization that survives.
-- `deleteAccountAction` had by then already removed their storage,
-- organizations, conversations and memberships; the final
-- `auth.admin.deleteUser` then failed on this constraint. Verified against
-- real Postgres:
--
--     DELETE auth.users: FAILED -> violates foreign key constraint
--       "ai_actions_confirmed_by_fkey" on table "ai_actions"
--     auth.users rows remaining: 1
--     memberships rows remaining: 0
--
-- The account was half deleted and the user was told to contact support.
--
-- WHAT THE INVARIANT IS ACTUALLY FOR
--
-- 0008's CHECK exists so a WRITE/DELETE action can never sit in a "done"
-- state without a human having approved it — the database-level backstop for
-- the confirmation gate. That protects against FORGING an approved action.
--
-- Erasing the approver's account is a different event. The approval happened;
-- the person is simply no longer identifiable. Conflating "nobody approved
-- this" with "the approver has since been erased" is what made the constraint
-- unsatisfiable, so this migration distinguishes them explicitly rather than
-- relaxing the rule.
--
-- HOW
--
--   1. `confirmer_deleted` records that this row HAD a confirmer whose account
--      was later erased. It is a tombstone, not a permission.
--   2. The CHECK accepts a null `confirmed_by` only when that tombstone is
--      set. An unconfirmed action still cannot be marked executed.
--   3. The FK becomes ON DELETE SET NULL, so deleting a user no longer fails.
--   4. A trigger sets the tombstone during that cascade — and REFUSES to clear
--      `confirmed_by` while the referenced user still exists.
--
-- Step 4 makes this a net STRENGTHENING. `ai_actions_update_privileged`
-- (0011) lets any owner/admin/accountant/manager update any ai_actions row in
-- their organization, so until now one of them could quietly strip a
-- colleague's name off an approved AI write. That is now refused by the
-- database, for everyone, including the service role.
--
-- No RLS policy is touched. No ai_actions row is ever deleted by anything
-- here: the audit history survives its author.

-- ── 1. The tombstone ────────────────────────────────────────────────────
alter table ai_actions
  add column confirmer_deleted boolean not null default false;

comment on column ai_actions.confirmer_deleted is
  'True when this action was confirmed by a user whose account has since been permanently deleted. Distinguishes "the approver was erased" from "nobody approved this" — see the CHECK below. Set only by enforce_ai_action_integrity(), never by application code.';

-- ── 2. The invariant, restated rather than relaxed ──────────────────────
-- Named explicitly this time; 0008 declared it inline, which left Postgres to
-- generate `ai_actions_check`. Dropping by that generated name fails loudly if
-- it is ever wrong, which is the behaviour we want — a silently surviving old
-- constraint would leave the deletion bug in place while every test passed.
alter table ai_actions drop constraint ai_actions_check;

alter table ai_actions
  add constraint ai_actions_confirmed_write_has_confirmer
  check (
    status not in ('confirmed', 'executed')
    or operation_mode not in ('write', 'delete')
    or confirmed_by is not null
    or confirmer_deleted
  );

-- ── 3. Detach on erasure, instead of blocking it ────────────────────────
alter table ai_actions drop constraint ai_actions_confirmed_by_fkey;

alter table ai_actions
  add constraint ai_actions_confirmed_by_fkey
  foreign key (confirmed_by) references auth.users (id) on delete set null;

-- Referencing columns used by an ON DELETE action should be indexed: without
-- this, every account deletion sequentially scans ai_actions.
create index ai_actions_confirmed_by_idx on ai_actions (confirmed_by);

-- ── 4. Attribution may only be dropped when the person is gone ──────────
-- Replaces the 0024 function, verbatim, plus one new block. The trigger
-- itself is unchanged and is not re-created.
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

  -- Clearing the confirmer is legitimate in exactly one situation: the
  -- account has been permanently deleted, and Postgres is applying
  -- ON DELETE SET NULL. By the time that referential action runs, the
  -- auth.users row is already gone from this transaction's view, so its
  -- absence is what distinguishes an erasure from someone rewriting history.
  --
  -- Anything else — an admin editing the row, a service-role caller, an
  -- UPDATE crafted by hand — is refused, because attribution on an approved
  -- AI write is not the confirming member's to remove and not anyone else's
  -- to remove for them.
  if old.confirmed_by is not null and new.confirmed_by is null then
    if exists (select 1 from auth.users where id = old.confirmed_by) then
      raise exception 'ai_actions: confirmed_by cannot be cleared while the confirming user still exists';
    end if;
    new.confirmer_deleted := true;
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
