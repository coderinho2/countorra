-- Row Level Security. Mandatory tenant isolation (DESIGN brief §9).
--
-- Every table below has RLS enabled with NO policy for operations that
-- aren't explicitly granted — Postgres RLS defaults to deny, so anything
-- not covered here is unreachable from the `anon`/`authenticated` roles,
-- not just unreachable "by convention". Two roles-based tiers are used
-- consistently across financial data (mirrored exactly in
-- src/domain/organizations/permissions.ts — keep the two in sync):
--   - read: any member, including 'viewer'
--   - write (insert/update): 'owner' | 'admin' | 'accountant' | 'manager' | 'employee'
--   - delete: 'owner' | 'admin' | 'accountant'  (destructive actions get a smaller circle)

-- ── profiles ─────────────────────────────────────────────────────────────
alter table profiles enable row level security;

create policy profiles_select_own on profiles
  for select using (id = auth.uid());

create policy profiles_update_own on profiles
  for update using (id = auth.uid());

-- ── organizations ────────────────────────────────────────────────────────
alter table organizations enable row level security;

-- `or created_by = auth.uid()` matters, not just as a convenience: the
-- owner's membership row is created by an AFTER INSERT trigger
-- (bootstrap_new_organization, 0012), which runs after Postgres evaluates
-- this SELECT policy for `INSERT ... RETURNING`'s visibility check. Without
-- this clause, the very first `insert into organizations(...) returning *`
-- a new user makes — how every org gets created — fails RLS, because at
-- that instant `is_org_member(id)` is still false. Confirmed by
-- tests/rls/tenant-isolation.test.ts, which failed until this was added.
create policy organizations_select_member on organizations
  for select using (is_org_member(id) or created_by = auth.uid());

create policy organizations_insert_self on organizations
  for insert with check (created_by = auth.uid());

create policy organizations_update_admin on organizations
  for update using (is_org_role(id, array['owner', 'admin']::org_role[]));

create policy organizations_delete_owner on organizations
  for delete using (is_org_role(id, array['owner']::org_role[]));

-- ── memberships ──────────────────────────────────────────────────────────
alter table memberships enable row level security;

create policy memberships_select_member on memberships
  for select using (is_org_member(organization_id));

create policy memberships_insert_admin on memberships
  for insert with check (is_org_role(organization_id, array['owner', 'admin']::org_role[]));

-- A member can never change their OWN role — only another owner/admin can.
-- This is the specific guard against the self-escalation risk called out
-- in DESIGN brief §9 ("change their own role to owner/admin").
create policy memberships_update_admin_not_self on memberships
  for update using (
    is_org_role(organization_id, array['owner', 'admin']::org_role[])
    and user_id <> auth.uid()
  );

create policy memberships_delete_admin_not_self on memberships
  for delete using (
    is_org_role(organization_id, array['owner', 'admin']::org_role[])
    and user_id <> auth.uid()
  );

-- ── accounts ─────────────────────────────────────────────────────────────
alter table accounts enable row level security;

create policy accounts_select_member on accounts
  for select using (is_org_member(organization_id));

