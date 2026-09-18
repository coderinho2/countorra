-- Security/integrity fix, found during review, not a feature addition.
--
-- Every RLS policy in this schema checks `organization_id` on the row
-- being accessed — but nothing previously stopped a row from pointing to
-- a *different* organization's data through a foreign key. Concretely:
-- `transactions.account_id` only required "some row in `accounts`
-- exists", not "an `accounts` row in the *same* `organization_id` as this
-- transaction". A transaction could reference another organization's
-- account/category/merchant, or an invoice another organization's
-- customer, without any constraint noticing.
--
-- This matters more than it might for an ordinary CRUD app because of the
-- AI write path (src/domain/ai/tools/registry.ts): `createDraftTransaction`
-- inserts `account_id` chosen by the model. Under normal operation the
-- model only ever sees same-org account IDs (via `getAccounts`), but
-- nothing at the database layer enforced that — a confused model, or
-- untrusted content that happened to contain a stray UUID (product spec
-- §36: documents/descriptions are data, not instructions, but a
-- coincidental foreign UUID slipping through client-side JSON-schema
-- validation and reaching the insert was a genuine gap regardless).
--
-- Fixed with Postgres's standard technique for this exact problem:
-- composite foreign keys. A `unique (id, organization_id)` on each parent
-- table (redundant with the primary key on `id` alone, but required for a
-- composite FK to reference it) lets the child table's FK be
-- `(local_id, organization_id) references parent (id, organization_id)`
-- instead of just `(local_id) references parent (id)` — Postgres then
-- enforces the tenant match natively, for every insert/update path, not
-- just application code that remembers to check.
--
-- Nullable FK columns (category_id, merchant_id, transfer_account_id,
-- ai_actions.conversation_id, transaction_categories.parent_category_id)
-- keep working exactly as before: Postgres's default FK MATCH semantics
-- skip the check entirely when any referencing column is NULL.

-- ── accounts ─────────────────────────────────────────────────────────────
alter table accounts add constraint accounts_id_org_unique unique (id, organization_id);

alter table transactions drop constraint transactions_account_id_fkey;
alter table transactions
  add constraint transactions_account_id_fkey
  foreign key (account_id, organization_id) references accounts (id, organization_id) on delete restrict;

alter table transactions drop constraint transactions_transfer_account_id_fkey;
alter table transactions
  add constraint transactions_transfer_account_id_fkey
  foreign key (transfer_account_id, organization_id) references accounts (id, organization_id) on delete restrict;

-- ── transaction_categories ───────────────────────────────────────────────
alter table transaction_categories add constraint transaction_categories_id_org_unique unique (id, organization_id);

alter table transaction_categories drop constraint transaction_categories_parent_category_id_fkey;
alter table transaction_categories
  add constraint transaction_categories_parent_category_id_fkey
  foreign key (parent_category_id, organization_id) references transaction_categories (id, organization_id) on delete set null;

alter table transactions drop constraint transactions_category_id_fkey;
alter table transactions
  add constraint transactions_category_id_fkey
  foreign key (category_id, organization_id) references transaction_categories (id, organization_id) on delete set null;

-- ── merchants ────────────────────────────────────────────────────────────
alter table merchants add constraint merchants_id_org_unique unique (id, organization_id);

alter table transactions drop constraint transactions_merchant_id_fkey;
alter table transactions
  add constraint transactions_merchant_id_fkey
  foreign key (merchant_id, organization_id) references merchants (id, organization_id) on delete set null;

-- ── customers ────────────────────────────────────────────────────────────
alter table customers add constraint customers_id_org_unique unique (id, organization_id);

alter table invoices drop constraint invoices_customer_id_fkey;
alter table invoices
  add constraint invoices_customer_id_fkey
  foreign key (customer_id, organization_id) references customers (id, organization_id) on delete restrict;

-- ── ai_conversations ─────────────────────────────────────────────────────
alter table ai_conversations add constraint ai_conversations_id_org_unique unique (id, organization_id);

alter table ai_actions drop constraint ai_actions_conversation_id_fkey;
alter table ai_actions
  add constraint ai_actions_conversation_id_fkey
  foreign key (conversation_id, organization_id) references ai_conversations (id, organization_id) on delete set null;
