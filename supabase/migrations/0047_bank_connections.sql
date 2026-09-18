-- Bank connections: a provider-independent foundation for importing bank data
-- into the existing ledger. NO PROVIDER IS CONNECTED BY THIS MIGRATION.
--
-- WHAT EXISTED, AND WHAT THIS ADDS
--
-- `accounts` and `transactions` (0004) are the ledger. `transactions.source`
-- already allows 'bank_sync', and no row in any environment uses it. Nothing
-- here creates a second account or transaction system: an imported bank
-- transaction becomes an ordinary `transactions` row with source 'bank_sync',
-- so balances, totals, reports and the AI keep reading one ledger through the
-- aggregates in 0027, unchanged.
--
-- What is added sits BESIDE the ledger:
--
--   bank_connections             one consent at one provider, and its lifecycle
--   bank_connection_credentials  a REFERENCE to where the credential is kept
--   bank_linked_accounts         accounts the provider reports, and which
--                                Countorra account each one feeds, if any
--   bank_webhook_events          delivered provider events, for idempotency
--   bank_sync_jobs               requests to sync, with bounded attempts
--   bank_sync_runs               one row per attempt, with counts
--   bank_external_transactions   what the bank reported, versioned, linked to
--                                at most one ledger transaction
--   bank_transaction_revisions   append-only history of every change
--
-- WHO WRITES
--
-- Members can read the tenant-facing tables, column by column (provider
-- identifiers, cursors and idempotency keys are not readable), and write
-- nothing. Every write happens in server code after authorization, with the
-- service role, and the guard triggers below apply to the service role too.
-- Credentials and webhook events are not readable by members at all.
--
-- MONEY
--
-- Integer minor units plus an explicit currency, as everywhere else. A
-- transaction in a currency Countorra does not support keeps its decimal string
-- and no minor-unit amount; nothing is converted, and nothing enters the ledger
-- in a currency other than its account's.

-- ── 0. The origin of a ledger transaction ───────────────────────────────
--
-- `transactions.source = 'bank_sync'` must mean "a bank sync created this".
-- Before this migration a member could insert a transaction claiming that
-- origin through the Data API. Refused now for browser roles, in both
-- directions: a member can neither forge the origin nor launder an imported
-- transaction into a hand-entered one. Everything else about an imported
-- transaction — category, memo, review state, even its amount — stays editable
-- by the people who keep the books, exactly as for any other transaction.

create or replace function transactions_bank_origin_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if tg_op = 'INSERT' and new.source = 'bank_sync' then
    raise exception 'a transaction with source bank_sync can only be created by a bank sync' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.source is distinct from old.source and (new.source = 'bank_sync' or old.source = 'bank_sync') then
    raise exception 'the bank_sync origin of a transaction cannot be changed' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger transactions_bank_origin_guard
  before insert or update on transactions
  for each row execute function transactions_bank_origin_guard();

-- ── 1. Connections ──────────────────────────────────────────────────────

create table bank_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,

  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  /** The provider's id for this connection (for example a Plaid item id).
   *  Not readable by members, and never an authorization input. */
  provider_connection_id text not null check (char_length(provider_connection_id) between 1 and 200),
  institution_id text check (institution_id is null or char_length(institution_id) between 1 and 100),
  institution_name text check (institution_name is null or char_length(institution_name) between 1 and 120),

  status text not null default 'PENDING'
    check (status in ('PENDING', 'ACTIVE', 'DEGRADED', 'REQUIRES_REAUTH', 'ERROR', 'DISCONNECTED')),
  status_reason text not null default 'LINK_STARTED' check (
    status_reason in ('LINK_STARTED', 'LINK_COMPLETED', 'SYNC_SUCCEEDED', 'SYNC_FAILED', 'REPEATED_SYNC_FAILURE', 'PROVIDER_REPORTED_REAUTH',
      'PROVIDER_REPORTED_ERROR', 'PROVIDER_REVOKED', 'PROVIDER_RECOVERED', 'CONSENT_EXPIRED', 'CREDENTIAL_UNAVAILABLE', 'USER_DISCONNECTED')
  ),
  status_changed_at timestamptz not null default now(),
  /** Provider time of the newest lifecycle event applied. Older events are
   *  discarded, so out-of-order delivery cannot roll a status back. */
  last_provider_event_at timestamptz,

  consecutive_failed_runs int not null default 0 check (consecutive_failed_runs between 0 and 100000),
  /** A category written by Countorra, never a provider's message. */
  last_failure_category text check (
    last_failure_category is null or last_failure_category in ('PROVIDER_NOT_CONFIGURED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED',
      'MALFORMED_PROVIDER_RESPONSE', 'REAUTH_REQUIRED', 'CONNECTION_REVOKED', 'CREDENTIAL_UNAVAILABLE', 'CURSOR_RESET_REQUIRED', 'CURSOR_CONFLICT',
      'CONNECTION_DISCONNECTED', 'LEASE_EXPIRED', 'INTERNAL_ERROR')
  ),
  last_successful_sync_at timestamptz,
  last_sync_attempt_at timestamptz,

  /** The cursor at the end of the last COMPLETE pagination, and the cursor the
   *  next page starts from. A provider that asks for pagination to restart
   *  resumes from the committed one; ingestion is idempotent, so replaying
   *  pages is safe. Not readable by members. */
  committed_cursor text check (committed_cursor is null or char_length(committed_cursor) between 1 and 1024),
  page_cursor text check (page_cursor is null or char_length(page_cursor) between 1 and 1024),

  created_by uuid references auth.users (id) on delete set null,
  disconnected_by uuid references auth.users (id) on delete set null,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint bank_connections_id_org_unique unique (id, organization_id),
  -- One provider connection belongs to exactly one Countorra connection, in one
  -- organization. A webhook naming a provider id therefore resolves to at most
  -- one tenant, and the same id cannot be registered into a second workspace.
  constraint bank_connections_provider_identity_unique unique (provider, provider_connection_id),
  constraint bank_connections_disconnected_consistent check ((status = 'DISCONNECTED') = (disconnected_at is not null)),
  constraint bank_connections_no_cursor_when_disconnected check (status <> 'DISCONNECTED' or (committed_cursor is null and page_cursor is null))
);

create index bank_connections_organization_idx on bank_connections (organization_id, created_at desc);

create trigger bank_connections_set_updated_at
  before update on bank_connections
  for each row execute function set_updated_at();

comment on table bank_connections is
  'One consent at one bank-data provider. Status moves only along src/domain/bank-connections/lifecycle.ts, enforced by bank_connections_guard. DISCONNECTED is terminal; disconnecting never deletes imported transactions.';

-- ── 2. Credential references ────────────────────────────────────────────
--
-- A provider access token is never stored in a financial table. This table
-- holds a REFERENCE to a secret store (for example a Supabase Vault secret id)
-- and nothing else. It has no member policy and no member privileges, and its
-- value is refused if it looks like a raw provider token.

create table bank_connection_credentials (
  connection_id uuid primary key,
  organization_id uuid not null references organizations (id) on delete cascade,
  secret_ref text not null
    check (secret_ref ~ '^[a-z][a-z0-9_-]{1,31}:[A-Za-z0-9._:-]{8,200}$')
    check (secret_ref !~* '(access|public|link|processor)-(sandbox|development|production)'),
  created_at timestamptz not null default now(),
  rotated_at timestamptz,

  constraint bank_connection_credentials_connection_fkey
    foreign key (connection_id, organization_id) references bank_connections (id, organization_id) on delete cascade
);

comment on table bank_connection_credentials is
  'A reference to where a provider credential is kept, never the credential. Destroyed in the secret store and deleted here before a connection is disconnected, and before an organization is deleted.';

-- ── 3. Linked (external) accounts ───────────────────────────────────────

create table bank_linked_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  connection_id uuid not null,
  provider_account_id text not null check (char_length(provider_account_id) between 1 and 200),

  /** The Countorra account this bank account feeds. Explicit: set only by a
   *  person's decision, never guessed and never created automatically. */
  account_id uuid,
  import_mode text not null default 'AWAITING_DECISION' check (import_mode in ('AWAITING_DECISION', 'IMPORT', 'IGNORE')),

  account_type text not null check (account_type in ('DEPOSITORY', 'CREDIT', 'LOAN', 'INVESTMENT', 'OTHER')),
  account_subtype text check (account_subtype is null or account_subtype ~ '^[a-z][a-z0-9_]{0,39}$'),
  display_name text not null check (char_length(display_name) between 1 and 120),
  /** At most the last four characters. Never an account number. */
  mask text check (mask is null or mask ~ '^[0-9A-Za-z]{2,4}$'),
  currency char(3) check (currency is null or currency ~ '^[A-Z]{3}$'),
  /** What the bank reports. Informational only: Countorra's balance is always
   *  derived from the ledger (0027), never from these. */
  current_balance_minor bigint,
  available_balance_minor bigint,
  balances_as_of timestamptz,
  provider_state text not null default 'OPEN' check (provider_state in ('OPEN', 'CLOSED')),

  linked_by uuid references auth.users (id) on delete set null,
  linked_at timestamptz,
  /** Set when the connection is disconnected. History stays; the link to the
   *  Countorra account is released for a future connection. */
  detached_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint bank_linked_accounts_connection_fkey
    foreign key (connection_id, organization_id) references bank_connections (id, organization_id) on delete cascade,
  constraint bank_linked_accounts_account_fkey
    foreign key (account_id, organization_id) references accounts (id, organization_id) on delete set null (account_id),
  constraint bank_linked_accounts_id_org_unique unique (id, organization_id),
  constraint bank_linked_accounts_provider_identity_unique unique (connection_id, provider_account_id),
  constraint bank_linked_accounts_balances_have_currency check ((current_balance_minor is null and available_balance_minor is null) or currency is not null)
);

-- A Countorra account is fed by at most one live bank account, so the same
-- money can never be imported twice through two links.
create unique index bank_linked_accounts_one_feed_per_account_idx
  on bank_linked_accounts (account_id)
  where account_id is not null and detached_at is null;

create index bank_linked_accounts_connection_idx on bank_linked_accounts (organization_id, connection_id);

create trigger bank_linked_accounts_set_updated_at
  before update on bank_linked_accounts
  for each row execute function set_updated_at();

-- ── 4. Webhook events ───────────────────────────────────────────────────

