-- ════════════════════════════════════════════════════════════════════════════
-- 0057 — internal transfers: one movement, one ledger row
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
--
--   A provider reports one movement twice: a DEBIT on the account it left and
--   a CREDIT on the account it reached. Reconciliation turned those into an
--   expense and an income, so moving $500 from checking to savings became
--   $500 of spending AND $500 of earnings. Net cash flow stayed right; every
--   component figure was wrong. A credit-card payment was worse — the
--   purchases on the card were already expenses, so the payment added a
--   second one on top of them.
--
--   The ledger has modelled this correctly since 0016: ONE row carrying
--   `account_id` (where the money left) and `transfer_account_id` (where it
--   arrived). The balance engine debits the first and credits the second, and
--   `calculation-engine.ts` excludes transfers from every income and expense
--   aggregate. Nothing about that model changes here. What was missing was
--   the link between the two external transactions that describe it.
--
-- ── WHAT IT ADDS ────────────────────────────────────────────────────────────
--
--   1. bank_external_transactions.transfer_counterpart_id / transfer_role —
--      the pairing, with the invariants below enforced by the database.
--   2. A revision change kind, so a pairing is auditable.
--   3. bank_pair_internal_transfer() — a NEW function. The existing
--      bank_reconcile_transaction() is deliberately NOT replaced: it is
--      security-critical, it works, and re-emitting it to add one branch
--      risks transcribing it wrongly. Rolling this back is one DROP.
--   4. operations_schema_version() → '0057'.
--
-- ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
--
--   PURELY ADDITIVE. No column is dropped, no row is rewritten, no existing
--   index or constraint is removed — `bank_external_transactions_one_per_
--   ledger_row_idx` is untouched, because the pairing does not put two
--   externals on one ledger row: the DEBIT leg owns the row and the CREDIT
--   leg owns none.
--
--   NO HISTORICAL BACKFILL. Transactions already imported as income/expense
--   stay exactly as they are. Pairing applies to transactions reconciled from
--   here on, plus a bounded in-place correction described below. Restating
--   months of somebody's finances unattended is not something a migration
--   should do.
--
--   NOTHING IS EVER DELETED. Where representing a pair as one row would mean
--   removing an existing income row, this refuses and the application flags it
--   for a person — the same principle the provider-removal path already
--   follows.
--
-- ── DEPLOY ORDER ────────────────────────────────────────────────────────────
--
--   MIGRATE FIRST, THEN DEPLOY. The new code calls a function that does not
--   exist before this migration. The previous build neither calls it nor
--   writes these columns, so pushing ahead of the deploy is safe and leaves
--   no window where anything fails.
--
--   Rollback (safe at any time; pairings simply stop being made):
--     drop function if exists bank_pair_internal_transfer(uuid, uuid, uuid, int, int, uuid, uuid);
--     alter table bank_external_transactions
--       drop column if exists transfer_counterpart_id,
--       drop column if exists transfer_role;
--     create or replace function operations_schema_version() returns text language sql immutable as $$ select '0056'::text $$;
--   Ledger rows already written as transfers remain correct transfers; they
--   are ordinary rows of a kind the ledger has supported since 0016.

-- ── 1. The pairing ─────────────────────────────────────────────────────────

-- The self-reference below carries organization_id, which makes a cross-tenant
-- pairing unrepresentable rather than merely prevented in code. The composite
-- key it needs already exists (0047: bank_external_transactions_id_org_unique).
alter table bank_external_transactions
  add column if not exists transfer_counterpart_id uuid,
  add column if not exists transfer_role text;

