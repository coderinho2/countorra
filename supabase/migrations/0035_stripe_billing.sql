-- Stripe billing: the minimum schema needed to bind a local subscription to
-- Stripe, plus the machinery that makes webhook delivery safe.
--
-- WHAT ALREADY EXISTED, AND IS REUSED RATHER THAN DUPLICATED
--
-- `subscriptions` (0010) was designed for this: it is 1:1 with an
-- organization (`organization_id ... unique`), and already carries
-- `plan_id`, `status`, `current_period_end`, `external_provider` and
-- `external_subscription_id`. The Stripe subscription id goes in those last
-- two — a second `stripe_subscription_id` column would be the same fact in
-- two places, and they would eventually disagree.
--
-- `plans` and the entitlement model are NOT touched. Stripe decides billing
-- state; `entitlementsFor()` decides what a state is worth. Nothing in this
-- file grants a capability.
--
-- WHY A WEBHOOK EVENT TABLE, AND WHY THE WORK HAPPENS IN A FUNCTION
--
-- Stripe guarantees at-least-once delivery: the same event arrives again
-- after a timeout, a retry, or a redelivery from the dashboard, and two
-- deliveries can be in flight at once. Recording processed event ids is only
-- half an answer — if the id is committed in one statement and the
-- subscription updated in another, a crash between them consumes the event
-- without applying it, and it is never retried.
--
-- `apply_stripe_subscription_event` therefore does both in ONE function, so
-- they share a transaction: either the event is recorded AND the subscription
-- moved, or neither happened and Stripe's retry finds nothing to skip.

-- ── 1. Stripe identifiers on the existing subscription row ──────────────
alter table subscriptions
  add column stripe_customer_id text,
  add column stripe_price_id text,
  add column current_period_start timestamptz,
  add column cancel_at_period_end boolean not null default false,
  add column canceled_at timestamptz,
  -- The `created` timestamp of the most recent Stripe event applied to this
  -- row. Stripe does not order webhook deliveries, so a `subscription.updated`
  -- can arrive after the `subscription.deleted` that superseded it. Comparing
  -- against this is what stops an older event overwriting newer state.
  add column stripe_event_at timestamptz;

comment on column subscriptions.stripe_customer_id is
  'Stripe Customer id for this organization. Created server-side before Checkout so the webhook can always resolve the organization; survives cancellation, so the Customer Portal keeps working.';
comment on column subscriptions.stripe_event_at is
  'created-timestamp of the newest Stripe event applied. Older events are ignored — see apply_stripe_subscription_event.';