create table bank_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 200),
  event_type text not null check (
    event_type in ('TRANSACTIONS_UPDATED', 'CONNECTION_REQUIRES_REAUTH', 'CONNECTION_ERROR', 'CONNECTION_REVOKED', 'CONNECTION_RECOVERED', 'CONSENT_EXPIRING', 'UNSUPPORTED')
  ),
  provider_event_type text not null check (provider_event_type ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  provider_connection_id text check (provider_connection_id is null or char_length(provider_connection_id) between 1 and 200),
  occurred_at timestamptz,
  /** A hash of the verified body. The body itself is never stored. */
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),

  organization_id uuid references organizations (id) on delete set null,
  connection_id uuid references bank_connections (id) on delete set null,

  status text not null default 'RECEIVED' check (status in ('RECEIVED', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED')),
  outcome text check (
    outcome is null or outcome in ('SYNC_ENQUEUED', 'SYNC_ALREADY_ACTIVE', 'STATUS_UPDATED', 'STALE_EVENT', 'UNKNOWN_CONNECTION', 'CONNECTION_DISCONNECTED', 'UNSUPPORTED_EVENT', 'NO_CHANGE')
  ),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 5 check (max_attempts between 1 and 10),
  failure_category text check (failure_category is null or failure_category in ('INTERNAL_ERROR', 'LEASE_EXPIRED')),
  received_at timestamptz not null default now(),
  processing_started_at timestamptz,
  processed_at timestamptz,

  -- The idempotency mechanism: a redelivered event is the same row.
  constraint bank_webhook_events_provider_event_unique unique (provider, provider_event_id),
  constraint bank_webhook_events_attempts_bounded check (attempts <= max_attempts),
  constraint bank_webhook_events_failure_only_when_failed check ((status = 'FAILED') = (failure_category is not null))
);

create index bank_webhook_events_received_idx on bank_webhook_events (received_at desc);
create index bank_webhook_events_connection_idx on bank_webhook_events (connection_id, received_at desc) where connection_id is not null;

comment on table bank_webhook_events is
  'Verified provider events, claimed by (provider, provider_event_id). Delivery internals, not tenant data: no member access. The body is not stored, only its hash.';

-- ── 5. Sync jobs and runs ───────────────────────────────────────────────

create table bank_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  connection_id uuid not null,

  status text not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'RETRYABLE', 'FAILED', 'CANCELLED')),
  trigger text not null check (trigger in ('INITIAL', 'MANUAL', 'WEBHOOK', 'SCHEDULED', 'CONTINUATION')),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 300),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 5 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz,
  lease_expires_at timestamptz,
  failure_category text check (
    failure_category is null or failure_category in ('PROVIDER_NOT_CONFIGURED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED',
      'MALFORMED_PROVIDER_RESPONSE', 'REAUTH_REQUIRED', 'CONNECTION_REVOKED', 'CREDENTIAL_UNAVAILABLE', 'CURSOR_RESET_REQUIRED', 'CURSOR_CONFLICT',
      'CONNECTION_DISCONNECTED', 'LEASE_EXPIRED', 'INTERNAL_ERROR')
  ),
  requested_by uuid references auth.users (id) on delete set null,
  webhook_event_id uuid references bank_webhook_events (id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint bank_sync_jobs_connection_fkey
    foreign key (connection_id, organization_id) references bank_connections (id, organization_id) on delete cascade,
  constraint bank_sync_jobs_id_org_unique unique (id, organization_id),
  constraint bank_sync_jobs_idempotency_unique unique (organization_id, idempotency_key),
  constraint bank_sync_jobs_attempts_bounded check (attempts <= max_attempts),
  constraint bank_sync_jobs_failure_consistent check ((status in ('FAILED', 'RETRYABLE')) = (failure_category is not null))
);

-- At most one job in flight per connection. This, not application code, is
-- what makes concurrent refreshes, webhooks and schedulers one sync.
create unique index bank_sync_jobs_one_active_idx
  on bank_sync_jobs (connection_id)
  where status in ('QUEUED', 'RUNNING', 'RETRYABLE');

create index bank_sync_jobs_connection_idx on bank_sync_jobs (organization_id, connection_id, created_at desc);
create index bank_sync_jobs_due_idx on bank_sync_jobs (next_attempt_at) where status in ('QUEUED', 'RETRYABLE');

create trigger bank_sync_jobs_set_updated_at
  before update on bank_sync_jobs
  for each row execute function set_updated_at();

create table bank_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  job_id uuid not null,
  connection_id uuid not null,
  attempt int not null check (attempt >= 1),
  status text not null default 'RUNNING' check (status in ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),

  pages_fetched int not null default 0,
  accounts_seen int not null default 0,
  transactions_added int not null default 0,
  transactions_modified int not null default 0,
  transactions_unchanged int not null default 0,
  transactions_removed int not null default 0,
  transactions_rejected int not null default 0,
  ledger_imported int not null default 0,
  ledger_matched int not null default 0,
  ledger_updated int not null default 0,
  flagged_for_review int not null default 0,
  has_more boolean not null default false,

  failure_category text check (
    failure_category is null or failure_category in ('PROVIDER_NOT_CONFIGURED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED',
      'MALFORMED_PROVIDER_RESPONSE', 'REAUTH_REQUIRED', 'CONNECTION_REVOKED', 'CREDENTIAL_UNAVAILABLE', 'CURSOR_RESET_REQUIRED', 'CURSOR_CONFLICT',
      'CONNECTION_DISCONNECTED', 'LEASE_EXPIRED', 'INTERNAL_ERROR')
  ),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  duration_ms int check (duration_ms is null or duration_ms >= 0),

  constraint bank_sync_runs_job_fkey
    foreign key (job_id, organization_id) references bank_sync_jobs (id, organization_id) on delete cascade,
  constraint bank_sync_runs_connection_fkey
    foreign key (connection_id, organization_id) references bank_connections (id, organization_id) on delete cascade,
  constraint bank_sync_runs_id_org_unique unique (id, organization_id),
  constraint bank_sync_runs_attempt_unique unique (job_id, attempt),
  constraint bank_sync_runs_counts_nonnegative check (
    pages_fetched >= 0 and accounts_seen >= 0 and transactions_added >= 0 and transactions_modified >= 0 and transactions_unchanged >= 0
    and transactions_removed >= 0 and transactions_rejected >= 0 and ledger_imported >= 0 and ledger_matched >= 0 and ledger_updated >= 0 and flagged_for_review >= 0
  ),
  constraint bank_sync_runs_failure_consistent check ((status = 'FAILED') = (failure_category is not null)),
  constraint bank_sync_runs_completed_consistent check ((status = 'RUNNING') = (completed_at is null))
);

create index bank_sync_runs_job_idx on bank_sync_runs (organization_id, job_id, attempt);
create index bank_sync_runs_connection_idx on bank_sync_runs (organization_id, connection_id, started_at desc);

-- ── 6. External transactions ────────────────────────────────────────────

-- The same-organization composite key 0020 gave `accounts`, so a bank
-- transaction's ledger link can require that the ledger row is in the SAME
-- organization. `id` is already the primary key: this adds no rule a row could
-- break, and changes no data.
alter table transactions add constraint transactions_id_org_unique unique (id, organization_id);

create table bank_external_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  connection_id uuid not null,
  linked_account_id uuid not null,
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),

  provider_transaction_id text not null check (char_length(provider_transaction_id) between 1 and 200),
  /** On a posted transaction that replaced a pending one with a different id. */
  pending_provider_transaction_id text check (pending_provider_transaction_id is null or char_length(pending_provider_transaction_id) between 1 and 200),
  status text not null check (status in ('PENDING', 'POSTED', 'SUPERSEDED', 'REMOVED')),
  direction text not null check (direction in ('DEBIT', 'CREDIT')),

  amount_decimal text not null check (amount_decimal ~ '^[0-9]{1,15}(\.[0-9]{1,4})?$'),
  /** Null only when the currency is one Countorra cannot hold. */
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  transaction_date date not null,
  posted_date date,
  authorized_date date,
  merchant_name text check (merchant_name is null or char_length(merchant_name) <= 200),
  description text check (description is null or char_length(description) <= 300),
  /** The provider's category label, kept as a hint. Never applied to the ledger
   *  automatically. */
  category_hint text check (category_hint is null or char_length(category_hint) <= 100),
  /** sha256 of every stored field. Unchanged hash, unchanged row: a repeated
   *  sync is a no-op. */
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  revision int not null default 1 check (revision >= 1),
  superseded_by_id uuid,
  removed_at timestamptz,

  reconciliation_state text not null default 'UNRECONCILED' check (
    reconciliation_state in ('UNRECONCILED', 'PENDING_SETTLEMENT', 'AWAITING_ACCOUNT_LINK', 'IMPORTED', 'MATCHED', 'NEEDS_REVIEW', 'IGNORED',
      'CURRENCY_MISMATCH', 'UNSUPPORTED_CURRENCY', 'NOT_POSTED', 'REMOVED_FROM_BOOKS')
  ),
  review_reason text check (
    review_reason is null or review_reason in ('AMBIGUOUS_MANUAL_MATCH', 'PROVIDER_CHANGED_AFTER_EDIT', 'PROVIDER_CHANGED_MATCHED', 'REMOVED_BY_PROVIDER')
  ),
  needs_reconciliation boolean not null default true,
  reconciled_revision int,
  review_resolved_revision int,

  /** The ledger transaction this is, if any. Deleting that ledger transaction
   *  clears only this column; the bank's record stays. */
  ledger_transaction_id uuid,
  ledger_link_kind text check (ledger_link_kind is null or ledger_link_kind in ('IMPORTED', 'MATCHED')),
  ledger_linked_at timestamptz,
  /** The provider values last written to, or acknowledged against, the
   *  ledger. A ledger row that no longer equals these was edited by a person,
   *  and a sync will not overwrite it. */
  ledger_written_account_id uuid,
  ledger_written_kind text check (ledger_written_kind is null or ledger_written_kind in ('income', 'expense')),
  ledger_written_amount_minor bigint,
  ledger_written_currency char(3),
  ledger_written_occurred_on date,
  ledger_written_description text check (ledger_written_description is null or char_length(ledger_written_description) <= 300),

  first_sync_run_id uuid,
  last_sync_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint bank_external_transactions_connection_fkey
    foreign key (connection_id, organization_id) references bank_connections (id, organization_id) on delete cascade,
  constraint bank_external_transactions_linked_account_fkey
    foreign key (linked_account_id, organization_id) references bank_linked_accounts (id, organization_id) on delete cascade,
  constraint bank_external_transactions_superseded_by_fkey
    foreign key (superseded_by_id, organization_id) references bank_external_transactions (id, organization_id) on delete set null (superseded_by_id),
  constraint bank_external_transactions_ledger_fkey
    foreign key (ledger_transaction_id, organization_id) references transactions (id, organization_id) on delete set null (ledger_transaction_id),
  constraint bank_external_transactions_first_run_fkey
    foreign key (first_sync_run_id, organization_id) references bank_sync_runs (id, organization_id) on delete set null (first_sync_run_id),
  constraint bank_external_transactions_last_run_fkey
    foreign key (last_sync_run_id, organization_id) references bank_sync_runs (id, organization_id) on delete set null (last_sync_run_id),
  constraint bank_external_transactions_id_org_unique unique (id, organization_id),

  -- THE deduplication rule: one row per provider transaction per connection.
  constraint bank_external_transactions_provider_identity_unique unique (connection_id, provider_transaction_id),
  -- Pending transactions never enter the ledger (reconciliation.ts).
  constraint bank_external_transactions_pending_not_in_ledger check (status = 'POSTED' or status = 'REMOVED' or ledger_transaction_id is null),
  constraint bank_external_transactions_link_consistent check ((ledger_link_kind is null) = (ledger_linked_at is null)),
  constraint bank_external_transactions_link_recorded check (ledger_transaction_id is null or ledger_linked_at is not null),
  constraint bank_external_transactions_review_reason_consistent check ((reconciliation_state = 'NEEDS_REVIEW') = (review_reason is not null)),
  constraint bank_external_transactions_linked_states check (reconciliation_state not in ('IMPORTED', 'MATCHED') or ledger_linked_at is not null)
);

-- One ledger transaction is at most one bank transaction: a hand-entered
-- transaction can be matched once, and an import can never be linked twice.
create unique index bank_external_transactions_one_per_ledger_row_idx
  on bank_external_transactions (ledger_transaction_id)
  where ledger_transaction_id is not null;