-- Re-runnable. A push that cannot be retried is no use for repairing drift,
-- which is the one moment a migration is needed most: the five constraints
-- below are dropped first, so a database that already has some of them (a
-- previous attempt, a hand-applied statement) accepts the file rather than
-- refusing it with 42710. Each `if exists` is a no-op where the constraint
-- has never existed, so a fresh database is unaffected. The definitions that
-- follow are unchanged and are what the table ends up with either way.
alter table bank_external_transactions
  drop constraint if exists bank_external_transactions_transfer_counterpart_fkey,
  drop constraint if exists bank_external_transactions_transfer_role_consistent,
  drop constraint if exists bank_external_transactions_transfer_role_values,
  drop constraint if exists bank_external_transactions_transfer_not_self,
  drop constraint if exists bank_external_transactions_counterpart_has_no_ledger_row;

alter table bank_external_transactions
  add constraint bank_external_transactions_transfer_counterpart_fkey
    foreign key (transfer_counterpart_id, organization_id)
    references bank_external_transactions (id, organization_id) on delete set null (transfer_counterpart_id);

alter table bank_external_transactions
  -- Both halves of the pairing are set together or not at all.
  add constraint bank_external_transactions_transfer_role_consistent
    check ((transfer_counterpart_id is null) = (transfer_role is null)),
  add constraint bank_external_transactions_transfer_role_values
    check (transfer_role is null or transfer_role in ('SOURCE', 'COUNTERPART')),
  -- A transaction cannot be its own counterpart.
  add constraint bank_external_transactions_transfer_not_self
    check (transfer_counterpart_id is null or transfer_counterpart_id <> id),
  -- The COUNTERPART leg produces no ledger row: the movement is the SOURCE's
  -- single transfer row. Without this, a pair could double-count.
  add constraint bank_external_transactions_counterpart_has_no_ledger_row
    check (transfer_role is distinct from 'COUNTERPART' or ledger_transaction_id is null);

-- Each leg may be claimed exactly once. This is what makes pairing idempotent
-- and stops a third transaction joining an existing pair: a duplicate webhook
-- or a repeated sync that tried would violate it.
create unique index if not exists bank_external_transactions_transfer_counterpart_idx
  on bank_external_transactions (transfer_counterpart_id)
  where transfer_counterpart_id is not null;

-- What the sync last wrote may now be a transfer. Without this the pairing
-- cannot record what it wrote, and the edit-detection above it — which
-- compares the ledger row against these columns — would have nothing to
-- compare against on a paired row.
alter table bank_external_transactions
  drop constraint if exists bank_external_transactions_ledger_written_kind_check;

alter table bank_external_transactions
  add constraint bank_external_transactions_ledger_written_kind_check
    check (ledger_written_kind is null or ledger_written_kind in ('income', 'expense', 'transfer'));

-- ── 2. Auditability ────────────────────────────────────────────────────────

alter table bank_transaction_revisions
  drop constraint if exists bank_transaction_revisions_change_kind_check;

alter table bank_transaction_revisions
  add constraint bank_transaction_revisions_change_kind_check check (
    change_kind in (
      'CREATED', 'PROVIDER_MODIFIED', 'POSTED', 'SUPERSEDED', 'REMOVED',
      'LEDGER_IMPORTED', 'LEDGER_MATCHED', 'LEDGER_UPDATED',
      'FLAGGED_FOR_REVIEW', 'REVIEW_RESOLVED', 'STATE_CHANGED',
      -- 0057. Recorded on BOTH legs, so a pairing can always be traced.
      'TRANSFER_PAIRED'
    )
  );

-- ── 3. Pairing, applied atomically ─────────────────────────────────────────
--
--   Everything the application decided is re-checked here. The application is
--   not trusted to have scoped its query, compared the amounts, or noticed
--   that a leg was already claimed — this function is the authority, and it
--   holds row locks on both legs while it decides.

