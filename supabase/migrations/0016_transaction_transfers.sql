-- Additive: a 'transfer' transaction moves money between two of the
-- organization's own accounts. Phase 1's `transactions` row only had a
-- single `account_id`, which is correct for income/expense but ambiguous
-- for a transfer's *other side* — this column disambiguates it. Balance
-- calculation (src/server/db/repositories/accounts.ts) reads it to credit
-- one account and debit the other for the same row, instead of the
-- previous simplification that netted transfers to zero everywhere
-- (silently wrong: it made a transfer invisible to both accounts' balances).

alter table transactions
  add column transfer_account_id uuid references accounts (id) on delete restrict;

alter table transactions
  add constraint transactions_transfer_requires_kind
  check (transfer_account_id is null or kind = 'transfer');

alter table transactions
  add constraint transactions_transfer_not_self
  check (transfer_account_id is null or transfer_account_id <> account_id);

create index transactions_transfer_account_id_idx on transactions (transfer_account_id) where transfer_account_id is not null;
