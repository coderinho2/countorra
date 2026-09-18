-- Additive extension of `transactions` (Phase 2, DESIGN brief-adjacent
-- product spec §9: reviewed/unreviewed, AI-categorized vs manually
-- categorized). Preserves the Phase 1 table rather than replacing it —
-- new nullable/defaulted columns only, so every existing row and every
-- Phase 1 query against `transactions` keeps working unchanged.

alter table transactions
  add column is_reviewed boolean not null default false,
  add column categorized_by text check (categorized_by in ('user', 'ai', 'system')),
  add column category_confidence numeric(4, 3) check (category_confidence is null or (category_confidence >= 0 and category_confidence <= 1));

create index transactions_is_reviewed_idx on transactions (organization_id, is_reviewed) where is_reviewed = false;
