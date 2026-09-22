-- Plaid production: automatic account import, balance reconciliation, and
-- provider-controlled fields on bank-imported transactions.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
--
-- Until now a bank account reported by Plaid (bank_linked_accounts) reached
-- the ledger only after a person mapped it onto an EXISTING Countorra account.
-- Since 0053 a person can no longer create bank or credit card accounts, so a
-- new connection had nowhere correct to go. This migration makes the chain
--
--   Plaid Item → Plaid account → Countorra account → Plaid transactions →
--   Countorra transactions
--
-- automatic, inside the sync, run by the service role:
--
-- 1. bank_import_account_kind(type, subtype) — the ONE mapping from a Plaid
--    account to a Countorra account kind. Only what is certain is mapped:
--
--      DEPOSITORY / checking     → bank
--      DEPOSITORY / savings      → bank
--      CREDIT     / credit_card  → credit_card   (subtypes are stored normalized:
--                                                 lowercase, underscores)
--
--    Everything else (loans, investments, money market, CDs, HSAs, prepaid,
--    PayPal, an unknown subtype) returns NULL: it is NOT imported, stays
--    visible on the Bank connections page as "not supported yet", and cannot
--    be mapped onto an account by hand either (the application refuses it).
--    The mirror in the application is
--    src/domain/bank-connections/account-import.ts; tests assert they agree.
--
-- 2. bank_import_linked_account(org, linked account, actor) creates the
--    Countorra account for one reported bank account (named as the bank
--    names it) and links it for import through the existing
--    bank_link_account, so the same guards, reconciliation flags and history
--    rules apply. Marked ledger_account_created_by_import.
--
--    bank_auto_import_accounts(org, connection) runs it, inside the sync, for
--    every supported account still AWAITING_DECISION — except where the
--    workspace already has an unconnected account of that kind and currency
--    kept by hand. There the person chooses: continue that account (the
--    existing link flow, which matches their entries instead of importing
--    duplicates) or import as a new one. Idempotent: an account already
--    linked, ignored or detached is never touched; a second sync creates
--    nothing.
--
-- 3. bank_anchor_account_balances(org, connection) — the balance model for
--    accounts Countorra created from the bank. Plaid's current balance is the
--    authority for what the account holds; the ledger's transactions are the
--    authority for what happened. The opening balance is the one number that
--    joins them:
--
--      opening_balance = bank current balance − Σ(ledger movements)
--
--    so that opening + income − expenses (+ transfers) equals the bank's
--    current balance exactly. It is recomputed at the end of a complete sync
--    (no page left, no posted transaction still waiting to reach the
--    ledger), which makes it self-correcting when Plaid delivers older
--    history later: the history lands, the opening shrinks by the same
--    amount, the balance stays the bank's. It is never a transaction, never
--    touches transaction rows, and applies ONLY to accounts Countorra created
--    from the bank — never to an account a person kept by hand and then
--    connected, whose books remain theirs.
--
-- 4. transactions_bank_provider_fields_guard — on a transaction the bank sync
--    wrote, the provider's facts are the provider's: a browser session can no
--    longer change its amount, date, direction, currency or account, or
--    delete it (the next sync would otherwise disagree with the books, and
--    the balance model above would silently absorb the difference). What
--    Countorra adds stays editable: category, merchant, memo, the name shown,
--    review state. The sync itself (service role) still applies Plaid's
--    modifications and removals.
--
-- 5. operations_schema_version() → '0054'.
--
-- ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
--
--   Nothing existing is deleted or rewritten. Accounts already linked by hand
--   keep their opening balances. Existing bank-imported transactions are
--   unchanged; only who may change their provider fields changes.
--
-- ── REVERSAL ───────────────────────────────────────────────────────────────
--
--   drop trigger if exists transactions_bank_provider_fields_guard on transactions;
--   drop function if exists transactions_bank_provider_fields_guard();
--   drop function if exists bank_anchor_account_balances(uuid, uuid);
--   drop function if exists bank_auto_import_accounts(uuid, uuid);
--   drop function if exists bank_import_linked_account(uuid, uuid, uuid);
--   drop function if exists bank_import_account_kind(text, text);
--   alter table bank_linked_accounts drop column if exists ledger_account_created_by_import;
--   create or replace function operations_schema_version() returns text language sql immutable as $$ select '0053'::text $$;