-- One Stripe customer belongs to exactly one organization, and one Stripe
-- subscription to exactly one row. Partial, because both are null until an
-- organization first reaches Checkout.
create unique index subscriptions_stripe_customer_id_key
  on subscriptions (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index subscriptions_stripe_subscription_id_key
  on subscriptions (external_subscription_id)
  where external_provider = 'stripe' and external_subscription_id is not null;

-- ── 2. Delivered events, for idempotency ────────────────────────────────
create table stripe_webhook_events (
  -- Stripe's own event id (`evt_...`). The primary key IS the idempotency
  -- mechanism: `insert ... on conflict do nothing` is an atomic claim, and a
  -- concurrent duplicate blocks on it rather than racing past it.
  id text primary key,
  type text not null,
  /** `created` from the Stripe event, not our clock. */
  event_created_at timestamptz,
  organization_id uuid references organizations (id) on delete set null,
  /** What the handler decided: applied / stale / unknown_customer. Kept so an
   *  event that changed nothing is still visible when someone asks why a
   *  subscription did not move. */
  outcome text,
  received_at timestamptz not null default now()
);

create index stripe_webhook_events_received_at_idx on stripe_webhook_events (received_at desc);
create index stripe_webhook_events_organization_id_idx on stripe_webhook_events (organization_id, received_at desc);

-- Billing history is not tenant data a client may read: it names Stripe
-- identifiers and delivery internals. No policy is created for
-- `authenticated`, matching `audit_logs` — the service role bypasses RLS and
-- is the only writer.
alter table stripe_webhook_events enable row level security;

revoke all on stripe_webhook_events from anon, authenticated;
grant select, insert, update on stripe_webhook_events to service_role;

-- ── 3. Claim the event and apply it, atomically ─────────────────────────
--
-- Returns one of:
--   'duplicate'        — this event id was already recorded; nothing done.
--   'stale'            — an event at least as new has already been applied.
--   'unknown_customer' — no subscription matches; recorded, not applied.
--   'applied'          — subscription synchronised.
--
-- The caller has already verified the Stripe signature and mapped the price
-- id to a plan tier; this function does not decide entitlements and never
-- reads `plans`.
create or replace function apply_stripe_subscription_event(
  p_event_id text,
  p_event_type text,
  p_event_created timestamptz,
  p_organization_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_plan_id plan_tier,
  p_status subscription_status,
  p_current_period_start timestamptz,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_canceled_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed text;
  v_target subscriptions%rowtype;
  v_outcome text;
begin
  -- Atomic claim. A concurrent duplicate blocks here until the first
  -- transaction commits, then finds the conflict and gets no row back.
  --
  -- `organization_id` is deliberately NOT written here. It arrives from
  -- Stripe metadata and has not been verified to exist: an event naming a
  -- deleted organization would violate the foreign key, abort the function,
  -- and make the webhook return 503 — so Stripe would retry that event
  -- forever, every time, with no possible outcome. It is set below only once
  -- a real subscription row has been resolved, which is also when it becomes
  -- a fact rather than a claim.
  insert into stripe_webhook_events (id, type, event_created_at)
  values (p_event_id, p_event_type, p_event_created)
  on conflict (id) do nothing
  returning id into v_claimed;

  if v_claimed is null then
    return 'duplicate';
  end if;

  -- Resolve the organization. The Stripe customer is authoritative once it
  -- exists; the organization id from Checkout metadata is the fallback for
  -- the very first event, before any customer has been recorded.
  select * into v_target from subscriptions
  where stripe_customer_id = p_stripe_customer_id
  limit 1;

  if not found and p_organization_id is not null then
    select * into v_target from subscriptions
    where organization_id = p_organization_id
    limit 1;
  end if;

  if not found then
    update stripe_webhook_events set outcome = 'unknown_customer' where id = p_event_id;
    return 'unknown_customer';
  end if;

  -- Out-of-order protection. Stripe does not order deliveries, so an older
  -- event must never overwrite newer state. Equal timestamps are treated as
  -- stale too: the newer event was already applied, and re-applying an
  -- identical snapshot gains nothing.
  if v_target.stripe_event_at is not null
     and p_event_created is not null
     and p_event_created <= v_target.stripe_event_at then
    update stripe_webhook_events
       set outcome = 'stale', organization_id = v_target.organization_id
     where id = p_event_id;
    return 'stale';
  end if;

  update subscriptions set
    plan_id = p_plan_id,
    status = p_status,
    stripe_customer_id = coalesce(p_stripe_customer_id, stripe_customer_id),
    stripe_price_id = p_stripe_price_id,
    external_provider = 'stripe',
    external_subscription_id = coalesce(p_stripe_subscription_id, external_subscription_id),
    current_period_start = p_current_period_start,
    current_period_end = p_current_period_end,
    cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
    canceled_at = p_canceled_at,
    stripe_event_at = coalesce(p_event_created, stripe_event_at)
  where id = v_target.id;

  v_outcome := 'applied';
  update stripe_webhook_events
     set outcome = v_outcome, organization_id = v_target.organization_id
   where id = p_event_id;

  return v_outcome;
end;
$$;

-- Service role only. This function writes plan state; nothing reachable from
-- a browser session may call it.
revoke execute on function apply_stripe_subscription_event(
  text, text, timestamptz, uuid, text, text, text, plan_tier, subscription_status, timestamptz, timestamptz, boolean, timestamptz
) from public, anon, authenticated;

grant execute on function apply_stripe_subscription_event(
  text, text, timestamptz, uuid, text, text, text, plan_tier, subscription_status, timestamptz, timestamptz, boolean, timestamptz
) to service_role;

-- ── 4. Binding a Stripe customer before Checkout ────────────────────────
-- Called once, server-side, when an organization first reaches Checkout. Kept
-- as a function so the write stays service-role-only and so the "one customer
-- per organization" rule is enforced in one place rather than at call sites.
create or replace function bind_stripe_customer(p_organization_id uuid, p_stripe_customer_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update subscriptions
     set stripe_customer_id = p_stripe_customer_id,
         external_provider = 'stripe'
   where organization_id = p_organization_id
     and stripe_customer_id is null;
end;
$$;

revoke execute on function bind_stripe_customer(uuid, text) from public, anon, authenticated;
grant execute on function bind_stripe_customer(uuid, text) to service_role;