create or replace function bank_pair_internal_transfer(
  p_organization_id uuid,
  p_source_external_id uuid,
  p_counterpart_external_id uuid,
  p_expected_source_revision int,
  p_expected_counterpart_revision int,
  p_run_id uuid,
  p_actor uuid
)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_source bank_external_transactions%rowtype;
  v_counterpart bank_external_transactions%rowtype;
  v_source_link bank_linked_accounts%rowtype;
  v_counterpart_link bank_linked_accounts%rowtype;
  v_source_account accounts%rowtype;
  v_counterpart_account accounts%rowtype;
  v_ledger transactions%rowtype;
  v_ledger_id uuid;
  v_description text;
begin
  if p_source_external_id = p_counterpart_external_id then
    return 'INVALID';
  end if;

  -- Locked in a deterministic order so two concurrent runs pairing the same
  -- two transactions cannot deadlock against each other.
  if p_source_external_id < p_counterpart_external_id then
    select * into v_source from bank_external_transactions where id = p_source_external_id and organization_id = p_organization_id for update;
    select * into v_counterpart from bank_external_transactions where id = p_counterpart_external_id and organization_id = p_organization_id for update;
  else
    select * into v_counterpart from bank_external_transactions where id = p_counterpart_external_id and organization_id = p_organization_id for update;
    select * into v_source from bank_external_transactions where id = p_source_external_id and organization_id = p_organization_id for update;
  end if;

  if v_source.id is null or v_counterpart.id is null then
    return 'NOT_FOUND';
  end if;
  if v_source.revision <> p_expected_source_revision or v_counterpart.revision <> p_expected_counterpart_revision then
    return 'STALE';
  end if;

  -- The shape of a transfer. Any one of these failing means this is not one.
  if v_source.direction <> 'DEBIT' or v_counterpart.direction <> 'CREDIT' then
    return 'INVALID';
  end if;
  if v_source.status <> 'POSTED' or v_counterpart.status <> 'POSTED' then
    return 'INVALID';
  end if;
  if v_source.transfer_counterpart_id is not null or v_counterpart.transfer_counterpart_id is not null then
    -- Already paired. A repeated sync or a duplicate webhook lands here.
    return 'INVALID';
  end if;
  if v_source.amount_minor is null or v_counterpart.amount_minor is null or v_source.amount_minor <> v_counterpart.amount_minor then
    return 'INVALID';
  end if;
  if v_source.currency <> v_counterpart.currency then
    return 'INVALID';
  end if;
  if v_source.linked_account_id = v_counterpart.linked_account_id then
    return 'INVALID';
  end if;
  if abs(v_source.transaction_date - v_counterpart.transaction_date) > 3 then
    return 'INVALID';
  end if;
  -- The credit leg must not already be in the books: turning the pair into one
  -- row would mean deleting that income row, which this system does not do.
  if v_counterpart.ledger_transaction_id is not null then
    return 'INVALID';
  end if;

  select * into v_source_link from bank_linked_accounts where id = v_source.linked_account_id and organization_id = p_organization_id;
  select * into v_counterpart_link from bank_linked_accounts where id = v_counterpart.linked_account_id and organization_id = p_organization_id;
  if v_source_link.id is null or v_counterpart_link.id is null then
    return 'INVALID';
  end if;
  if v_source_link.import_mode <> 'IMPORT' or v_source_link.account_id is null or v_source_link.detached_at is not null then
    return 'INVALID';
  end if;
  if v_counterpart_link.account_id is null or v_counterpart_link.detached_at is not null then
    return 'INVALID';
  end if;

  select * into v_source_account from accounts where id = v_source_link.account_id and organization_id = p_organization_id;
  select * into v_counterpart_account from accounts where id = v_counterpart_link.account_id and organization_id = p_organization_id;
  if v_source_account.id is null or v_counterpart_account.id is null or v_source_account.id = v_counterpart_account.id then
    return 'INVALID';
  end if;
  if v_source_account.currency <> v_source.currency or v_counterpart_account.currency <> v_source.currency then
    return 'INVALID';
  end if;

  v_description := coalesce(v_source.merchant_name, v_source.description);

  if v_source.ledger_transaction_id is null then
    -- The common case: neither leg is in the books yet, so the movement is
    -- written once, as a transfer, and no phantom row ever exists.
    insert into transactions (organization_id, account_id, transfer_account_id, kind, amount_minor, currency, occurred_on, description, source, created_by, is_reviewed)
    values (p_organization_id, v_source_account.id, v_counterpart_account.id, 'transfer'::transaction_kind, v_source.amount_minor, v_source.currency,
            v_source.transaction_date, v_description, 'bank_sync', null, false)
    returning id into v_ledger_id;
  else
    -- Delayed arrival: the debit leg already imported as an expense while its
    -- counterpart had not yet been reported. The row is corrected IN PLACE —
    -- nothing is deleted, and the correction is refused outright if a person
    -- has touched the row since, on exactly the terms the rest of
    -- reconciliation uses (`ledger_written_*` is what the sync last wrote).
    select * into v_ledger from transactions where id = v_source.ledger_transaction_id and organization_id = p_organization_id for update;
    if v_ledger.id is null then
      return 'INVALID';
    end if;
    if v_ledger.source <> 'bank_sync' then
      return 'LEDGER_EDITED';
    end if;
    if v_ledger.account_id is distinct from v_source.ledger_written_account_id
       or v_ledger.kind::text is distinct from v_source.ledger_written_kind
       or v_ledger.amount_minor is distinct from v_source.ledger_written_amount_minor
       or v_ledger.currency is distinct from v_source.ledger_written_currency
       or v_ledger.occurred_on is distinct from v_source.ledger_written_occurred_on
       or v_ledger.description is distinct from v_source.ledger_written_description
       or v_ledger.transfer_account_id is not null then
      return 'LEDGER_EDITED';
    end if;

    update transactions
       set kind = 'transfer'::transaction_kind,
           transfer_account_id = v_counterpart_account.id
     where id = v_ledger.id;
    v_ledger_id := v_ledger.id;
  end if;

  -- The debit leg owns the row and records what was written, so a later
  -- provider change is compared against the transfer rather than the expense.
  update bank_external_transactions set
    ledger_transaction_id = v_ledger_id,
    ledger_link_kind = 'IMPORTED',
    ledger_linked_at = coalesce(ledger_linked_at, now()),
    ledger_written_account_id = v_source_account.id,
    ledger_written_kind = 'transfer',
    ledger_written_amount_minor = v_source.amount_minor,
    ledger_written_currency = v_source.currency,
    ledger_written_occurred_on = v_source.transaction_date,
    ledger_written_description = v_description,
    reconciliation_state = 'IMPORTED',
    review_reason = null,
    needs_reconciliation = false,
    reconciled_revision = revision,
    transfer_counterpart_id = v_counterpart.id,
    transfer_role = 'SOURCE',
    last_sync_run_id = coalesce(p_run_id, last_sync_run_id)
  where id = v_source.id;

  -- The credit leg is accounted for by the row above and produces none of its
  -- own. IGNORED already means exactly that.
  update bank_external_transactions set
    reconciliation_state = 'IGNORED',
    review_reason = null,
    needs_reconciliation = false,
    reconciled_revision = revision,
    transfer_counterpart_id = v_source.id,
    transfer_role = 'COUNTERPART',
    last_sync_run_id = coalesce(p_run_id, last_sync_run_id)
  where id = v_counterpart.id;

  perform bank__record_revision(v_source.id, 'TRANSFER_PAIRED', p_run_id, p_actor);
  perform bank__record_revision(v_counterpart.id, 'TRANSFER_PAIRED', p_run_id, p_actor);
  return 'APPLIED';