create index bank_external_transactions_account_date_idx on bank_external_transactions (organization_id, linked_account_id, transaction_date desc);
create index bank_external_transactions_to_reconcile_idx on bank_external_transactions (connection_id, created_at) where needs_reconciliation;
create index bank_external_transactions_review_idx on bank_external_transactions (organization_id, connection_id) where reconciliation_state = 'NEEDS_REVIEW';
create index bank_external_transactions_pending_lookup_idx on bank_external_transactions (connection_id, provider_transaction_id) where status = 'PENDING';

create trigger bank_external_transactions_set_updated_at
  before update on bank_external_transactions
  for each row execute function set_updated_at();

comment on table bank_external_transactions is
  'What a bank reported, one row per provider transaction per connection, versioned by revision. Linked to at most one ledger transaction. Never deleted by a sync; see src/domain/bank-connections/reconciliation.ts for how it reaches the ledger.';

create table bank_transaction_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  external_transaction_id uuid not null,
  revision int not null check (revision >= 1),
  change_kind text not null check (
    change_kind in ('CREATED', 'PROVIDER_MODIFIED', 'POSTED', 'SUPERSEDED', 'REMOVED', 'LEDGER_IMPORTED', 'LEDGER_MATCHED', 'LEDGER_UPDATED', 'FLAGGED_FOR_REVIEW', 'REVIEW_RESOLVED', 'STATE_CHANGED')
  ),
  sync_run_id uuid,
  actor_id uuid references auth.users (id) on delete set null,
  status text not null,
  amount_decimal text not null,
  amount_minor bigint,
  currency char(3) not null,
  transaction_date date not null,
  posted_date date,
  merchant_name text,
  description text,
  reconciliation_state text not null,
  review_reason text,
  ledger_transaction_id uuid,
  created_at timestamptz not null default now(),

  constraint bank_transaction_revisions_external_fkey
    foreign key (external_transaction_id, organization_id) references bank_external_transactions (id, organization_id) on delete cascade,
  constraint bank_transaction_revisions_run_fkey
    foreign key (sync_run_id, organization_id) references bank_sync_runs (id, organization_id) on delete set null (sync_run_id)
);

create index bank_transaction_revisions_external_idx on bank_transaction_revisions (organization_id, external_transaction_id, created_at);

-- ── 7. Guards ───────────────────────────────────────────────────────────

create or replace function bank_connections_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'bank connections are history: disconnect a connection instead of deleting it' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'PENDING' or new.status_reason <> 'LINK_STARTED' or new.disconnected_at is not null or new.disconnected_by is not null
       or new.committed_cursor is not null or new.page_cursor is not null or new.last_successful_sync_at is not null
       or new.consecutive_failed_runs <> 0 or new.last_failure_category is not null then
      raise exception 'a bank connection starts PENDING, with no sync history' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.id <> old.id or new.organization_id <> old.organization_id or new.provider <> old.provider
     or new.provider_connection_id <> old.provider_connection_id or new.created_at <> old.created_at then
    raise exception 'a bank connection''s identity cannot change' using errcode = 'check_violation';
  end if;

  if new.created_by is distinct from old.created_by and not (new.created_by is null and pg_trigger_depth() > 1) then
    raise exception 'bank_connections.created_by cannot be changed' using errcode = 'check_violation';
  end if;

  if new.disconnected_by is distinct from old.disconnected_by
     and not (new.disconnected_by is null and pg_trigger_depth() > 1)
     and not (old.status <> 'DISCONNECTED' and new.status = 'DISCONNECTED') then
    raise exception 'bank_connections.disconnected_by is set only when disconnecting' using errcode = 'check_violation';
  end if;

  if old.status = 'DISCONNECTED' then
    if (to_jsonb(new) - 'created_by' - 'disconnected_by' - 'updated_at') <> (to_jsonb(old) - 'created_by' - 'disconnected_by' - 'updated_at') then
      raise exception 'a disconnected bank connection cannot change' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.status <> old.status then
    if not (
      (old.status = 'PENDING' and new.status in ('ACTIVE', 'ERROR', 'DISCONNECTED'))
      or (old.status = 'ACTIVE' and new.status in ('DEGRADED', 'REQUIRES_REAUTH', 'ERROR', 'DISCONNECTED'))
      or (old.status = 'DEGRADED' and new.status in ('ACTIVE', 'REQUIRES_REAUTH', 'ERROR', 'DISCONNECTED'))
      or (old.status = 'REQUIRES_REAUTH' and new.status in ('ACTIVE', 'ERROR', 'DISCONNECTED'))
      or (old.status = 'ERROR' and new.status in ('ACTIVE', 'DEGRADED', 'REQUIRES_REAUTH', 'DISCONNECTED'))
    ) then
      raise exception 'a bank connection cannot move from % to %', old.status, new.status using errcode = 'check_violation';
    end if;
    if new.status = 'DISCONNECTED' and exists (select 1 from bank_connection_credentials c where c.connection_id = new.id) then
      raise exception 'a connection''s credential must be destroyed before it is disconnected' using errcode = 'check_violation';
    end if;
    new.status_changed_at := now();
  elsif new.status_changed_at is distinct from old.status_changed_at then
    raise exception 'bank_connections.status_changed_at changes only with the status' using errcode = 'check_violation';
  end if;

  if old.last_provider_event_at is not null
     and (new.last_provider_event_at is null or new.last_provider_event_at < old.last_provider_event_at) then
    raise exception 'bank_connections.last_provider_event_at only moves forward' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger bank_connections_guard
  before insert or update or delete on bank_connections
  for each row execute function bank_connections_guard();

create or replace function bank_connection_credentials_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_status text;
begin
  if tg_op = 'DELETE' then
    return old;
  end if;

  if tg_op = 'UPDATE' and (new.connection_id <> old.connection_id or new.organization_id <> old.organization_id or new.created_at <> old.created_at) then
    raise exception 'a credential reference belongs to one connection' using errcode = 'check_violation';
  end if;

  select status into v_status from bank_connections where id = new.connection_id and organization_id = new.organization_id;
  if v_status is null then
    raise exception 'bank_connection_credentials: the connection does not exist in this organization' using errcode = 'foreign_key_violation';
  end if;
  if v_status = 'DISCONNECTED' then
    raise exception 'a disconnected connection holds no credential' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger bank_connection_credentials_guard
  before insert or update or delete on bank_connection_credentials
  for each row execute function bank_connection_credentials_guard();

create or replace function bank_linked_accounts_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_status text;
  v_currency text;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'bank_linked_accounts are history and cannot be deleted directly' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.import_mode <> 'AWAITING_DECISION' or new.account_id is not null or new.detached_at is not null or new.linked_at is not null or new.linked_by is not null then
      raise exception 'an external account is recorded unlinked; a person decides what it feeds' using errcode = 'check_violation';
    end if;
    select status into v_status from bank_connections where id = new.connection_id and organization_id = new.organization_id;
    if v_status is null then
      raise exception 'bank_linked_accounts: the connection does not exist in this organization' using errcode = 'foreign_key_violation';
    end if;
    if v_status = 'DISCONNECTED' then
      raise exception 'a disconnected connection reports no accounts' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.id <> old.id or new.organization_id <> old.organization_id or new.connection_id <> old.connection_id
     or new.provider_account_id <> old.provider_account_id or new.created_at <> old.created_at then
    raise exception 'an external account''s identity cannot change' using errcode = 'check_violation';
  end if;

  if new.linked_by is distinct from old.linked_by
     and not (new.linked_by is null and pg_trigger_depth() > 1)
     and new.linked_at is not distinct from old.linked_at then
    raise exception 'bank_linked_accounts.linked_by changes only when an account is linked' using errcode = 'check_violation';
  end if;

  if old.detached_at is not null then
    if new.account_id is distinct from old.account_id and not (new.account_id is null and pg_trigger_depth() > 1) then
      raise exception 'a detached external account is history' using errcode = 'check_violation';
    end if;
    if (to_jsonb(new) - 'account_id' - 'linked_by' - 'updated_at') <> (to_jsonb(old) - 'account_id' - 'linked_by' - 'updated_at') then
      raise exception 'a detached external account is history' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.account_id is distinct from old.account_id and pg_trigger_depth() <= 1 then
    if old.account_id is not null and exists (
      select 1 from bank_external_transactions e where e.linked_account_id = old.id and e.ledger_linked_at is not null
    ) then
      raise exception 'an external account with transactions in the ledger stays linked to that account' using errcode = 'check_violation';
    end if;
    if new.account_id is not null then
      if new.currency is null then
        raise exception 'an external account with no known currency cannot be linked' using errcode = 'check_violation';
      end if;
      select currency into v_currency from accounts where id = new.account_id and organization_id = new.organization_id;
      if v_currency is null then
        raise exception 'bank_linked_accounts: the account does not exist in this organization' using errcode = 'foreign_key_violation';
      end if;
      if v_currency <> new.currency then
        raise exception 'an external account in % cannot feed an account in %', new.currency, v_currency using errcode = 'check_violation';
      end if;
      if new.linked_at is not distinct from old.linked_at then
        raise exception 'linking an external account records when it happened' using errcode = 'check_violation';
      end if;
    end if;
  end if;

  if new.account_id is not null and new.currency is distinct from old.currency then
    raise exception 'a linked external account''s currency cannot change' using errcode = 'check_violation';
  end if;

  if new.import_mode = 'IMPORT' and new.account_id is null and pg_trigger_depth() <= 1 then
    raise exception 'importing requires a linked account' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger bank_linked_accounts_guard
  before insert or update or delete on bank_linked_accounts
  for each row execute function bank_linked_accounts_guard();

create or replace function bank_webhook_events_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'bank_webhook_events are the idempotency record and cannot be deleted' using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'RECEIVED' or new.attempts <> 0 or new.outcome is not null or new.processed_at is not null or new.organization_id is not null or new.connection_id is not null then
      raise exception 'a webhook event is recorded as received, unresolved' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.id <> old.id or new.provider <> old.provider or new.provider_event_id <> old.provider_event_id or new.payload_sha256 <> old.payload_sha256
     or new.event_type <> old.event_type or new.provider_event_type <> old.provider_event_type
     or new.provider_connection_id is distinct from old.provider_connection_id or new.occurred_at is distinct from old.occurred_at
     or new.received_at <> old.received_at or new.max_attempts <> old.max_attempts then
    raise exception 'a webhook event''s identity cannot change' using errcode = 'check_violation';
  end if;

  if new.organization_id is distinct from old.organization_id and old.organization_id is not null and not (new.organization_id is null and pg_trigger_depth() > 1) then
    raise exception 'a webhook event''s organization is resolved once' using errcode = 'check_violation';
  end if;
  if new.connection_id is distinct from old.connection_id and old.connection_id is not null and not (new.connection_id is null and pg_trigger_depth() > 1) then
    raise exception 'a webhook event''s connection is resolved once' using errcode = 'check_violation';
  end if;

  if old.status in ('PROCESSED', 'IGNORED') and pg_trigger_depth() <= 1 then
    raise exception 'a handled webhook event is final' using errcode = 'check_violation';
  end if;

  if new.status <> old.status or new.attempts <> old.attempts then
    if not (
      (old.status = 'RECEIVED' and new.status = 'PROCESSING')
      or (old.status = 'PROCESSING' and new.status in ('PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED'))
      or (old.status = 'FAILED' and new.status = 'PROCESSING')
    ) then
      raise exception 'a webhook event cannot move from % to %', old.status, new.status using errcode = 'check_violation';
    end if;
    if new.status = 'PROCESSING' and old.status <> 'PROCESSING' or (new.status = 'PROCESSING' and new.attempts <> old.attempts) then
      if new.attempts <> old.attempts + 1 or new.processing_started_at is null then
        raise exception 'claiming a webhook event records one attempt' using errcode = 'check_violation';
      end if;
    elsif new.attempts <> old.attempts then
      raise exception 'attempts change only when an event is claimed' using errcode = 'check_violation';
    end if;
    if new.status in ('PROCESSED', 'IGNORED') and (new.processed_at is null or new.outcome is null) then
      raise exception 'a handled webhook event records its outcome' using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger bank_webhook_events_guard
  before insert or update or delete on bank_webhook_events
  for each row execute function bank_webhook_events_guard();

