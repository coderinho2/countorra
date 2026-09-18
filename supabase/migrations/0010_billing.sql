-- Billing foundation (DESIGN brief §30): plan/subscription/entitlement
-- shape only. No payment provider is integrated in Phase 1 — pricing is
-- explicitly undecided, so premium/business prices are left null rather
-- than filled with invented numbers.

create table plans (
  id plan_tier primary key,
  name text not null,
  price_minor bigint,
  currency char(3) not null default 'USD',
  entitlements jsonb not null default '{}'::jsonb,
  is_active boolean not null default true
);

insert into plans (id, name, price_minor, entitlements) values
  ('free', 'Free', 0, '{"ai_accountant": false, "document_processing": false, "max_organizations": 1}'::jsonb),
  ('premium', 'Premium', null, '{"ai_accountant": true, "document_processing": true, "max_organizations": 3}'::jsonb),
  ('business', 'Business', null, '{"ai_accountant": true, "document_processing": true, "max_organizations": null}'::jsonb);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references organizations (id) on delete cascade,
  plan_id plan_tier not null default 'free' references plans (id),
  status subscription_status not null default 'active',
  current_period_end timestamptz,
  external_provider text,
  external_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger subscriptions_set_updated_at
  before update on subscriptions
  for each row execute function set_updated_at();