-- ── 1. Mapping ─────────────────────────────────────────────────────────────

alter table bank_linked_accounts
  add column if not exists ledger_account_created_by_import boolean not null default false;

comment on column bank_linked_accounts.ledger_account_created_by_import is
  'True when Countorra created the ledger account from this bank account (0054). Only such accounts have their opening balance anchored to the bank''s current balance.';

create or replace function bank_import_account_kind(p_type text, p_subtype text)
returns text
language sql
immutable
as $$
  select case
    when p_type = 'DEPOSITORY' and p_subtype in ('checking', 'savings') then 'bank'
    when p_type = 'CREDIT' and p_subtype = 'credit_card' then 'credit_card'
    else null
  end;
$$;

comment on function bank_import_account_kind(text, text) is
  'The Countorra account kind a Plaid account is imported as, or null when that kind of account is not supported yet. Mirrored by src/domain/bank-connections/account-import.ts.';

-- ── 2. Account import ─────────────────────────────────────────────────────

-- Creates the Countorra account for ONE reported bank account and links it
-- for import, through the existing bank_link_account so the same guards,
-- reconciliation flags and history rules apply. Used by the automatic import
-- below and by a person choosing "import as a new account".
create or replace function bank_import_linked_account(p_organization_id uuid, p_linked_account_id uuid, p_actor uuid)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_link bank_linked_accounts%rowtype;
  v_status text;
  v_kind text;
  v_account_id uuid;
  v_outcome text;
begin
  select * into v_link from bank_linked_accounts where id = p_linked_account_id and organization_id = p_organization_id for update;
  if v_link.id is null then
    return 'NOT_FOUND';
  end if;
  select status into v_status from bank_connections where id = v_link.connection_id and organization_id = p_organization_id;
  if v_link.detached_at is not null or v_status is null or v_status = 'DISCONNECTED' then
    return 'DETACHED';
  end if;
  -- Awaiting a decision, or set aside with "don't import" and now wanted after all.
  if v_link.account_id is not null or v_link.import_mode = 'IMPORT' then
    return 'ALREADY_DECIDED';
  end if;
  if v_link.currency is null then
    return 'CURRENCY_UNKNOWN';
  end if;
  v_kind := bank_import_account_kind(v_link.account_type, v_link.account_subtype);
  if v_kind is null then
    return 'UNSUPPORTED_ACCOUNT_TYPE';
  end if;

  insert into accounts (organization_id, name, kind, currency, opening_balance_minor)
  values (p_organization_id, v_link.display_name, v_kind, v_link.currency, 0)
  returning id into v_account_id;

  v_outcome := bank_link_account(p_organization_id, v_link.id, v_account_id, 'IMPORT', p_actor);
  if v_outcome <> 'APPLIED' then
    raise exception 'importing the account could not link it (%)', v_outcome using errcode = 'check_violation';
  end if;
  update bank_linked_accounts set ledger_account_created_by_import = true where id = v_link.id;
  return 'APPLIED';
end;
$$;

-- Imports, without asking, every supported account the bank reported that is
-- still awaiting a decision — UNLESS the workspace already has an account of
-- that kind and currency a person kept by hand and has not connected. That
-- person may be about to continue it: importing a second copy of the same
-- bank account would count its history twice. Those wait for the choice
-- ("continue my account" or "import as a new account"). Idempotent: nothing
-- already linked, ignored or detached is touched.
create or replace function bank_auto_import_accounts(p_organization_id uuid, p_connection_id uuid)
returns int
language plpgsql
set search_path = public
as $$
declare
  v_link record;
  v_created int := 0;