create or replace function bank_sync_jobs_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_status text;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'bank_sync_jobs are history and cannot be deleted directly' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'QUEUED' or new.attempts <> 0 or new.started_at is not null or new.completed_at is not null
       or new.lease_expires_at is not null or new.failure_category is not null then
      raise exception 'a bank sync job starts QUEUED, with no attempts' using errcode = 'check_violation';
    end if;
    select status into v_status from bank_connections where id = new.connection_id and organization_id = new.organization_id;
    if v_status is null then
      raise exception 'bank_sync_jobs: the connection does not exist in this organization' using errcode = 'foreign_key_violation';
    end if;
    if v_status = 'DISCONNECTED' then
      raise exception 'a disconnected connection cannot be synced' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.id <> old.id or new.organization_id <> old.organization_id or new.connection_id <> old.connection_id or new.trigger <> old.trigger
     or new.idempotency_key <> old.idempotency_key or new.max_attempts <> old.max_attempts or new.created_at <> old.created_at then
    raise exception 'a bank sync job''s identity cannot change' using errcode = 'check_violation';
  end if;
  if new.requested_by is distinct from old.requested_by and not (new.requested_by is null and pg_trigger_depth() > 1) then
    raise exception 'bank_sync_jobs.requested_by cannot be changed' using errcode = 'check_violation';
  end if;
  if new.webhook_event_id is distinct from old.webhook_event_id and not (new.webhook_event_id is null and pg_trigger_depth() > 1) then
    raise exception 'bank_sync_jobs.webhook_event_id cannot be changed' using errcode = 'check_violation';
  end if;

  if new.status = old.status then
    -- Only a running job's lease may be renewed.
    if (to_jsonb(new) - 'requested_by' - 'webhook_event_id' - 'updated_at' - 'lease_expires_at') <> (to_jsonb(old) - 'requested_by' - 'webhook_event_id' - 'updated_at' - 'lease_expires_at')
       or (new.lease_expires_at is distinct from old.lease_expires_at and old.status <> 'RUNNING') then
      raise exception 'a bank sync job changes only by moving to another status' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if not (
    (old.status = 'QUEUED' and new.status in ('RUNNING', 'CANCELLED'))
    or (old.status = 'RUNNING' and new.status in ('SUCCEEDED', 'RETRYABLE', 'FAILED', 'CANCELLED'))
    or (old.status = 'RETRYABLE' and new.status in ('QUEUED', 'FAILED', 'CANCELLED'))
  ) then
    raise exception 'a bank sync job cannot move from % to %', old.status, new.status using errcode = 'check_violation';
  end if;

  if old.status = 'QUEUED' and new.status = 'RUNNING' then
    if new.attempts <> old.attempts + 1 or new.started_at is null or new.lease_expires_at is null then
      raise exception 'starting a sync run records one attempt, its start and its lease' using errcode = 'check_violation';
    end if;
  elsif new.attempts <> old.attempts then
    raise exception 'attempts change only when a run starts' using errcode = 'check_violation';
  end if;

  if new.status = 'RETRYABLE' and (new.attempts >= new.max_attempts or new.next_attempt_at is null) then
    raise exception 'a job with no attempts left fails instead of retrying' using errcode = 'check_violation';
  end if;
  if old.status = 'RETRYABLE' and new.status = 'QUEUED' and old.attempts >= old.max_attempts then
    raise exception 'no attempts remain for this sync job' using errcode = 'check_violation';
  end if;
  if new.status in ('SUCCEEDED', 'FAILED', 'CANCELLED') and new.completed_at is null then
    raise exception 'a finished sync job records when it finished' using errcode = 'check_violation';
  end if;
  if new.status <> 'RUNNING' and new.lease_expires_at is not null then
    raise exception 'only a running sync job holds a lease' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger bank_sync_jobs_guard
  before insert or update or delete on bank_sync_jobs
  for each row execute function bank_sync_jobs_guard();

create or replace function bank_sync_runs_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_job record;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'bank_sync_runs are history and cannot be deleted directly' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'RUNNING' or new.pages_fetched <> 0 or new.transactions_added <> 0 or new.ledger_imported <> 0 or new.completed_at is not null then
      raise exception 'a sync run starts RUNNING, with nothing counted' using errcode = 'check_violation';
    end if;
    select id, status, connection_id, attempts into v_job from bank_sync_jobs where id = new.job_id and organization_id = new.organization_id;
    if v_job.id is null then
      raise exception 'bank_sync_runs: the job does not exist in this organization' using errcode = 'foreign_key_violation';
    end if;
    if v_job.status <> 'RUNNING' or v_job.connection_id <> new.connection_id or v_job.attempts <> new.attempt then
      raise exception 'a sync run belongs to its job''s current attempt' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.id <> old.id or new.organization_id <> old.organization_id or new.job_id <> old.job_id or new.connection_id <> old.connection_id
     or new.attempt <> old.attempt or new.started_at <> old.started_at then
    raise exception 'a sync run''s identity cannot change' using errcode = 'check_violation';
  end if;
  if old.status <> 'RUNNING' then
    raise exception 'a finished sync run is final' using errcode = 'check_violation';
  end if;
  if new.pages_fetched < old.pages_fetched or new.accounts_seen < old.accounts_seen or new.transactions_added < old.transactions_added
     or new.transactions_modified < old.transactions_modified or new.transactions_unchanged < old.transactions_unchanged
     or new.transactions_removed < old.transactions_removed or new.transactions_rejected < old.transactions_rejected
     or new.ledger_imported < old.ledger_imported or new.ledger_matched < old.ledger_matched or new.ledger_updated < old.ledger_updated
     or new.flagged_for_review < old.flagged_for_review then
    raise exception 'sync run counts only grow' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger bank_sync_runs_guard
  before insert or update or delete on bank_sync_runs
  for each row execute function bank_sync_runs_guard();

create or replace function bank_external_transactions_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_link record;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'bank transactions are evidence and cannot be deleted directly' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('PENDING', 'POSTED') or new.revision <> 1 or new.reconciliation_state <> 'UNRECONCILED' or not new.needs_reconciliation
       or new.ledger_transaction_id is not null or new.ledger_linked_at is not null or new.superseded_by_id is not null or new.removed_at is not null
       or new.reconciled_revision is not null or new.review_resolved_revision is not null then
      raise exception 'a bank transaction is recorded first exactly as reported, unreconciled' using errcode = 'check_violation';
    end if;
    select la.connection_id, la.detached_at, c.provider into v_link
      from bank_linked_accounts la join bank_connections c on c.id = la.connection_id
     where la.id = new.linked_account_id and la.organization_id = new.organization_id;
    if v_link.connection_id is null or v_link.connection_id <> new.connection_id then
      raise exception 'a bank transaction belongs to its account''s connection' using errcode = 'foreign_key_violation';
    end if;
    if v_link.detached_at is not null then
      raise exception 'a detached external account receives no transactions' using errcode = 'check_violation';
    end if;
    if v_link.provider <> new.provider then
      raise exception 'a bank transaction carries its connection''s provider' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.id <> old.id or new.organization_id <> old.organization_id or new.connection_id <> old.connection_id or new.linked_account_id <> old.linked_account_id
     or new.provider <> old.provider or new.provider_transaction_id <> old.provider_transaction_id or new.created_at <> old.created_at then
    raise exception 'a bank transaction''s identity cannot change' using errcode = 'check_violation';
  end if;
  if new.first_sync_run_id is distinct from old.first_sync_run_id and not (new.first_sync_run_id is null and pg_trigger_depth() > 1) then
    raise exception 'bank_external_transactions.first_sync_run_id cannot be changed' using errcode = 'check_violation';
  end if;

  if new.status <> old.status then
    if not ((old.status = 'PENDING' and new.status in ('POSTED', 'SUPERSEDED', 'REMOVED')) or (old.status = 'POSTED' and new.status = 'REMOVED')) then
      raise exception 'a bank transaction cannot move from % to %', old.status, new.status using errcode = 'check_violation';
    end if;
    if new.status = 'SUPERSEDED' and new.superseded_by_id is null then
      raise exception 'a superseded bank transaction names what replaced it' using errcode = 'check_violation';
    end if;
    if new.status = 'REMOVED' and new.removed_at is null then
      raise exception 'a removed bank transaction records when' using errcode = 'check_violation';
    end if;
  end if;

  if old.status in ('SUPERSEDED', 'REMOVED') and new.content_hash <> old.content_hash then
    raise exception 'a superseded or removed bank transaction is final' using errcode = 'check_violation';
  end if;

  if new.content_hash <> old.content_hash or new.status <> old.status then
    if new.revision <> old.revision + 1 or not new.needs_reconciliation then
      raise exception 'a changed bank transaction gets a new revision and is reconciled again' using errcode = 'check_violation';
    end if;
  elsif new.revision <> old.revision then
    raise exception 'a bank transaction''s revision changes only when the transaction does' using errcode = 'check_violation';
  end if;

  if new.ledger_transaction_id is distinct from old.ledger_transaction_id then
    if old.ledger_transaction_id is null then
      if old.ledger_linked_at is not null or new.status <> 'POSTED' or new.ledger_link_kind is null then
        raise exception 'only a posted bank transaction that was never in the ledger can be linked to it' using errcode = 'check_violation';
      end if;
    elsif new.ledger_transaction_id is null then
      if pg_trigger_depth() <= 1 then
        raise exception 'a ledger link is removed only by deleting the ledger transaction' using errcode = 'check_violation';
      end if;
    else
      raise exception 'a ledger link cannot be moved to another transaction' using errcode = 'check_violation';
    end if;
  elsif new.ledger_link_kind is distinct from old.ledger_link_kind or new.ledger_linked_at is distinct from old.ledger_linked_at then
    raise exception 'a ledger link is recorded once' using errcode = 'check_violation';
  end if;

  if new.reconciled_revision is not null and new.reconciled_revision > new.revision then
    raise exception 'a bank transaction cannot be reconciled at a revision it has not reached' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger bank_external_transactions_guard
  before insert or update or delete on bank_external_transactions
  for each row execute function bank_external_transactions_guard();

