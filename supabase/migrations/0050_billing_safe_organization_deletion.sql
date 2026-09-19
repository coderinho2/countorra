-- Billing-safe organization deletion (Task 17).
--
-- THE INVARIANT
--
-- An organization must never disappear while Stripe may still be charging
-- for it. `subscriptions` cascades with its organization (0010), so deleting
-- the organization row deletes the only local record of the Stripe
-- subscription — and Stripe, which knows nothing about that, keeps billing.
--
-- The application now cancels in Stripe first (src/server/billing/
-- deletion-safety.ts). This migration makes the database hold the same line,
-- so the invariant does not depend on every caller remembering to:
--
--   1. The browser can no longer delete an organization directly. Until now
--      `organizations_delete_owner` let an owner's own session issue
--      `DELETE FROM organizations` through the Data API, skipping Stripe,
--      bank-credential release and storage cleanup alike. Deletion is a
--      server-side, re-authenticated flow and nothing else.
--   2. A per-organization teardown lock, so two deletions cannot interleave
--      and Checkout cannot open a new subscription while one is running.
--   3. A recorder that writes a TERMINAL Stripe state established by the
--      server, stamped with Stripe's own cancellation time so an older
--      webhook delivery is discarded as stale and cannot restore paid access.
--   4. A guard: no organization is deleted — by anyone, service role
--      included — while its row still records a Stripe subscription that is
--      not canceled or expired.

-- ── 1. No direct organization deletion from a browser session ──────────────
drop policy if exists organizations_delete_owner on organizations;
revoke delete on organizations from anon, authenticated;

-- ── 2. Teardown lock ───────────────────────────────────────────────────────
alter table subscriptions
  add column if not exists deletion_lock_id uuid,
  add column if not exists deletion_locked_at timestamptz;

comment on column subscriptions.deletion_lock_id is
  'Set while a server-side deletion is cancelling this organization''s billing. Blocks a second deletion and new Checkout sessions. Expires after 15 minutes so a crashed attempt cannot lock billing forever.';

-- Returns true when the caller now holds the lock (or there is no billing row
-- at all, so nothing can be billed). False means another attempt holds a live
-- lock: the caller must not proceed.
create or replace function acquire_organization_billing_teardown(p_organization_id uuid, p_attempt_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exists boolean;
begin
  update subscriptions
     set deletion_lock_id = p_attempt_id,
         deletion_locked_at = now()
   where organization_id = p_organization_id
     and (deletion_lock_id is null
          or deletion_lock_id = p_attempt_id
          or deletion_locked_at < now() - interval '15 minutes');

  if found then
    return true;
  end if;

  select exists (select 1 from subscriptions where organization_id = p_organization_id) into v_exists;
  -- A row exists but is locked by someone else: refuse. No row: nothing to
  -- lock, and nothing can be billed (Checkout cannot bind a customer to a
  -- missing row — see bind_stripe_customer in 0035).
  return not v_exists;
end;
$$;

-- Releases only the caller's own lock, so a slow attempt cannot free a lock
-- a newer attempt has since taken over.
create or replace function release_organization_billing_teardown(p_organization_id uuid, p_attempt_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update subscriptions
     set deletion_lock_id = null,
         deletion_locked_at = null
   where organization_id = p_organization_id
     and deletion_lock_id = p_attempt_id;
end;
$$;

-- ── 3. Recording a terminal state the server verified with Stripe ──────────
-- Only terminal statuses are accepted: this function can take paid access
-- away, never grant it. `stripe_event_at` moves forward to Stripe's
-- cancellation time, so any webhook event created before the cancellation is
-- stale under apply_stripe_subscription_event (0035) and changes nothing.
create or replace function record_stripe_subscription_terminal(
  p_organization_id uuid,
  p_stripe_subscription_id text,
  p_status subscription_status,
  p_canceled_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('canceled', 'incomplete_expired') then
    raise exception 'record_stripe_subscription_terminal accepts only a terminal status, got %', p_status
      using errcode = '22023';
  end if;

  update subscriptions
     set status = p_status,
         cancel_at_period_end = false,
         canceled_at = coalesce(canceled_at, p_canceled_at),
         stripe_event_at = greatest(coalesce(stripe_event_at, p_canceled_at), p_canceled_at),
         updated_at = now()
   where organization_id = p_organization_id
     and external_provider = 'stripe'
     and external_subscription_id = p_stripe_subscription_id;

  return found;
end;
$$;

revoke execute on function acquire_organization_billing_teardown(uuid, uuid) from public, anon, authenticated;
revoke execute on function release_organization_billing_teardown(uuid, uuid) from public, anon, authenticated;
revoke execute on function record_stripe_subscription_terminal(uuid, text, subscription_status, timestamptz) from public, anon, authenticated;
grant execute on function acquire_organization_billing_teardown(uuid, uuid) to service_role;
grant execute on function release_organization_billing_teardown(uuid, uuid) to service_role;
grant execute on function record_stripe_subscription_terminal(uuid, text, subscription_status, timestamptz) to service_role;

-- ── 4. The guard ───────────────────────────────────────────────────────────
-- Fires for every role, service role included. A row that merely has a bound
-- customer (bind_stripe_customer sets the provider before any payment) has no
-- subscription id and is not blocked; one with a subscription id must be in a
-- terminal state first.
create or replace function refuse_delete_with_live_stripe_subscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
      from subscriptions s
     where s.organization_id = old.id
       and s.external_provider = 'stripe'
       and s.external_subscription_id is not null
       and s.status not in ('canceled', 'incomplete_expired')
  ) then
    raise exception 'This organization still has a Stripe subscription that is not canceled. Cancel it before deleting the organization.'
      using errcode = 'P0001';
  end if;
  return old;
end;
$$;

revoke execute on function refuse_delete_with_live_stripe_subscription() from public, anon, authenticated;

drop trigger if exists organizations_refuse_delete_with_live_stripe_subscription on organizations;
create trigger organizations_refuse_delete_with_live_stripe_subscription
  before delete on organizations
  for each row execute function refuse_delete_with_live_stripe_subscription();
