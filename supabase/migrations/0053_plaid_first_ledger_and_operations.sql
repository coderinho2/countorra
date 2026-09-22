-- Plaid-first ledger, and an operational-reporting foundation.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
--
-- Countorra's accounts and transactions are meant to come from the bank:
--
--   Plaid → institution (bank_connections) → provider account
--   (bank_linked_accounts) → Countorra account (accounts) → provider
--   transaction (bank_external_transactions) → Countorra transaction
--   (transactions, source 'bank_sync')
--
-- That pipeline already exists (0047–0049). What did not exist was anything
-- stopping a person from typing a "bank account" and its transactions in by
-- hand — a balance that looks bank-sourced and is not. The application now
-- only offers hand entry for cash and wallets; this migration makes the
-- database hold the same line for browser sessions, which can write through
-- the Data API directly and would otherwise route around the application.
--
-- ── WHAT CHANGES ───────────────────────────────────────────────────────────
--
-- 1. accounts: a browser session (roles anon/authenticated) can create, or
--    change an account into, only kind 'cash' or 'wallet'. Bank, credit card
--    and other accounts are created by the system — the bank-connection
--    import in the next phase, running as the service role. Existing
--    accounts of every kind are untouched and stay fully usable.
--
-- 2. transactions: a browser session can write a transaction (inserting it,
--    or moving it between accounts) only against cash or wallet accounts that
--    no bank connection feeds — for the account and, on a transfer, for the
--    other side as well. Rows written by the bank sync ('bank_sync', created
--    by the service role inside the ingest functions) are unaffected, as is
--    every existing transaction: editing a category, memo, review state or
--    amount on any transaction works exactly as before.
--
--    A "connected" account is one an active bank link imports into:
--    bank_linked_accounts.account_id with import_mode 'IMPORT' and no
--    detached_at. The same definition the link function uses.
--
-- 3. operations_summary(): counts, and only counts, of operational events —
--    webhooks, sync jobs, connection health, email delivery, security events,
--    AI usage and failed AI actions — over a window. EXECUTE is granted to
--    the service role alone; it returns no identifiers, amounts, names or
--    text, and it is called only by the token-protected operations endpoint.
--
-- 4. operations_schema_version(): the number of the latest migration that
--    installed it, so the readiness check can say "the database is behind
--    the code" — the manual-migration failure mode this project has.
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
--
--   * Nothing is deleted, rewritten or reclassified. Hand-entered bank
--     accounts and their history remain, and remain editable. They can be
--     connected to a bank through the existing link flow, which matches
--     existing entries rather than duplicating them.
--   * No new account columns: every field a connected account needs
--     (institution, provider ids, type/subtype, mask, balances, balance time,
--     connection status, last sync and attempt, failure category) is already
--     on bank_connections / bank_linked_accounts.
--
-- ── REVERSAL ───────────────────────────────────────────────────────────────
--
--   drop trigger if exists accounts_manual_kind_guard on accounts;
--   drop function if exists accounts_manual_kind_guard();
--   drop trigger if exists transactions_manual_entry_guard on transactions;
--   drop function if exists transactions_manual_entry_guard();
--   drop function if exists account_accepts_manual_entry(uuid);
--   drop function if exists operations_summary(timestamptz);
--   drop function if exists operations_schema_version();

-- ── 1. Accounts ────────────────────────────────────────────────────────────

create or replace function accounts_manual_kind_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if new.kind not in ('cash', 'wallet')
     and (tg_op = 'INSERT' or new.kind is distinct from old.kind) then
    raise exception 'bank, credit card and other accounts come from a bank connection; only cash and wallet accounts can be added by hand'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists accounts_manual_kind_guard on accounts;
create trigger accounts_manual_kind_guard
  before insert or update of kind on accounts
  for each row execute function accounts_manual_kind_guard();

-- ── 2. Transactions ────────────────────────────────────────────────────────

create or replace function account_accepts_manual_entry(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from accounts a
     where a.id = p_account_id
       -- Only answers about the caller's own accounts: security definer must
       -- not become a way to probe another workspace's account ids.
       and (auth.uid() is null or is_org_member(a.organization_id))
       and a.kind in ('cash', 'wallet')
       and not exists (
         select 1 from bank_linked_accounts l
          where l.account_id = a.id and l.import_mode = 'IMPORT' and l.detached_at is null
       )
  );
$$;

comment on function account_accepts_manual_entry(uuid) is
  'True when a person may enter transactions by hand into this account: a cash or wallet account no bank connection imports into. Security definer so the check sees bank links regardless of the caller; it answers only for accounts in a workspace the caller belongs to.';

revoke execute on function account_accepts_manual_entry(uuid) from public, anon;
grant execute on function account_accepts_manual_entry(uuid) to authenticated;

create or replace function transactions_manual_entry_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated') or new.source = 'bank_sync' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.account_id is not distinct from old.account_id
     and new.transfer_account_id is not distinct from old.transfer_account_id then
    return new;
  end if;
  if not account_accepts_manual_entry(new.account_id)
     or (new.transfer_account_id is not null and not account_accepts_manual_entry(new.transfer_account_id)) then
    raise exception 'transactions for bank-connected, bank, credit card and other accounts come from the bank; only cash and wallet transactions can be entered by hand'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists transactions_manual_entry_guard on transactions;
create trigger transactions_manual_entry_guard
  before insert or update of account_id, transfer_account_id on transactions
  for each row execute function transactions_manual_entry_guard();

-- ── 3. Operational reporting ───────────────────────────────────────────────

create or replace function operations_summary(p_since timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'since', p_since,
    'generatedAt', now(),
    'stripeWebhooks', coalesce((select jsonb_object_agg(coalesce(outcome, 'pending'), n) from (select outcome, count(*) n from stripe_webhook_events where received_at >= p_since group by outcome) s), '{}'::jsonb),
    'bankWebhooks', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from bank_webhook_events where received_at >= p_since group by status) s), '{}'::jsonb),
    'bankSyncJobsActive', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from bank_sync_jobs where status in ('QUEUED', 'RUNNING', 'RETRYABLE') group by status) s), '{}'::jsonb),
    'bankSyncRuns', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from bank_sync_runs where started_at >= p_since group by status) s), '{}'::jsonb),
    'bankConnections', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from bank_connections group by status) s), '{}'::jsonb),
    'emails', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from email_messages where created_at >= p_since group by status) s), '{}'::jsonb),
    'securityEvents', coalesce((select jsonb_object_agg(severity, n) from (select severity, count(*) n from security_events where created_at >= p_since group by severity) s), '{}'::jsonb),
    'aiRequests', (select count(*) from ai_usage where created_at >= p_since),
    'aiActions', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from ai_actions where created_at >= p_since group by status) s), '{}'::jsonb)
  );
$$;

comment on function operations_summary(timestamptz) is
  'Internal operational counts since a point in time. Counts only — no identifiers, amounts or text. Service role only; read by the token-protected /api/operations/summary.';

create or replace function operations_schema_version()
returns text
language sql
immutable
as $$ select '0053'::text $$;

comment on function operations_schema_version() is
  'The latest migration that (re)defined this function. Compared with the version the application expects, so a deployment ahead of its database is visible.';

revoke execute on function operations_summary(timestamptz) from public, anon, authenticated;
revoke execute on function operations_schema_version() from public, anon, authenticated;
grant execute on function operations_summary(timestamptz) to service_role;
grant execute on function operations_schema_version() to service_role;