create or replace function bank_transaction_revisions_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'bank_transaction_revisions are append-only' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if pg_trigger_depth() <= 1
       or (to_jsonb(new) - 'actor_id' - 'sync_run_id') <> (to_jsonb(old) - 'actor_id' - 'sync_run_id')
       or (new.actor_id is distinct from old.actor_id and new.actor_id is not null)
       or (new.sync_run_id is distinct from old.sync_run_id and new.sync_run_id is not null) then
      raise exception 'bank_transaction_revisions are append-only' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger bank_transaction_revisions_guard
  before update or delete on bank_transaction_revisions
  for each row execute function bank_transaction_revisions_guard();

-- ── 8. Service-role functions ───────────────────────────────────────────
--
-- Every multi-row step is one function, so it happens in one transaction:
-- claiming a job and opening its run; applying a page and moving the cursor;
-- creating a ledger transaction and linking it; disconnecting. None of them is
-- callable by `anon` or `authenticated`.

create or replace function bank__record_revision(p_external_id uuid, p_change_kind text, p_run_id uuid, p_actor uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  insert into bank_transaction_revisions (
    organization_id, external_transaction_id, revision, change_kind, sync_run_id, actor_id, status, amount_decimal, amount_minor, currency,
    transaction_date, posted_date, merchant_name, description, reconciliation_state, review_reason, ledger_transaction_id
  )
  select e.organization_id, e.id, e.revision, p_change_kind, p_run_id, p_actor, e.status, e.amount_decimal, e.amount_minor, e.currency,
         e.transaction_date, e.posted_date, e.merchant_name, e.description, e.reconciliation_state, e.review_reason, e.ledger_transaction_id
    from bank_external_transactions e
   where e.id = p_external_id;
end;
$$;

create or replace function bank__supersede_pending(p_connection_id uuid, p_pending_provider_id text, p_posted_id uuid, p_run_id uuid)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_pending_id uuid;
begin
  select id into v_pending_id
    from bank_external_transactions
   where connection_id = p_connection_id and provider_transaction_id = p_pending_provider_id and status = 'PENDING' and id <> p_posted_id
   for update;
  if v_pending_id is null then
    return false;
  end if;
  update bank_external_transactions
     set status = 'SUPERSEDED', superseded_by_id = p_posted_id, revision = revision + 1, needs_reconciliation = true, last_sync_run_id = p_run_id
   where id = v_pending_id;
  perform bank__record_revision(v_pending_id, 'SUPERSEDED', p_run_id, null);
  return true;
end;
$$;

-- Claims whatever about a job is claimable, atomically: a due RETRYABLE job is
-- re-queued, a RUNNING job whose lease has expired is failed (and re-queued if
-- attempts remain), and a QUEUED job is started with a new run. Returns the
-- run id, or null when there is nothing to run now.
create or replace function bank_claim_sync_job(p_organization_id uuid, p_job_id uuid, p_lease_seconds int)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_job bank_sync_jobs%rowtype;
  v_connection_status text;
  v_run_id uuid;
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'bank_claim_sync_job: lease must be between 30 and 3600 seconds' using errcode = 'check_violation';
  end if;

  select * into v_job from bank_sync_jobs where id = p_job_id and organization_id = p_organization_id for update;
  if v_job.id is null then
    return null;
  end if;

  select status into v_connection_status from bank_connections where id = v_job.connection_id for update;

  if v_job.status = 'RUNNING' and v_job.lease_expires_at <= now() then
    update bank_sync_runs set status = 'FAILED', failure_category = 'LEASE_EXPIRED', completed_at = now()
     where job_id = v_job.id and status = 'RUNNING';
    if v_job.attempts < v_job.max_attempts then
      update bank_sync_jobs set status = 'RETRYABLE', failure_category = 'LEASE_EXPIRED', next_attempt_at = now(), lease_expires_at = null where id = v_job.id;
    else
      update bank_sync_jobs set status = 'FAILED', failure_category = 'LEASE_EXPIRED', completed_at = now(), lease_expires_at = null where id = v_job.id;
      return null;
    end if;
    select * into v_job from bank_sync_jobs where id = v_job.id;
  end if;

  if v_job.status in ('QUEUED', 'RETRYABLE') and v_connection_status = 'DISCONNECTED' then
    update bank_sync_jobs set status = 'CANCELLED', failure_category = null, next_attempt_at = null, completed_at = now() where id = v_job.id;
    return null;
  end if;

  if v_job.status = 'RETRYABLE' then
    if v_job.next_attempt_at > now() or v_job.attempts >= v_job.max_attempts then
      return null;
    end if;
    update bank_sync_jobs set status = 'QUEUED', failure_category = null where id = v_job.id;
    select * into v_job from bank_sync_jobs where id = v_job.id;
  end if;

  if v_job.status <> 'QUEUED' or (v_job.next_attempt_at is not null and v_job.next_attempt_at > now()) or v_job.attempts >= v_job.max_attempts then
    return null;
  end if;

  update bank_sync_jobs
     set status = 'RUNNING', attempts = attempts + 1, started_at = now(), next_attempt_at = null,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where id = v_job.id;
  update bank_connections set last_sync_attempt_at = now() where id = v_job.connection_id;

  insert into bank_sync_runs (organization_id, job_id, connection_id, attempt)
  values (p_organization_id, v_job.id, v_job.connection_id, v_job.attempts + 1)
  returning id into v_run_id;

  return v_run_id;
end;
$$;

-- Applies one normalized provider page. Idempotent: a page applied twice
-- changes nothing the second time. Refuses a page whose starting cursor is not
-- the connection's current one, which is what stops two runs interleaving
-- pages or an old page being applied after a newer one.
create or replace function bank_ingest_sync_page(
  p_organization_id uuid,
  p_run_id uuid,
  p_cursor_before text,
  p_cursor_after text,
  p_has_more boolean,
  p_accounts jsonb,
  p_transactions jsonb,
  p_removed jsonb,
  p_rejected int,
  p_lease_seconds int
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_run record;
  v_connection bank_connections%rowtype;
  v_item jsonb;
  v_removed_id text;
  v_existing bank_external_transactions%rowtype;
  v_linked_id uuid;
  v_new_id uuid;
  v_accounts int := 0;
  v_added int := 0;
  v_modified int := 0;
  v_unchanged int := 0;
  v_removed int := 0;
  v_rejected int := greatest(coalesce(p_rejected, 0), 0);
begin
  if jsonb_typeof(p_accounts) <> 'array' or jsonb_array_length(p_accounts) > 100
     or jsonb_typeof(p_transactions) <> 'array' or jsonb_array_length(p_transactions) > 500
     or jsonb_typeof(p_removed) <> 'array' or jsonb_array_length(p_removed) > 500 then
    raise exception 'bank_ingest_sync_page: a page holds at most 100 accounts, 500 transactions and 500 removals' using errcode = 'check_violation';
  end if;
  if p_cursor_after is null or char_length(p_cursor_after) not between 1 and 1024 then
    raise exception 'bank_ingest_sync_page: a page ends at a cursor' using errcode = 'check_violation';
  end if;

  select r.id, r.status, r.job_id, r.connection_id, j.status as job_status
    into v_run
    from bank_sync_runs r join bank_sync_jobs j on j.id = r.job_id
   where r.id = p_run_id and r.organization_id = p_organization_id;
  if v_run.id is null then
    raise exception 'bank_ingest_sync_page: run not found' using errcode = 'foreign_key_violation';
  end if;

  select * into v_connection from bank_connections where id = v_run.connection_id and organization_id = p_organization_id for update;
  if v_run.status <> 'RUNNING' or v_run.job_status <> 'RUNNING' then
    return jsonb_build_object('outcome', 'RUN_NOT_ACTIVE');
  end if;
  if v_connection.status = 'DISCONNECTED' then
    return jsonb_build_object('outcome', 'CONNECTION_DISCONNECTED');
  end if;
  if v_connection.page_cursor is distinct from p_cursor_before then
    return jsonb_build_object('outcome', 'CURSOR_CONFLICT');
  end if;

  for v_item in select value from jsonb_array_elements(p_accounts) loop
    insert into bank_linked_accounts (
      organization_id, connection_id, provider_account_id, account_type, account_subtype, display_name, mask, currency,
      current_balance_minor, available_balance_minor, balances_as_of, provider_state
    ) values (
      p_organization_id, v_connection.id, v_item->>'provider_account_id', v_item->>'account_type', v_item->>'account_subtype', v_item->>'display_name',
      v_item->>'mask', v_item->>'currency', (v_item->>'current_balance_minor')::bigint, (v_item->>'available_balance_minor')::bigint,
      case when v_item->>'current_balance_minor' is null and v_item->>'available_balance_minor' is null then null else now() end,
      v_item->>'provider_state'
    )
    on conflict (connection_id, provider_account_id) do update set
      account_type = excluded.account_type,
      account_subtype = excluded.account_subtype,
      display_name = excluded.display_name,
      mask = excluded.mask,
      -- A linked account's currency never changes under it; balances reported
      -- in a different currency are dropped rather than relabelled.
      currency = case when bank_linked_accounts.account_id is null then excluded.currency else bank_linked_accounts.currency end,
      current_balance_minor = case when bank_linked_accounts.account_id is not null and excluded.currency is distinct from bank_linked_accounts.currency then null else excluded.current_balance_minor end,
      available_balance_minor = case when bank_linked_accounts.account_id is not null and excluded.currency is distinct from bank_linked_accounts.currency then null else excluded.available_balance_minor end,
      balances_as_of = excluded.balances_as_of,
      provider_state = excluded.provider_state
    where bank_linked_accounts.detached_at is null;
    v_accounts := v_accounts + 1;
  end loop;

  for v_item in select value from jsonb_array_elements(p_transactions) loop
    select id into v_linked_id
      from bank_linked_accounts
     where connection_id = v_connection.id and provider_account_id = v_item->>'provider_account_id' and detached_at is null;
    if v_linked_id is null then
      v_rejected := v_rejected + 1;
      continue;
    end if;

    select * into v_existing
      from bank_external_transactions
     where connection_id = v_connection.id and provider_transaction_id = v_item->>'provider_transaction_id'
     for update;

    if v_existing.id is null then
      insert into bank_external_transactions (
        organization_id, connection_id, linked_account_id, provider, provider_transaction_id, pending_provider_transaction_id, status, direction,
        amount_decimal, amount_minor, currency, transaction_date, posted_date, authorized_date, merchant_name, description, category_hint,
        content_hash, first_sync_run_id, last_sync_run_id
      ) values (
        p_organization_id, v_connection.id, v_linked_id, v_connection.provider, v_item->>'provider_transaction_id', v_item->>'pending_provider_transaction_id',
        v_item->>'status', v_item->>'direction', v_item->>'amount_decimal', (v_item->>'amount_minor')::bigint, v_item->>'currency',
        (v_item->>'transaction_date')::date, (v_item->>'posted_date')::date, (v_item->>'authorized_date')::date,
        v_item->>'merchant_name', v_item->>'description', v_item->>'category_hint', v_item->>'content_hash', p_run_id, p_run_id
      )
      returning id into v_new_id;
      perform bank__record_revision(v_new_id, 'CREATED', p_run_id, null);
      v_added := v_added + 1;
    else
      v_new_id := v_existing.id;
      if v_existing.linked_account_id <> v_linked_id then
        v_rejected := v_rejected + 1;
        continue;
      end if;
      if v_existing.status in ('SUPERSEDED', 'REMOVED') or (v_existing.content_hash = v_item->>'content_hash' and v_existing.status = v_item->>'status') then
        v_unchanged := v_unchanged + 1;
        continue;
      end if;
      if v_existing.status = 'POSTED' and v_item->>'status' = 'PENDING' then
        v_rejected := v_rejected + 1;
        continue;
      end if;

      update bank_external_transactions set
        pending_provider_transaction_id = v_item->>'pending_provider_transaction_id',
        status = v_item->>'status',
        direction = v_item->>'direction',
        amount_decimal = v_item->>'amount_decimal',
        amount_minor = (v_item->>'amount_minor')::bigint,
        currency = v_item->>'currency',
        transaction_date = (v_item->>'transaction_date')::date,
        posted_date = (v_item->>'posted_date')::date,
        authorized_date = (v_item->>'authorized_date')::date,
        merchant_name = v_item->>'merchant_name',
        description = v_item->>'description',
        category_hint = v_item->>'category_hint',
        content_hash = v_item->>'content_hash',
        revision = revision + 1,
        needs_reconciliation = true,
        last_sync_run_id = p_run_id
      where id = v_existing.id;
      perform bank__record_revision(v_existing.id, case when v_existing.status = 'PENDING' and v_item->>'status' = 'POSTED' then 'POSTED' else 'PROVIDER_MODIFIED' end, p_run_id, null);
      v_modified := v_modified + 1;
    end if;

    if v_item->>'status' = 'POSTED' and v_item->>'pending_provider_transaction_id' is not null then
      perform bank__supersede_pending(v_connection.id, v_item->>'pending_provider_transaction_id', v_new_id, p_run_id);
    end if;
  end loop;

  for v_removed_id in select value from jsonb_array_elements_text(p_removed) loop
    update bank_external_transactions
       set status = 'REMOVED', removed_at = now(), revision = revision + 1, needs_reconciliation = true, last_sync_run_id = p_run_id
     where connection_id = v_connection.id and provider_transaction_id = v_removed_id and status in ('PENDING', 'POSTED')
     returning id into v_new_id;
    if found then
      perform bank__record_revision(v_new_id, 'REMOVED', p_run_id, null);
      v_removed := v_removed + 1;
    end if;
  end loop;

  update bank_connections
     set page_cursor = p_cursor_after,
         committed_cursor = case when p_has_more then committed_cursor else p_cursor_after end
   where id = v_connection.id;

  update bank_sync_jobs
     set lease_expires_at = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 600), 3600)))
   where id = v_run.job_id and status = 'RUNNING';

  update bank_sync_runs set
    pages_fetched = pages_fetched + 1,
    accounts_seen = accounts_seen + v_accounts,
    transactions_added = transactions_added + v_added,
    transactions_modified = transactions_modified + v_modified,
    transactions_unchanged = transactions_unchanged + v_unchanged,
    transactions_removed = transactions_removed + v_removed,
    transactions_rejected = transactions_rejected + v_rejected,
    has_more = p_has_more
  where id = p_run_id;

  return jsonb_build_object('outcome', 'APPLIED', 'accounts', v_accounts, 'added', v_added, 'modified', v_modified,
    'unchanged', v_unchanged, 'removed', v_removed, 'rejected', v_rejected);
