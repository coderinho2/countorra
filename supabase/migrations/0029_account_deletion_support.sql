-- DATA-01. Makes account deletion possible without destroying other people's
-- data, and without a cascade that would.
--
-- WHAT WAS BLOCKING IT
--
-- Eleven foreign keys referenced `auth.users` with no ON DELETE action, so
-- deleting a user raised a constraint violation. The audit in
-- tests/rls/deletion-graph.test.ts proved the shape of the problem: the user
-- became deletable only after their organizations were deleted, and deleting
-- an organization destroys every OTHER member's data with it. "Delete my
-- account" therefore had no safe implementation at all.
--
-- THE DISTINCTION THIS MIGRATION DRAWS
--
-- Two kinds of column reference a user, and they need opposite treatment:
--
--   ATTRIBUTION — "who did this": created_by, uploaded_by, confirmed_by,
--   closed_by, invited_by, and the recipient on notifications/usage rows.
--   The RECORD belongs to the organization and must survive; only the name
--   attached to it is personal. These become ON DELETE SET NULL, which is
--   also what erasure requires: the transaction stays on the books, the
--   person is no longer identified by it.
--
--   OWNERSHIP — `ai_conversations.user_id`. A conversation is not an
--   organization record with a name attached; it IS the person's data, and it
--   stays NOT NULL. The deletion flow removes those rows explicitly
--   (src/server/account/actions.ts) rather than orphaning them, so a
--   conversation is never left pointing at nobody.
--
-- `organizations.created_by` additionally drops NOT NULL. It was the hardest
-- blocker: a user who founded an organization and then transferred it away
-- was still permanently undeletable, because the historical "who created
-- this" could not be cleared.
--
-- WHAT THIS DOES NOT DO
--
-- It adds no cascade to `auth.users` that would delete financial records. No
-- organization, transaction, invoice or document is removed by any rule here.
-- Deletion of an organization stays an explicit, authorized decision made in
-- application code, where it can check for other members first.
--
-- RLS is unchanged. `organizations_insert_self` still requires
-- `created_by = auth.uid()`, so a nullable column cannot be used to create an
-- unattributed organization — null fails that check.

-- ── organizations.created_by: nullable + detach on user deletion ─────────
alter table organizations alter column created_by drop not null;

alter table organizations drop constraint organizations_created_by_fkey;
alter table organizations
  add constraint organizations_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete set null;

-- ── Attribution columns: detach, never delete the record ────────────────
alter table transactions drop constraint transactions_created_by_fkey;
alter table transactions
  add constraint transactions_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete set null;

alter table invoices drop constraint invoices_created_by_fkey;
alter table invoices
  add constraint invoices_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete set null;

alter table documents drop constraint documents_uploaded_by_fkey;
alter table documents
  add constraint documents_uploaded_by_fkey
  foreign key (uploaded_by) references auth.users (id) on delete set null;

alter table document_extracted_data drop constraint document_extracted_data_confirmed_by_fkey;
alter table document_extracted_data
  add constraint document_extracted_data_confirmed_by_fkey
  foreign key (confirmed_by) references auth.users (id) on delete set null;

alter table accounting_periods drop constraint accounting_periods_closed_by_fkey;
alter table accounting_periods
  add constraint accounting_periods_closed_by_fkey
  foreign key (closed_by) references auth.users (id) on delete set null;

alter table memberships drop constraint memberships_invited_by_fkey;
alter table memberships
  add constraint memberships_invited_by_fkey
  foreign key (invited_by) references auth.users (id) on delete set null;

-- `ai_actions.confirmed_by` is attribution on a record the organization keeps.
-- The 0008 check constraint requires it to be non-null only for a
-- confirmed/executed WRITE or DELETE action, and it is `not valid`-free, so
-- nulling it on an executed row would violate that. Detaching is therefore
-- done by the deletion flow, which rewrites the row's attribution rather than
-- relying on the constraint — see the note in src/server/account/actions.ts.

alter table notifications drop constraint notifications_user_id_fkey;
alter table notifications
  add constraint notifications_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade;

alter table ai_usage drop constraint ai_usage_user_id_fkey;
alter table ai_usage
  add constraint ai_usage_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete set null;
