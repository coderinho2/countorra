-- Outbound email: an audit trail of what was sent, and a suppression list.
--
-- WHY A LOG TABLE RATHER THAN FIRE-AND-FORGET
--
-- "Did my customer actually get this invoice?" is a question the product has
-- to be able to answer, and the provider's dashboard is the wrong place for
-- it: it is behind someone else's login, it is not tenant-scoped, and it
-- disappears when the provider changes. A row per attempt makes the answer
-- part of the organization's own data, and makes a failed send visible in the
-- product instead of only in a log aggregator.
--
-- WHY SUPPRESSION IS ADDRESS-LEVEL AND NOT TENANT-SCOPED
--
-- An unsubscribe belongs to the PERSON, not to the organization that mailed
-- them. Scoping it per organization would mean unsubscribing from one
-- workspace and still hearing from the next — which is exactly the behaviour
-- anti-spam law exists to prevent. The table is therefore global and has no
-- organization column, and is readable by nobody but the service role.
--
-- Transactional mail ignores this list entirely; see
-- `respectsSuppression` in src/domain/email/message.ts for why an invoice
-- must still arrive for someone who unsubscribed from digests.

create type email_status as enum ('queued', 'sent', 'failed', 'suppressed');

create table email_messages (
  id uuid primary key default gen_random_uuid(),
  -- Nullable: account and security emails belong to a person, not a
  -- workspace. Org-scoped rows are readable by that org's members; the rest
  -- are service-role only.
  organization_id uuid references organizations (id) on delete cascade,
  to_address text not null,
  category text not null,
  /** Which template produced this — 'invoice.new', 'invoice.reminder', ... */
  template text not null,
  subject text not null,
  status email_status not null default 'queued',
  provider text,
  provider_message_id text,
  attempts int not null default 0,
  /** A short reason code, never the provider's raw body: that echoes the
   *  recipient address and subject back into an audit row. */
  last_error text,
  /** What this message is about, so the UI can show "invoice sent" beside
   *  the invoice rather than in a separate list. */
  resource_type text,
  resource_id uuid,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index email_messages_organization_id_idx on email_messages (organization_id, created_at desc);
create index email_messages_resource_idx on email_messages (resource_type, resource_id, created_at desc);

alter table email_messages enable row level security;

-- Members may READ their organization's mail log — "was this invoice sent?"
-- is an ordinary product question. Nobody may write it: sends happen through
-- the service role, so a member cannot forge a delivery record.
create policy email_messages_select_member on email_messages
  for select using (organization_id is not null and is_org_member(organization_id));

grant select on email_messages to authenticated;
grant select, insert, update on email_messages to service_role;

create table email_suppressions (
  address text primary key,
  reason text not null,
  created_at timestamptz not null default now()
);

-- No policy for `authenticated` at all. The list is other people's
-- preferences: a member has no reason to read it, and enumerating it would
-- leak which addresses have interacted with the product.
alter table email_suppressions enable row level security;

revoke all on email_suppressions from anon, authenticated;
grant select, insert, delete on email_suppressions to service_role;
