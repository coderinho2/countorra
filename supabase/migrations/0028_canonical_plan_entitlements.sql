-- Brings the `plans` table into agreement with the canonical entitlement
-- model in src/domain/billing/entitlements.ts.
--
-- WHY THIS ROW EVER DISAGREED
--
-- Entitlements were defined in four places: this table, `PLAN_ENTITLEMENTS`
-- in plans.ts, `PLAN_LIMITS` in limits.ts, and `FEATURE_FLAGS`. Only
-- `PLAN_LIMITS` was ever read by running code. The rest drifted freely, and
-- two of them said something false:
--
--   * `ai_accountant: false` on Free — which, had anything enforced it, would
--     have removed the assistant from the Free tier entirely, against a
--     public page advertising "20 AI messages per day" and against the
--     limiter that has been counting those 20 all along.
--   * `max_organizations: 1` on Free — true as an intention, but nothing
--     read it, so Free could create workspaces without limit.
--
-- WHICH SOURCE IS CANONICAL NOW
--
-- The TypeScript module is. It is typed, versioned with the code that
-- enforces it, and unit-tested; a jsonb blob is none of those. This table is
-- kept in agreement because a contradicting copy is worse than no copy — the
-- next reader would have no way to know which one was live — but no
-- enforcement path reads `entitlements` from here. `listPlans` is used only
-- to render a plan's name and price in Settings.
--
-- Keys are renamed to match the canonical field names (`ai_assistant`,
-- `ai_messages_per_day`) so the two can be compared by eye. Nothing reads the
-- old key names; verified by grep before writing this.
--
-- PRICES
--
-- Premium and Business get real prices ($19 and $49/month) for the first
-- time; they were null because pricing was undecided. This does NOT publish
-- them: the public pricing page renders a hardcoded list and still says
-- "Billing not yet available", and no organization is on a paid tier because
-- no payment provider exists. Settings reads `price_minor`, so an
-- organization moved to a paid tier before Stripe is wired up would display a
-- price it is not being charged — which is a reason to not flip tiers by
-- hand, not a reason to leave the catalogue wrong.

update plans
set
  name = 'Free',
  price_minor = 0,
  currency = 'USD',
  entitlements = '{
    "max_organizations": 1,
    "ai_assistant": true,
    "ai_messages_per_day": 20,
    "document_processing": false
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
    "ai_messages_per_day": 300,
    "document_processing": true
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
    "ai_messages_per_day": null,
    "document_processing": true
  }'::jsonb
where id = 'business';