create policy accounts_write_member on accounts
  for insert with check (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy accounts_update_member on accounts
  for update using (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy accounts_delete_privileged on accounts
  for delete using (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

-- ── transaction_categories ───────────────────────────────────────────────
alter table transaction_categories enable row level security;

create policy transaction_categories_select_member on transaction_categories
  for select using (is_org_member(organization_id));

create policy transaction_categories_insert_member on transaction_categories
  for insert with check (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy transaction_categories_update_member on transaction_categories
  for update using (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy transaction_categories_delete_privileged on transaction_categories
  for delete using (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

-- ── merchants ────────────────────────────────────────────────────────────
alter table merchants enable row level security;

create policy merchants_select_member on merchants
  for select using (is_org_member(organization_id));

create policy merchants_insert_member on merchants
  for insert with check (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy merchants_update_member on merchants
  for update using (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy merchants_delete_privileged on merchants
  for delete using (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

-- ── transactions ─────────────────────────────────────────────────────────
alter table transactions enable row level security;

create policy transactions_select_member on transactions
  for select using (is_org_member(organization_id));

create policy transactions_insert_member on transactions
  for insert with check (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy transactions_update_member on transactions
  for update using (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy transactions_delete_privileged on transactions
  for delete using (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

-- ── accounting_periods ───────────────────────────────────────────────────
alter table accounting_periods enable row level security;

create policy accounting_periods_select_member on accounting_periods
  for select using (is_org_member(organization_id));

create policy accounting_periods_write_privileged on accounting_periods
  for insert with check (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

create policy accounting_periods_update_privileged on accounting_periods
  for update using (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

create policy accounting_periods_delete_privileged on accounting_periods
  for delete using (is_org_role(organization_id, array['owner', 'admin']::org_role[]));

-- ── tax_configurations ───────────────────────────────────────────────────
alter table tax_configurations enable row level security;

create policy tax_configurations_select_member on tax_configurations
  for select using (is_org_member(organization_id));

create policy tax_configurations_write_privileged on tax_configurations
  for insert with check (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

create policy tax_configurations_update_privileged on tax_configurations
  for update using (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

create policy tax_configurations_delete_privileged on tax_configurations
  for delete using (is_org_role(organization_id, array['owner', 'admin']::org_role[]));

-- ── vat_configurations ───────────────────────────────────────────────────
alter table vat_configurations enable row level security;

create policy vat_configurations_select_member on vat_configurations
  for select using (is_org_member(organization_id));

create policy vat_configurations_write_privileged on vat_configurations
  for insert with check (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

create policy vat_configurations_update_privileged on vat_configurations
  for update using (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

create policy vat_configurations_delete_privileged on vat_configurations
  for delete using (is_org_role(organization_id, array['owner', 'admin']::org_role[]));

-- ── documents ────────────────────────────────────────────────────────────
alter table documents enable row level security;

create policy documents_select_member on documents
  for select using (is_org_member(organization_id));

create policy documents_insert_member on documents
  for insert with check (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy documents_update_member on documents
  for update using (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy documents_delete_privileged on documents
  for delete using (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

-- ── document_processing_jobs / document_extracted_data / document_relationships ──
alter table document_processing_jobs enable row level security;

create policy document_processing_jobs_select_member on document_processing_jobs
  for select using (is_org_member(org_id_of_document(document_id)));

create policy document_processing_jobs_write_member on document_processing_jobs
  for insert with check (is_org_role(org_id_of_document(document_id), array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy document_processing_jobs_update_member on document_processing_jobs
  for update using (is_org_role(org_id_of_document(document_id), array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

alter table document_extracted_data enable row level security;

create policy document_extracted_data_select_member on document_extracted_data
  for select using (is_org_member(org_id_of_document(document_id)));

create policy document_extracted_data_write_member on document_extracted_data
  for insert with check (is_org_role(org_id_of_document(document_id), array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy document_extracted_data_update_member on document_extracted_data
  for update using (is_org_role(org_id_of_document(document_id), array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

alter table document_relationships enable row level security;

create policy document_relationships_select_member on document_relationships
  for select using (is_org_member(org_id_of_document(document_id)));

create policy document_relationships_write_member on document_relationships
  for insert with check (is_org_role(org_id_of_document(document_id), array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy document_relationships_delete_member on document_relationships
  for delete using (is_org_role(org_id_of_document(document_id), array['owner', 'admin', 'accountant']::org_role[]));

-- ── customers ────────────────────────────────────────────────────────────
alter table customers enable row level security;

create policy customers_select_member on customers
  for select using (is_org_member(organization_id));

create policy customers_insert_member on customers
  for insert with check (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy customers_update_member on customers
  for update using (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy customers_delete_privileged on customers
  for delete using (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

-- ── invoices ─────────────────────────────────────────────────────────────
alter table invoices enable row level security;

create policy invoices_select_member on invoices
  for select using (is_org_member(organization_id));

create policy invoices_insert_member on invoices
  for insert with check (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy invoices_update_member on invoices
  for update using (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy invoices_delete_privileged on invoices
  for delete using (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

-- ── invoice_line_items ───────────────────────────────────────────────────
alter table invoice_line_items enable row level security;

create policy invoice_line_items_select_member on invoice_line_items
  for select using (is_org_member(org_id_of_invoice(invoice_id)));

create policy invoice_line_items_write_member on invoice_line_items
  for insert with check (is_org_role(org_id_of_invoice(invoice_id), array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy invoice_line_items_update_member on invoice_line_items
  for update using (is_org_role(org_id_of_invoice(invoice_id), array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy invoice_line_items_delete_member on invoice_line_items
  for delete using (is_org_role(org_id_of_invoice(invoice_id), array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

-- ── ai_conversations / ai_messages ───────────────────────────────────────
alter table ai_conversations enable row level security;

create policy ai_conversations_select_member on ai_conversations
  for select using (is_org_member(organization_id));

create policy ai_conversations_insert_member on ai_conversations
  for insert with check (is_org_member(organization_id) and user_id = auth.uid());

create policy ai_conversations_update_own on ai_conversations
  for update using (is_org_member(organization_id) and user_id = auth.uid());

alter table ai_messages enable row level security;

create policy ai_messages_select_member on ai_messages
  for select using (is_org_member(org_id_of_conversation(conversation_id)));

create policy ai_messages_insert_member on ai_messages
  for insert with check (is_org_member(org_id_of_conversation(conversation_id)));

-- ── ai_usage / ai_insights ───────────────────────────────────────────────
alter table ai_usage enable row level security;

create policy ai_usage_select_member on ai_usage
  for select using (is_org_member(organization_id));

alter table ai_insights enable row level security;

create policy ai_insights_select_member on ai_insights
  for select using (is_org_member(organization_id));

create policy ai_insights_update_member on ai_insights
  for update using (is_org_member(organization_id));

-- ── ai_actions ───────────────────────────────────────────────────────────
-- Insert: any member can ask the AI to propose an action. Update: only
-- write-capable roles may confirm/reject a pending WRITE/DELETE action —
-- this is the row-level enforcement behind DESIGN brief §14's requirement
-- that AI actions be explicitly authorized by a human before executing.
alter table ai_actions enable row level security;

create policy ai_actions_select_member on ai_actions
  for select using (is_org_member(organization_id));

create policy ai_actions_insert_member on ai_actions
  for insert with check (is_org_member(organization_id));

create policy ai_actions_update_privileged on ai_actions
  for update using (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager']::org_role[]));

-- ── audit_logs / security_events ────────────────────────────────────────
-- No insert/update/delete policy for `authenticated` at all: writes only
-- happen through record_audit_event() (SECURITY DEFINER, bypasses RLS by
-- design) or the no-op-rejecting triggers in 0009_audit.sql. Only
-- owner/admin can read an organization's trail.
alter table audit_logs enable row level security;

create policy audit_logs_select_privileged on audit_logs
  for select using (
    organization_id is not null and is_org_role(organization_id, array['owner', 'admin']::org_role[])
  );

alter table security_events enable row level security;

create policy security_events_select_privileged on security_events
  for select using (
    organization_id is not null and is_org_role(organization_id, array['owner', 'admin']::org_role[])
  );

-- ── plans / subscriptions ────────────────────────────────────────────────
alter table plans enable row level security;

create policy plans_select_all on plans
  for select using (true);

-- No insert/update/delete/select-write policy for `authenticated` on
-- subscriptions: a client must never be able to set its own plan_id
-- ("if premium" tampering). Reads are the only client-facing operation;
-- writes happen through the org-bootstrap trigger (initial 'free' row) and,
-- later, a service-role billing webhook.
alter table subscriptions enable row level security;

create policy subscriptions_select_member on subscriptions
  for select using (is_org_member(organization_id));