begin
  for v_link in
    select l.id
      from bank_linked_accounts l
     where l.organization_id = p_organization_id
       and l.connection_id = p_connection_id
       and l.detached_at is null
       and l.import_mode = 'AWAITING_DECISION'
       and l.account_id is null
       and l.currency is not null
       and bank_import_account_kind(l.account_type, l.account_subtype) is not null
       and not exists (
         select 1 from accounts a
          where a.organization_id = p_organization_id
            and a.kind = bank_import_account_kind(l.account_type, l.account_subtype)
            and a.currency = l.currency
            and not a.is_archived
            and not exists (
              select 1 from bank_linked_accounts o
               where o.account_id = a.id and o.import_mode = 'IMPORT' and o.detached_at is null
            )
       )
     order by l.created_at, l.id
  loop
    if bank_import_linked_account(p_organization_id, v_link.id, null) = 'APPLIED' then
      v_created := v_created + 1;
    end if;
  end loop;
  return v_created;
end;
$$;

-- ── 3. Balance anchoring ───────────────────────────────────────────────────

create or replace function bank_anchor_account_balances(p_organization_id uuid, p_connection_id uuid)
returns int
language plpgsql
set search_path = public
as $$
declare
  v_link record;
  v_ledger bigint;
  v_anchored int := 0;
begin
  for v_link in
    select l.id, l.account_id, l.current_balance_minor
      from bank_linked_accounts l
      join accounts a on a.id = l.account_id and a.organization_id = l.organization_id
     where l.organization_id = p_organization_id
       and l.connection_id = p_connection_id
       and l.ledger_account_created_by_import
       and l.import_mode = 'IMPORT'
       and l.detached_at is null
       and l.current_balance_minor is not null
       and a.currency = l.currency
       -- Only once every posted bank transaction has reached the ledger:
       -- anchoring against a half-imported history would be corrected on the
       -- next complete sync anyway, but there is no reason to show it.
       and not exists (
         select 1 from bank_external_transactions e
          where e.linked_account_id = l.id and e.status = 'POSTED' and e.needs_reconciliation
       )
     for update of a
  loop
    select
      coalesce((select sum(case when t.kind = 'income' then t.amount_minor else -t.amount_minor end) from transactions t where t.account_id = v_link.account_id), 0)
      + coalesce((select sum(t.amount_minor) from transactions t where t.transfer_account_id = v_link.account_id), 0)
      into v_ledger;

    update accounts
       set opening_balance_minor = v_link.current_balance_minor - v_ledger
     where id = v_link.account_id
       and opening_balance_minor is distinct from v_link.current_balance_minor - v_ledger;
    if found then
      v_anchored := v_anchored + 1;
    end if;
  end loop;

  return v_anchored;
end;
$$;

-- ── 4. Provider-controlled fields ──────────────────────────────────────────

create or replace function transactions_bank_provider_fields_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated') or old.source <> 'bank_sync' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'a transaction imported from the bank cannot be deleted; it follows the bank' using errcode = 'check_violation';
  end if;
  if new.kind is distinct from old.kind
     or new.amount_minor is distinct from old.amount_minor
     or new.currency is distinct from old.currency
     or new.occurred_on is distinct from old.occurred_on
     or new.account_id is distinct from old.account_id
     or new.transfer_account_id is distinct from old.transfer_account_id then
    raise exception 'the amount, date, direction, currency and account of a bank-imported transaction come from the bank and cannot be changed by hand' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists transactions_bank_provider_fields_guard on transactions;
create trigger transactions_bank_provider_fields_guard
  before update or delete on transactions
  for each row execute function transactions_bank_provider_fields_guard();

-- ── 5. Schema version ──────────────────────────────────────────────────────

create or replace function operations_schema_version()
returns text
language sql
immutable
as $$ select '0054'::text $$;

-- ── Grants: the service role only ──────────────────────────────────────────

revoke execute on function bank_import_account_kind(text, text) from public, anon;
grant execute on function bank_import_account_kind(text, text) to authenticated, service_role;
revoke execute on function bank_import_linked_account(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function bank_import_linked_account(uuid, uuid, uuid) to service_role;
revoke execute on function bank_auto_import_accounts(uuid, uuid) from public, anon, authenticated;
revoke execute on function bank_anchor_account_balances(uuid, uuid) from public, anon, authenticated;
grant execute on function bank_auto_import_accounts(uuid, uuid) to service_role;
grant execute on function bank_anchor_account_balances(uuid, uuid) to service_role;
revoke execute on function operations_schema_version() from public, anon, authenticated;
grant execute on function operations_schema_version() to service_role;
