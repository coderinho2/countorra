-- Stripe's subscription lifecycle has states the local enum could not express.
--
-- `subscription_status` (0001) was written before any payment provider existed
-- and covered five states: active, trialing, past_due, canceled, incomplete.
-- Stripe emits three more, and a webhook carrying one of them would have
-- failed the enum cast and been retried forever rather than recorded:
--
--   unpaid             — every retry on the final invoice failed; Stripe has
--                        stopped trying and left the subscription in place.
--   incomplete_expired — the first payment was never completed within 23h, so
--                        the subscription never actually started.
--   paused             — a trial ended with no payment method, under a
--                        `pause_collection` setting. Not used by this product
--                        today, but Stripe can emit it and an unknown value
--                        is worse than an unused one.
--
-- ADDING THESE GRANTS NOTHING.
--
-- Entitlement is decided by `ENTITLED_STATUSES` in
-- src/domain/billing/entitlements.ts, which is `{active, trialing}` and is NOT
-- touched here. Every state added below therefore resolves to Free — the same
-- as `past_due` and `canceled` already do. This migration lets the system
-- RECORD what Stripe says; it does not change what any state is worth.
--
-- Separate from 0035 because Postgres will not let a transaction use an enum
-- value it added in that same transaction, and the CLI runs one file per
-- transaction.

alter type subscription_status add value if not exists 'unpaid';
alter type subscription_status add value if not exists 'incomplete_expired';
alter type subscription_status add value if not exists 'paused';
