-- Brings `plans` back into agreement with the canonical entitlement model
-- after the AI allowances were re-cut for the real Anthropic cost structure.
--
-- WHAT CHANGED, AND WHY
--
--   Free            20/day  ->    3/day
--   Premium        300/day  ->  100/day
--   Business    unlimited   ->  500/day
--
-- The Free number was the expensive one. Twenty provider requests per
-- organization per day is not twenty requests per user: a Free account could
-- create organizations without limit until 0028's allowance was enforced, and
-- each message can cost up to `maxProviderCallsPerMessage()` billed calls
-- (src/domain/billing/provider-budget.ts). Three is a number the free tier
-- can carry.
--
-- Business was the dangerous one. `ai_messages_per_day: null` did not mean
-- "a very high ceiling" — the enforcement site read it as `if (dailyLimit
-- !== null)`, so the tier skipped metering ENTIRELY. Nothing counted, and
-- nothing could have alerted. It is now a number like every other tier, and
-- the TypeScript field is no longer nullable, so "unlimited" cannot be
-- expressed for AI at all.
--
-- THREE NEW ENTITLEMENT KEYS
--
-- `advanced_tax_tools`, `bank_connections` and `priority_support` are added
-- so this table can express the same product definition the canonical model
-- does. None of the three is implemented; the pricing page reads
-- `FEATURE_IMPLEMENTED` and renders "Coming soon" rather than a checkmark,
-- so granting the entitlement here advertises nothing.
--
-- WHICH SOURCE IS CANONICAL
--
-- Still the TypeScript module. No enforcement path reads `entitlements` from
-- this table — `listPlans` renders a name and a price in Settings, and
-- nothing else. This row is kept in agreement because a contradicting copy is
-- worse than no copy: the next reader would have no way to know which one was
-- live. `tests/rls/plan-catalogue.test.ts` compares the two field by field,
-- so they cannot drift again silently.
--
-- Prices are unchanged: Free $0, Premium $19/mo, Business $49/mo. No payment
-- provider exists, so no organization is on a paid tier and nothing is
-- charged.

update plans
set
  name = 'Free',
  price_minor = 0,
  currency = 'USD',
  entitlements = '{
    "max_organizations": 1,
    "ai_assistant": true,
    "ai_messages_per_day": 3,
    "document_processing": false,
    "advanced_tax_tools": false,
    "bank_connections": false,
    "priority_support": false
  }'::jsonb
where id = 'free';

update plans
set
  name = 'Premium',
  price_minor = 1900,
  currency = 'USD',
  entitlements = '{
    "max_organizations": 3,
    "ai_assistant": true,
    "ai_messages_per_day": 100,
    "document_processing": true,
    "advanced_tax_tools": true,
    "bank_connections": true,
    "priority_support": false
  }'::jsonb
where id = 'premium';

update plans
set
  name = 'Business',
  price_minor = 4900,
  currency = 'USD',
  entitlements = '{
    "max_organizations": null,
    "ai_assistant": true,
    "ai_messages_per_day": 500,
    "document_processing": true,
    "advanced_tax_tools": true,
    "bank_connections": true,
    "priority_support": true
  }'::jsonb
where id = 'business';