end;
$$;

-- Restarts pagination from the last complete cursor, for a provider that
-- reports its data changed mid-pagination.
create or replace function bank_reset_page_cursor(p_organization_id uuid, p_connection_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  update bank_connections set page_cursor = committed_cursor
   where id = p_connection_id and organization_id = p_organization_id and status <> 'DISCONNECTED';
end;
$$;

-- Hand-entered transactions that could be this bank transaction: same account,
-- kind, amount and currency, inside the date window, not bank-imported, and not
-- already linked to another bank transaction. Bounded.
create or replace function bank_match_candidates(
  p_organization_id uuid,
  p_account_id uuid,
  p_kind transaction_kind,
  p_amount_minor bigint,
  p_currency text,
  p_date_from date,
  p_date_to date
)
returns table (id uuid, account_id uuid, kind transaction_kind, amount_minor bigint, currency char(3), occurred_on date, source text)
language sql
stable
set search_path = public
as $$
  select t.id, t.account_id, t.kind, t.amount_minor, t.currency, t.occurred_on, t.source
    from transactions t
   where t.organization_id = p_organization_id
     and t.account_id = p_account_id
     and t.kind = p_kind
     and t.amount_minor = p_amount_minor
     and t.currency = p_currency
     and t.occurred_on between p_date_from and p_date_to
     and t.source <> 'bank_sync'
     and not exists (select 1 from bank_external_transactions e where e.ledger_transaction_id = t.id)
   order by t.occurred_on, t.id
   limit 10
$$;

-- Applies one reconciliation decision, re-checking everything it depends on.
-- Returns APPLIED | STALE | NOT_FOUND | INVALID | CONFLICT | LEDGER_EDITED.
create or replace function bank_reconcile_transaction(
  p_organization_id uuid,
  p_external_id uuid,
  p_expected_revision int,
  p_decision jsonb,
  p_run_id uuid,
  p_actor uuid,
  p_resolution boolean
)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_external bank_external_transactions%rowtype;
  v_link bank_linked_accounts%rowtype;
  v_account accounts%rowtype;
  v_ledger transactions%rowtype;
  v_kind text := p_decision->>'kind';
  v_state text;
  v_reason text;
  v_ledger_kind text;
  v_description text;
  v_ledger_id uuid;
  v_ack jsonb := p_decision->'acknowledged';
  v_fields jsonb := p_decision->'ledger';
begin
  select * into v_external from bank_external_transactions where id = p_external_id and organization_id = p_organization_id for update;
  if v_external.id is null then
    return 'NOT_FOUND';
  end if;
  if v_external.revision <> p_expected_revision then
    return 'STALE';
  end if;
  select * into v_link from bank_linked_accounts where id = v_external.linked_account_id;

  v_ledger_kind := case v_external.direction when 'CREDIT' then 'income' else 'expense' end;
  v_description := coalesce(v_external.merchant_name, v_external.description);

  if v_kind = 'SET_STATE' then
    v_state := p_decision->>'state';
    v_reason := p_decision->>'review_reason';
    if v_state in ('IMPORTED', 'MATCHED') and v_external.ledger_transaction_id is null then
      return 'INVALID';
    end if;
    if (v_state = 'NEEDS_REVIEW') <> (v_reason is not null) then
      return 'INVALID';
    end if;
    if v_state = 'PENDING_SETTLEMENT' and v_external.status <> 'PENDING' then
      return 'INVALID';
    end if;

    update bank_external_transactions set
      reconciliation_state = v_state,
      review_reason = v_reason,
      needs_reconciliation = false,
      reconciled_revision = revision,
      review_resolved_revision = case when p_resolution then revision else review_resolved_revision end,
      last_sync_run_id = coalesce(p_run_id, last_sync_run_id),
      ledger_written_account_id = case when jsonb_typeof(v_ack) = 'object' then (v_ack->>'account_id')::uuid else ledger_written_account_id end,
      ledger_written_kind = case when jsonb_typeof(v_ack) = 'object' then v_ack->>'kind' else ledger_written_kind end,
      ledger_written_amount_minor = case when jsonb_typeof(v_ack) = 'object' then (v_ack->>'amount_minor')::bigint else ledger_written_amount_minor end,
      ledger_written_currency = case when jsonb_typeof(v_ack) = 'object' then v_ack->>'currency' else ledger_written_currency end,
      ledger_written_occurred_on = case when jsonb_typeof(v_ack) = 'object' then (v_ack->>'occurred_on')::date else ledger_written_occurred_on end,
      ledger_written_description = case when jsonb_typeof(v_ack) = 'object' then v_ack->>'description' else ledger_written_description end
    where id = v_external.id;

    if p_resolution then
      perform bank__record_revision(v_external.id, 'REVIEW_RESOLVED', p_run_id, p_actor);
    elsif v_state = 'NEEDS_REVIEW' and v_external.reconciliation_state <> 'NEEDS_REVIEW' then
      perform bank__record_revision(v_external.id, 'FLAGGED_FOR_REVIEW', p_run_id, null);
      update bank_sync_runs set flagged_for_review = flagged_for_review + 1 where id = p_run_id and status = 'RUNNING';
    elsif v_state <> v_external.reconciliation_state then
      perform bank__record_revision(v_external.id, 'STATE_CHANGED', p_run_id, null);
    end if;
    return 'APPLIED';
  end if;

  if v_kind in ('IMPORT', 'MATCH') then
    if v_external.status <> 'POSTED' or v_external.ledger_transaction_id is not null or v_external.ledger_linked_at is not null or v_external.amount_minor is null then
      return 'INVALID';
    end if;
    if v_link.import_mode <> 'IMPORT' or v_link.account_id is null or v_link.detached_at is not null then
      return 'INVALID';
    end if;
    select * into v_account from accounts where id = v_link.account_id and organization_id = p_organization_id;
    if v_account.id is null or v_account.currency <> v_external.currency or v_link.currency is distinct from v_external.currency then
      return 'INVALID';
    end if;
  end if;

  if v_kind = 'IMPORT' then
    -- The decision must describe exactly this transaction in this account.
    if jsonb_typeof(v_fields) <> 'object'
       or (v_fields->>'account_id')::uuid is distinct from v_account.id
       or v_fields->>'kind' is distinct from v_ledger_kind
       or (v_fields->>'amount_minor')::bigint is distinct from v_external.amount_minor
       or v_fields->>'currency' is distinct from v_external.currency
       or (v_fields->>'occurred_on')::date is distinct from v_external.transaction_date
       or v_fields->>'description' is distinct from v_description then
      return 'INVALID';
    end if;

    insert into transactions (organization_id, account_id, kind, amount_minor, currency, occurred_on, description, source, created_by, is_reviewed)
    values (p_organization_id, v_account.id, v_ledger_kind::transaction_kind, v_external.amount_minor, v_external.currency, v_external.transaction_date, v_description, 'bank_sync', null, false)
    returning id into v_ledger_id;

    update bank_external_transactions set
      ledger_transaction_id = v_ledger_id, ledger_link_kind = 'IMPORTED', ledger_linked_at = now(),
      ledger_written_account_id = v_account.id, ledger_written_kind = v_ledger_kind, ledger_written_amount_minor = v_external.amount_minor,
      ledger_written_currency = v_external.currency, ledger_written_occurred_on = v_external.transaction_date, ledger_written_description = v_description,
      reconciliation_state = 'IMPORTED', review_reason = null, needs_reconciliation = false, reconciled_revision = revision,
      review_resolved_revision = case when p_resolution then revision else review_resolved_revision end,
      last_sync_run_id = coalesce(p_run_id, last_sync_run_id)
    where id = v_external.id;

    perform bank__record_revision(v_external.id, 'LEDGER_IMPORTED', p_run_id, p_actor);
    update bank_sync_runs set ledger_imported = ledger_imported + 1 where id = p_run_id and status = 'RUNNING';
    return 'APPLIED';
  end if;

  if v_kind = 'MATCH' then
    select * into v_ledger from transactions where id = (p_decision->>'ledger_transaction_id')::uuid and organization_id = p_organization_id for update;
    if v_ledger.id is null or v_ledger.source = 'bank_sync' or v_ledger.account_id <> v_account.id or v_ledger.amount_minor <> v_external.amount_minor
       or v_ledger.currency <> v_external.currency or v_ledger.kind::text <> v_ledger_kind or abs(v_ledger.occurred_on - v_external.transaction_date) > 3 then
      return 'INVALID';
    end if;
    if exists (select 1 from bank_external_transactions e where e.ledger_transaction_id = v_ledger.id) then
      return 'CONFLICT';
    end if;

    begin
      update bank_external_transactions set
        ledger_transaction_id = v_ledger.id, ledger_link_kind = 'MATCHED', ledger_linked_at = now(),
        ledger_written_account_id = v_account.id, ledger_written_kind = v_ledger_kind, ledger_written_amount_minor = v_external.amount_minor,
        ledger_written_currency = v_external.currency, ledger_written_occurred_on = v_external.transaction_date, ledger_written_description = v_description,
        reconciliation_state = 'MATCHED', review_reason = null, needs_reconciliation = false, reconciled_revision = revision,
        review_resolved_revision = case when p_resolution then revision else review_resolved_revision end,
        last_sync_run_id = coalesce(p_run_id, last_sync_run_id)
      where id = v_external.id;
    exception when unique_violation then
      return 'CONFLICT';
    end;

    perform bank__record_revision(v_external.id, 'LEDGER_MATCHED', p_run_id, p_actor);
    update bank_sync_runs set ledger_matched = ledger_matched + 1 where id = p_run_id and status = 'RUNNING';
    return 'APPLIED';
  end if;

  if v_kind = 'UPDATE_LEDGER' then
    if v_external.status <> 'POSTED' or v_external.ledger_link_kind is distinct from 'IMPORTED' or v_external.ledger_transaction_id is null or v_external.amount_minor is null then
      return 'INVALID';
    end if;
    select * into v_ledger from transactions where id = v_external.ledger_transaction_id and organization_id = p_organization_id for update;
    if v_ledger.id is null then
      return 'INVALID';
    end if;

    -- A person's edit wins: the ledger row must still be exactly what the
    -- sync last wrote.
    if v_ledger.account_id is distinct from v_external.ledger_written_account_id
       or v_ledger.kind::text is distinct from v_external.ledger_written_kind
       or v_ledger.amount_minor is distinct from v_external.ledger_written_amount_minor
       or v_ledger.currency::text is distinct from v_external.ledger_written_currency::text
       or v_ledger.occurred_on is distinct from v_external.ledger_written_occurred_on
       or v_ledger.description is distinct from v_external.ledger_written_description then
      return 'LEDGER_EDITED';
    end if;

    if jsonb_typeof(v_fields) <> 'object'
       or (v_fields->>'account_id')::uuid is distinct from v_ledger.account_id
       or v_fields->>'kind' is distinct from v_ledger_kind
       or (v_fields->>'amount_minor')::bigint is distinct from v_external.amount_minor
       or v_fields->>'currency' is distinct from v_external.currency
       or (v_fields->>'occurred_on')::date is distinct from v_external.transaction_date
       or v_fields->>'description' is distinct from v_description then
      return 'INVALID';
    end if;

    update transactions set kind = v_ledger_kind::transaction_kind, amount_minor = v_external.amount_minor, occurred_on = v_external.transaction_date, description = v_description
     where id = v_ledger.id;

    update bank_external_transactions set
      ledger_written_kind = v_ledger_kind, ledger_written_amount_minor = v_external.amount_minor, ledger_written_occurred_on = v_external.transaction_date,
      ledger_written_description = v_description, reconciliation_state = 'IMPORTED', review_reason = null, needs_reconciliation = false,
      reconciled_revision = revision, last_sync_run_id = coalesce(p_run_id, last_sync_run_id)
    where id = v_external.id;

    perform bank__record_revision(v_external.id, 'LEDGER_UPDATED', p_run_id, p_actor);
    update bank_sync_runs set ledger_updated = ledger_updated + 1 where id = p_run_id and status = 'RUNNING';
    return 'APPLIED';
  end if;

  return 'INVALID';
end;
$$;

-- Finishes a run and its job together, and records the outcome on the
-- connection. Connection STATUS changes go through bank_transition_connection.
create or replace function bank_complete_sync_run(
  p_organization_id uuid,
  p_run_id uuid,
  p_outcome text,
  p_failure_category text,
  p_next_attempt_at timestamptz,
  p_counts_against_connection boolean,
  p_duration_ms int
)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_run bank_sync_runs%rowtype;
  v_job bank_sync_jobs%rowtype;
  v_job_status text;
begin
  select * into v_run from bank_sync_runs where id = p_run_id and organization_id = p_organization_id for update;
  if v_run.id is null then
    return 'NOT_FOUND';
  end if;
  select * into v_job from bank_sync_jobs where id = v_run.job_id for update;
  if v_run.status <> 'RUNNING' or v_job.status <> 'RUNNING' then
    return 'RUN_NOT_ACTIVE';
  end if;

  if p_outcome = 'SUCCEEDED' then
    update bank_sync_runs set status = 'SUCCEEDED', completed_at = now(), duration_ms = p_duration_ms where id = v_run.id;
    update bank_sync_jobs set status = 'SUCCEEDED', completed_at = now(), lease_expires_at = null where id = v_job.id;
    update bank_connections set last_successful_sync_at = now(), consecutive_failed_runs = 0, last_failure_category = null where id = v_run.connection_id;
    return 'SUCCEEDED';
  end if;

  if p_outcome = 'CANCELLED' then
    update bank_sync_runs set status = 'CANCELLED', completed_at = now(), duration_ms = p_duration_ms where id = v_run.id;
    update bank_sync_jobs set status = 'CANCELLED', completed_at = now(), lease_expires_at = null where id = v_job.id;
    return 'CANCELLED';
  end if;

  if p_outcome <> 'FAILED' or p_failure_category is null then
    raise exception 'bank_complete_sync_run: outcome must be SUCCEEDED, CANCELLED or FAILED with a category' using errcode = 'check_violation';
  end if;

  update bank_sync_runs set status = 'FAILED', failure_category = p_failure_category, completed_at = now(), duration_ms = p_duration_ms where id = v_run.id;
  if p_next_attempt_at is not null and v_job.attempts < v_job.max_attempts then
    update bank_sync_jobs set status = 'RETRYABLE', failure_category = p_failure_category, next_attempt_at = p_next_attempt_at, lease_expires_at = null where id = v_job.id;
    v_job_status := 'RETRYABLE';
  else
    update bank_sync_jobs set status = 'FAILED', failure_category = p_failure_category, completed_at = now(), lease_expires_at = null where id = v_job.id;
    v_job_status := 'FAILED';
  end if;
  if p_counts_against_connection then
    update bank_connections set consecutive_failed_runs = consecutive_failed_runs + 1, last_failure_category = p_failure_category
     where id = v_run.connection_id and status <> 'DISCONNECTED';
  end if;
  return v_job_status;
end;
$$;

-- Moves a connection's status if it is still what the caller read, and if the
-- provider event (when there is one) is newer than the last one applied.
-- Returns APPLIED | UNCHANGED | STATUS_CHANGED | STALE | ILLEGAL | NOT_FOUND.
create or replace function bank_transition_connection(
  p_organization_id uuid,
  p_connection_id uuid,
  p_expected_status text,
  p_to text,
  p_reason text,
  p_event_at timestamptz
)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_connection bank_connections%rowtype;
begin
  select * into v_connection from bank_connections where id = p_connection_id and organization_id = p_organization_id for update;
  if v_connection.id is null then
    return 'NOT_FOUND';
  end if;
  if v_connection.status <> p_expected_status then
    return 'STATUS_CHANGED';
  end if;
  if p_event_at is not null and v_connection.last_provider_event_at is not null and p_event_at <= v_connection.last_provider_event_at then
    return 'STALE';
  end if;
  if p_to = 'DISCONNECTED' then
    return 'ILLEGAL';
  end if;
  if p_to = v_connection.status then
    if p_event_at is not null then
      update bank_connections set last_provider_event_at = p_event_at where id = v_connection.id;
    end if;
    return 'UNCHANGED';
  end if;

  begin
    update bank_connections
       set status = p_to, status_reason = p_reason, last_provider_event_at = coalesce(p_event_at, last_provider_event_at)
     where id = v_connection.id;
  exception when check_violation then
    return 'ILLEGAL';
  end;
  return 'APPLIED';
end;
$$;

-- Links an external account to a Countorra account, or ignores it, and puts
-- everything that was waiting on that decision back in line for
-- reconciliation. Returns APPLIED or a refusal code.
create or replace function bank_link_account(p_organization_id uuid, p_linked_account_id uuid, p_account_id uuid, p_import_mode text, p_actor uuid)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_link bank_linked_accounts%rowtype;
  v_connection_status text;
  v_account accounts%rowtype;
  v_has_history boolean;
begin
  select * into v_link from bank_linked_accounts where id = p_linked_account_id and organization_id = p_organization_id for update;
  if v_link.id is null then
    return 'NOT_FOUND';
  end if;
  select status into v_connection_status from bank_connections where id = v_link.connection_id for update;
  if v_link.detached_at is not null or v_connection_status = 'DISCONNECTED' then
    return 'DETACHED';
  end if;

  v_has_history := exists (select 1 from bank_external_transactions e where e.linked_account_id = v_link.id and e.ledger_linked_at is not null);

  if p_import_mode = 'IMPORT' then
    if p_account_id is null then
      return 'INVALID';
    end if;
    select * into v_account from accounts where id = p_account_id and organization_id = p_organization_id;
    if v_account.id is null then
      return 'NOT_FOUND';
    end if;
    if v_link.currency is null then
      return 'CURRENCY_UNKNOWN';
    end if;
    if v_account.currency <> v_link.currency then
      return 'CURRENCY_MISMATCH';
    end if;
    if v_link.account_id is not null and v_link.account_id <> p_account_id and v_has_history then
      return 'HAS_IMPORTED_HISTORY';
    end if;
    if exists (select 1 from bank_linked_accounts o where o.account_id = p_account_id and o.detached_at is null and o.id <> v_link.id) then
      return 'ACCOUNT_ALREADY_LINKED';
    end if;
    update bank_linked_accounts
       set account_id = p_account_id, import_mode = 'IMPORT', linked_by = p_actor,
           linked_at = case when account_id is distinct from p_account_id then now() else linked_at end
     where id = v_link.id;
  elsif p_import_mode = 'IGNORE' then
    update bank_linked_accounts
       set import_mode = 'IGNORE',
           account_id = case when v_has_history then account_id else null end
     where id = v_link.id;
  else
    return 'INVALID';
  end if;

  update bank_external_transactions
     set needs_reconciliation = true
   where linked_account_id = v_link.id
     and ledger_linked_at is null
     and reconciliation_state in ('UNRECONCILED', 'AWAITING_ACCOUNT_LINK', 'IGNORED', 'CURRENCY_MISMATCH');

  return 'APPLIED';
end;
$$;

-- Disconnects a connection. The caller has already destroyed the credential in
-- the secret store; this removes the reference, cancels every active job,
-- detaches the external accounts and records who disconnected, in one
-- transaction. Imported ledger transactions and bank history are untouched.
create or replace function bank_finalize_disconnect(p_organization_id uuid, p_connection_id uuid, p_actor uuid)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_connection bank_connections%rowtype;
begin
  select * into v_connection from bank_connections where id = p_connection_id and organization_id = p_organization_id for update;
  if v_connection.id is null then
    return 'NOT_FOUND';
  end if;
  if v_connection.status = 'DISCONNECTED' then
    return 'ALREADY_DISCONNECTED';
  end if;

  delete from bank_connection_credentials where connection_id = v_connection.id;
  update bank_sync_runs set status = 'CANCELLED', completed_at = now() where connection_id = v_connection.id and status = 'RUNNING';
  update bank_sync_jobs
     set status = 'CANCELLED', completed_at = now(), lease_expires_at = null, next_attempt_at = null, failure_category = null
   where connection_id = v_connection.id and status in ('QUEUED', 'RUNNING', 'RETRYABLE');
  update bank_linked_accounts set detached_at = now() where connection_id = v_connection.id and detached_at is null;
  update bank_connections
     set status = 'DISCONNECTED', status_reason = 'USER_DISCONNECTED', disconnected_at = now(), disconnected_by = p_actor,
         committed_cursor = null, page_cursor = null
   where id = v_connection.id;

  return v_connection.status;
end;
$$;

-- Creates a sync job, or explains why not. Returns (job_id, outcome) where
-- outcome is CREATED | DUPLICATE | ALREADY_ACTIVE | CONNECTION_DISCONNECTED | NOT_FOUND.
create or replace function bank_enqueue_sync_job(
  p_organization_id uuid,
  p_connection_id uuid,
  p_trigger text,
  p_idempotency_key text,
  p_requested_by uuid,
  p_webhook_event_id uuid
)
returns table (job_id uuid, outcome text)
language plpgsql
set search_path = public
as $$
declare
  v_status text;
  v_id uuid;
begin
  select status into v_status from bank_connections where id = p_connection_id and organization_id = p_organization_id for update;
  if v_status is null then
    return query select null::uuid, 'NOT_FOUND'::text;
    return;
  end if;
  if v_status = 'DISCONNECTED' then
    return query select null::uuid, 'CONNECTION_DISCONNECTED'::text;
    return;
  end if;

  select j.id into v_id from bank_sync_jobs j where j.organization_id = p_organization_id and j.idempotency_key = p_idempotency_key;
  if v_id is not null then
    return query select v_id, 'DUPLICATE'::text;
    return;
  end if;
  select j.id into v_id from bank_sync_jobs j where j.connection_id = p_connection_id and j.status in ('QUEUED', 'RUNNING', 'RETRYABLE');
  if v_id is not null then
    return query select v_id, 'ALREADY_ACTIVE'::text;
    return;
  end if;

  insert into bank_sync_jobs (organization_id, connection_id, trigger, idempotency_key, requested_by, webhook_event_id)
  values (p_organization_id, p_connection_id, p_trigger, p_idempotency_key, p_requested_by, p_webhook_event_id)
  returning id into v_id;
  return query select v_id, 'CREATED'::text;
end;
$$;

-- Claims a verified webhook event for processing. A new event is recorded and
-- claimed; a FAILED one, or one abandoned mid-processing, is re-claimed while
-- attempts remain; anything else is a duplicate. `payload_matches` is false
-- when a redelivery carries a different body under the same event id.
create or replace function bank_claim_webhook_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_provider_event_type text,
  p_provider_connection_id text,
  p_occurred_at timestamptz,
  p_payload_sha256 text,
  p_lease_seconds int
)
returns table (event_id uuid, claimed boolean, status text, payload_matches boolean)
language plpgsql
set search_path = public
as $$
declare
  v_event bank_webhook_events%rowtype;
  v_id uuid;