end;
$$;

-- Same boundary as every other write in this schema: the service role only.
-- A browser session cannot pair transactions, and therefore cannot use
-- pairing to create or alter a ledger row.
revoke execute on function bank_pair_internal_transfer(uuid, uuid, uuid, int, int, uuid, uuid) from public, anon, authenticated;
grant execute on function bank_pair_internal_transfer(uuid, uuid, uuid, int, int, uuid, uuid) to service_role;

-- ── 3b. A paired leg is never imported again ───────────────────────────────
--
--   `bank_reconcile_transaction` decides from a snapshot the caller read
--   earlier in the batch. If a transfer pairing settled that row in between,
--   the snapshot still says "unreconciled" and the import branch would write a
--   second ledger row for a movement already recorded. The counterpart CHECK
--   would catch it as an exception; this turns it into an ordinary refusal the
--   caller already knows how to handle.

create or replace function bank_external_transactions_paired_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.transfer_role = 'COUNTERPART' and new.ledger_transaction_id is not null then
    raise exception 'a paired counterpart produces no ledger row of its own' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists bank_external_transactions_paired_guard_trg on bank_external_transactions;

create trigger bank_external_transactions_paired_guard_trg
  before update on bank_external_transactions
  for each row
  when (new.transfer_role is distinct from null)
  execute function bank_external_transactions_paired_guard();

