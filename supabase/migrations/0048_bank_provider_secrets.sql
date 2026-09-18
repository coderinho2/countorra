-- Provider credentials, encrypted at rest.
--
-- Task 11 designed the boundary and left it empty on purpose: there was no
-- provider, so there was nothing to store, and `configuredSecretStore()`
-- returned null. Task 12 connects Plaid, which issues an access token that
-- grants ongoing read access to somebody's bank account — so the store has to
-- exist before a single real credential is accepted.
--
-- WHAT IS AND IS NOT HERE
--
-- `bank_connection_credentials` (0047) still holds only a REFERENCE
-- (`enc:<uuid>`), in a table members may not read. This table holds the
-- ciphertext that reference points at: AES-256-GCM from node's crypto, with a
-- random 96-bit IV, the authentication tag kept, and the organization and
-- connection bound in as additional authenticated data
-- (src/server/bank-connections/credential-crypto.ts). Moving a row to another
-- connection therefore makes it undecryptable instead of making one tenant's
-- token usable for another's connection.
--
-- The key lives in BANK_CREDENTIAL_ENCRYPTION_KEY, never in the database, so a
-- database dump on its own decrypts nothing. `key_id` records which key a row
-- needs, which is what makes rotation possible without a flag day.
--
-- WHO CAN READ IT: nothing reachable from a browser. RLS is on with no policy
-- at all, every privilege is revoked from `anon` and `authenticated`, and only
-- the service role — used exclusively by server code in
-- src/server/bank-connections — can select, insert, update or delete.

create table bank_provider_secrets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  connection_id uuid not null,
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),

  /** Which key in BANK_CREDENTIAL_ENCRYPTION_KEY this row needs. */
  key_id text not null check (key_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  algorithm text not null check (algorithm = 'AES-256-GCM'),
  /** 12 raw bytes, base64 — exactly 16 characters, unpadded. */
  iv text not null check (iv ~ '^[A-Za-z0-9+/]{16}$'),
  ciphertext text not null check (char_length(ciphertext) between 8 and 8192 and ciphertext ~ '^[A-Za-z0-9+/=]+$'),
  /** 16 raw bytes, base64. */
  auth_tag text not null check (auth_tag ~ '^[A-Za-z0-9+/]{22}==$'),

  created_at timestamptz not null default now(),
  rotated_at timestamptz,

  constraint bank_provider_secrets_connection_fkey
    foreign key (connection_id, organization_id) references bank_connections (id, organization_id) on delete cascade,
  -- One credential per connection: re-linking rotates the row rather than
  -- leaving an older token behind that nothing would ever destroy.
  constraint bank_provider_secrets_one_per_connection unique (connection_id),
  -- Defence in depth against a future bug that stores a token unencrypted:
  -- a Plaid access token's own shape is refused outright.
  constraint bank_provider_secrets_looks_encrypted
    check (ciphertext !~* '(access|public|link|processor)-(sandbox|development|production)')
);

create index bank_provider_secrets_organization_idx on bank_provider_secrets (organization_id);

comment on table bank_provider_secrets is
  'Encrypted provider credentials (AES-256-GCM). The key is in the environment, never here. Service role only: no RLS policy exists and every privilege is revoked from anon and authenticated.';

create or replace function bank_provider_secrets_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.organization_id <> old.organization_id or new.connection_id <> old.connection_id or new.created_at <> old.created_at then
      raise exception 'a stored credential belongs to one connection' using errcode = 'check_violation';
    end if;
    -- Replacing the ciphertext is a rotation, and says when.
    if (new.ciphertext <> old.ciphertext or new.key_id <> old.key_id) and new.rotated_at is not distinct from old.rotated_at then
      raise exception 'rotating a stored credential records when it happened' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if not exists (select 1 from bank_connections c where c.id = new.connection_id and c.organization_id = new.organization_id and c.provider = new.provider and c.status <> 'DISCONNECTED') then
    raise exception 'a credential can only be stored for a live connection of the same provider' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger bank_provider_secrets_guard
  before insert or update or delete on bank_provider_secrets
  for each row execute function bank_provider_secrets_guard();

alter table bank_provider_secrets enable row level security;
revoke all on bank_provider_secrets from anon, authenticated;
grant select, insert, update, delete on bank_provider_secrets to service_role;

-- ── Which of the provider's environments a connection came from ─────────
--
-- Plaid has a sandbox and a production environment with different credentials
-- and entirely different data. A workspace could hold connections made against
-- either, and telling them apart matters: sandbox transactions are fictional,
-- and nothing should ever present them as somebody's real money. Recorded at
-- link time from the adapter, never from the browser, and never changed
-- afterwards (the guard in 0047 already refuses an update that changes
-- anything but a connection's status).

alter table bank_connections
  add column provider_environment text check (provider_environment is null or provider_environment ~ '^[a-z][a-z0-9_-]{1,31}$');

comment on column bank_connections.provider_environment is
  'The provider environment this connection was created against (Plaid: sandbox | production). Null for connections made before this column existed.';

grant select (provider_environment) on bank_connections to authenticated;

-- Provenance, so it cannot be rewritten. The guard in 0047 lets the sync
-- engine update cursors, counters and timestamps on a connection; this makes
-- sure the environment is not one of them. Relabelling sandbox data as
-- production — by a bug or by hand — would turn fictional transactions into
-- somebody's apparent money.
create or replace function bank_connections_environment_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.provider_environment is distinct from old.provider_environment then
    raise exception 'a bank connection''s provider environment cannot change' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger bank_connections_environment_guard
  before update on bank_connections
  for each row execute function bank_connections_environment_guard();