begin
  insert into bank_webhook_events (provider, provider_event_id, event_type, provider_event_type, provider_connection_id, occurred_at, payload_sha256)
  values (p_provider, p_provider_event_id, p_event_type, p_provider_event_type, p_provider_connection_id, p_occurred_at, p_payload_sha256)
  on conflict (provider, provider_event_id) do nothing
  returning id into v_id;

  if v_id is not null then
    update bank_webhook_events set status = 'PROCESSING', attempts = 1, processing_started_at = now() where id = v_id;
    return query select v_id, true, 'PROCESSING'::text, true;
    return;
  end if;

  select * into v_event from bank_webhook_events e where e.provider = p_provider and e.provider_event_id = p_provider_event_id for update;
  if v_event.attempts < v_event.max_attempts and (
    v_event.status = 'FAILED'
    or (v_event.status = 'PROCESSING' and v_event.processing_started_at < now() - make_interval(secs => greatest(30, coalesce(p_lease_seconds, 120))))
  ) and v_event.payload_sha256 = p_payload_sha256 then
    update bank_webhook_events
       set status = 'PROCESSING', attempts = attempts + 1, processing_started_at = now(), failure_category = null
     where id = v_event.id;
    return query select v_event.id, true, 'PROCESSING'::text, true;
    return;
  end if;

  return query select v_event.id, false, v_event.status, v_event.payload_sha256 = p_payload_sha256;