-- ── 4. Finding the other leg ───────────────────────────────────────────────
--
--   The candidate search lives in SQL so that its ORGANIZATION SCOPING is not
--   something application code has to remember. Everything it returns is
--   already in the caller's organization, already POSTED, already unpaired,
--   already the opposite direction, and already the same amount and currency
--   within the window. The application then applies the judgement the
--   database should not make — corroboration and ambiguity — in
--   src/domain/bank-connections/internal-transfers.ts.
--
--   `account_kind` comes back with each row because a credit-card payment is
--   recognised by the kinds of the two accounts, not by any provider label.

create or replace function bank_transfer_candidates(p_organization_id uuid, p_external_id uuid)
returns table (
  id uuid,
  organization_id uuid,
  linked_account_id uuid,
  account_id uuid,
  account_kind text,
  direction text,
  amount_minor bigint,
  currency char(3),
  transaction_date date,
  status text,
  category_hint text,
  reconciliation_state text,
  ledger_transaction_id uuid,
  transfer_counterpart_id uuid,
  importable boolean,
  revision int
)
language sql
stable
set search_path = public
as $$
  with subject as (
    select e.* from bank_external_transactions e
     where e.id = p_external_id and e.organization_id = p_organization_id
  )
  select
    e.id,
    e.organization_id,
    e.linked_account_id,
    l.account_id,
    a.kind::text,
    e.direction,
    e.amount_minor,
    e.currency,
    e.transaction_date,
    e.status,
    e.category_hint,
    e.reconciliation_state,
    e.ledger_transaction_id,
    e.transfer_counterpart_id,
    (l.import_mode = 'IMPORT' and l.account_id is not null and l.detached_at is null),
    e.revision
  from subject s
  join bank_external_transactions e
    on e.organization_id = s.organization_id
   and e.id <> s.id
   and e.status = 'POSTED'
   and e.transfer_counterpart_id is null
   and e.direction <> s.direction
   and e.currency = s.currency
   and e.amount_minor is not null
   and e.amount_minor = s.amount_minor
   and e.linked_account_id <> s.linked_account_id
   and abs(e.transaction_date - s.transaction_date) <= 3
  join bank_linked_accounts l
    on l.id = e.linked_account_id and l.organization_id = e.organization_id
  left join accounts a
    on a.id = l.account_id and a.organization_id = e.organization_id
  -- Bounded: more than a handful of identical opposite movements in three
  -- days is ambiguity, and the matcher refuses it anyway.
  limit 10;
$$;

revoke execute on function bank_transfer_candidates(uuid, uuid) from public, anon, authenticated;
grant execute on function bank_transfer_candidates(uuid, uuid) to service_role;

-- ── 4. Schema version ──────────────────────────────────────────────────────

create or replace function operations_schema_version() returns text language sql immutable as $$ select '0057'::text $$;