end;
$$;

create or replace function bank_complete_webhook_event(
  p_event_id uuid,
  p_status text,
  p_outcome text,
  p_failure_category text,
  p_organization_id uuid,
  p_connection_id uuid
)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_status text;
begin
  select e.status into v_status from bank_webhook_events e where e.id = p_event_id for update;
  if v_status is null then
    return 'NOT_FOUND';
  end if;
  if v_status <> 'PROCESSING' then
    return 'NOT_PROCESSING';
  end if;
  update bank_webhook_events
     set status = p_status,
         outcome = p_outcome,
         failure_category = case when p_status = 'FAILED' then coalesce(p_failure_category, 'INTERNAL_ERROR') else null end,
         processed_at = case when p_status in ('PROCESSED', 'IGNORED') then now() else processed_at end,
         organization_id = coalesce(organization_id, p_organization_id),
         connection_id = coalesce(connection_id, p_connection_id)
   where id = p_event_id;
  return 'APPLIED';
end;
$$;

-- None of these is callable from a browser session.
revoke execute on function bank__record_revision(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function bank__supersede_pending(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function bank_claim_sync_job(uuid, uuid, int) from public, anon, authenticated;
revoke execute on function bank_ingest_sync_page(uuid, uuid, text, text, boolean, jsonb, jsonb, jsonb, int, int) from public, anon, authenticated;
revoke execute on function bank_reset_page_cursor(uuid, uuid) from public, anon, authenticated;
revoke execute on function bank_match_candidates(uuid, uuid, transaction_kind, bigint, text, date, date) from public, anon, authenticated;
revoke execute on function bank_reconcile_transaction(uuid, uuid, int, jsonb, uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function bank_complete_sync_run(uuid, uuid, text, text, timestamptz, boolean, int) from public, anon, authenticated;
revoke execute on function bank_transition_connection(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function bank_link_account(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
revoke execute on function bank_finalize_disconnect(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function bank_enqueue_sync_job(uuid, uuid, text, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function bank_claim_webhook_event(text, text, text, text, text, timestamptz, text, int) from public, anon, authenticated;
revoke execute on function bank_complete_webhook_event(uuid, text, text, text, uuid, uuid) from public, anon, authenticated;

grant execute on function bank__record_revision(uuid, text, uuid, uuid) to service_role;
grant execute on function bank__supersede_pending(uuid, text, uuid, uuid) to service_role;
grant execute on function bank_claim_sync_job(uuid, uuid, int) to service_role;
grant execute on function bank_ingest_sync_page(uuid, uuid, text, text, boolean, jsonb, jsonb, jsonb, int, int) to service_role;
grant execute on function bank_reset_page_cursor(uuid, uuid) to service_role;
grant execute on function bank_match_candidates(uuid, uuid, transaction_kind, bigint, text, date, date) to service_role;
grant execute on function bank_reconcile_transaction(uuid, uuid, int, jsonb, uuid, uuid, boolean) to service_role;
grant execute on function bank_complete_sync_run(uuid, uuid, text, text, timestamptz, boolean, int) to service_role;
grant execute on function bank_transition_connection(uuid, uuid, text, text, text, timestamptz) to service_role;
grant execute on function bank_link_account(uuid, uuid, uuid, text, uuid) to service_role;
grant execute on function bank_finalize_disconnect(uuid, uuid, uuid) to service_role;
grant execute on function bank_enqueue_sync_job(uuid, uuid, text, text, uuid, uuid) to service_role;
grant execute on function bank_claim_webhook_event(text, text, text, text, text, timestamptz, text, int) to service_role;
grant execute on function bank_complete_webhook_event(uuid, text, text, text, uuid, uuid) to service_role;

-- ── 9. Row-level security and privileges ────────────────────────────────

alter table bank_connections enable row level security;
alter table bank_connection_credentials enable row level security;
alter table bank_linked_accounts enable row level security;
alter table bank_webhook_events enable row level security;
alter table bank_sync_jobs enable row level security;
alter table bank_sync_runs enable row level security;
alter table bank_external_transactions enable row level security;
alter table bank_transaction_revisions enable row level security;

create policy bank_connections_select_member on bank_connections
  for select using (is_org_member(organization_id));
create policy bank_linked_accounts_select_member on bank_linked_accounts
  for select using (is_org_member(organization_id));
create policy bank_sync_jobs_select_member on bank_sync_jobs
  for select using (is_org_member(organization_id));
create policy bank_sync_runs_select_member on bank_sync_runs
  for select using (is_org_member(organization_id));
create policy bank_external_transactions_select_member on bank_external_transactions
  for select using (is_org_member(organization_id));
create policy bank_transaction_revisions_select_member on bank_transaction_revisions
  for select using (is_org_member(organization_id));
-- bank_connection_credentials and bank_webhook_events: no member policy.

-- Default privileges (0023) grant every new table to anon and authenticated.
-- Take all of it back, then grant members SELECT on the columns they need.
revoke all on bank_connections, bank_connection_credentials, bank_linked_accounts, bank_webhook_events,
  bank_sync_jobs, bank_sync_runs, bank_external_transactions, bank_transaction_revisions from anon, authenticated;

grant select (id, organization_id, provider, institution_name, status, status_reason, status_changed_at, consecutive_failed_runs,
  last_failure_category, last_successful_sync_at, last_sync_attempt_at, disconnected_at, created_at, updated_at)
  on bank_connections to authenticated;

grant select (id, organization_id, connection_id, account_id, import_mode, account_type, account_subtype, display_name, mask, currency,
  current_balance_minor, available_balance_minor, balances_as_of, provider_state, linked_at, detached_at, created_at, updated_at)
  on bank_linked_accounts to authenticated;

grant select (id, organization_id, connection_id, status, trigger, attempts, max_attempts, next_attempt_at, failure_category,
  started_at, completed_at, created_at, updated_at)
  on bank_sync_jobs to authenticated;

grant select on bank_sync_runs to authenticated;

grant select (id, organization_id, connection_id, linked_account_id, status, direction, amount_decimal, amount_minor, currency,
  transaction_date, posted_date, authorized_date, merchant_name, description, category_hint, revision, superseded_by_id,
  reconciliation_state, review_reason, ledger_transaction_id, ledger_link_kind, ledger_linked_at, removed_at, created_at, updated_at)
  on bank_external_transactions to authenticated;

grant select on bank_transaction_revisions to authenticated;

grant select, insert, update, delete on bank_connections, bank_connection_credentials, bank_linked_accounts, bank_webhook_events,
  bank_sync_jobs, bank_sync_runs, bank_external_transactions, bank_transaction_revisions to service_role;
