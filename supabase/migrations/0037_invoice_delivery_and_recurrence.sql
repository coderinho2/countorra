-- Invoicing: the lifecycle an invoice actually has once it leaves the app.
--
-- WHAT WAS MISSING
--
-- `invoices` could be created and its status changed, and that was all. There
-- was no record of when it was sent, no way for the customer to see it, and
-- no representation of an invoice that repeats. An invoicing product that
-- cannot deliver an invoice is a table with a form on it.
--
-- THE PUBLIC TOKEN IS A CAPABILITY, NOT AN ID
--
-- A customer has no account here. They click a link in an email, and that
-- link has to be sufficient on its own — so the token IS the authorization.
-- That puts two requirements on it:
--
--   * It must be unguessable. 32 random bytes, not the invoice's uuid: a
--     uuid is an identifier that appears in logs, URLs and error messages,
--     and reusing one as a secret makes every place it leaks a disclosure.
--   * It must be revocable independently of the invoice, which is why it is
--     its own nullable column rather than derived. Clearing it kills the
--     link without touching the record.
--
-- OVERDUE IS DERIVED, NOT STORED
--
-- `invoice_status` has an 'overdue' value from 0001 and nothing writes it.
-- That is deliberate and stays: "overdue" is a function of the due date and
-- today, so storing it needs a scheduled job to keep it true, and a stale
-- 'overdue' row is a false statement about someone's money. It is computed
-- at read time by `deriveInvoiceState` (src/domain/invoicing/lifecycle.ts).

alter table invoices
  add column sent_at timestamptz,
  add column paid_at timestamptz,
  add column voided_at timestamptz,
  add column last_reminder_at timestamptz,
  add column public_token text,
  -- Set only when a payment provider is connected and a link has really been
  -- created. Never populated with a placeholder: a "Pay" button that leads
  -- nowhere is worse than no button. Stripe is not wired to this yet.
  add column payment_url text,
  add column recurrence_id uuid;

comment on column invoices.public_token is
  'Unguessable capability for the customer-facing view. NULL means no link has been issued, or it was revoked. Never derived from the invoice id.';
comment on column invoices.payment_url is
  'A real provider-issued payment link, or NULL. Populated only by a configured payment integration.';

create unique index invoices_public_token_key on invoices (public_token) where public_token is not null;
create index invoices_due_date_idx on invoices (organization_id, due_date) where due_date is not null;

-- ── Recurrence ──────────────────────────────────────────────────────────
--
-- A recurrence is a TEMPLATE that issues invoices; it is not an invoice. The
-- separation matters: editing the template must not rewrite invoices already
-- sent to a customer, and each issued invoice keeps its own immutable totals.
create type recurrence_interval as enum ('weekly', 'monthly', 'quarterly', 'yearly');
create type recurrence_status as enum ('active', 'paused', 'ended');

create table invoice_recurrences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  customer_id uuid not null references customers (id) on delete restrict,
  currency char(3) not null,
  interval recurrence_interval not null,
  /** Every N intervals — `monthly` with 3 is quarterly by another name, and
   *  both are expressible so the UI can offer whichever reads better. */
  interval_count int not null default 1 check (interval_count between 1 and 24),
  /** Days after issue that the generated invoice is due. NULL = no due date. */
  due_days int check (due_days is null or due_days between 0 and 365),
  /** The line items each generated invoice starts from. Stored as data
   *  rather than as rows because they are a template: they have no invoice
   *  to belong to until one is issued. */
  line_items jsonb not null,
  notes text,
  status recurrence_status not null default 'active',
  /** The next date an invoice is due to be issued. Advanced only when one
   *  actually is, so a missed run catches up rather than skipping. */
  next_issue_date date not null,
  /** Stops an open-ended series. NULL = until paused. */
  ends_on date,
  last_generated_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoice_recurrences_ends_after_start check (ends_on is null or ends_on >= next_issue_date)
);

create index invoice_recurrences_organization_id_idx on invoice_recurrences (organization_id);
create index invoice_recurrences_due_idx on invoice_recurrences (next_issue_date) where status = 'active';

alter table invoices
  add constraint invoices_recurrence_id_fkey
  foreign key (recurrence_id) references invoice_recurrences (id) on delete set null;

create index invoices_recurrence_id_idx on invoices (recurrence_id) where recurrence_id is not null;

-- Same policy shape as `invoices` itself: members read, write-capable roles
-- create and edit, privileged roles delete. A recurrence commits the
-- organization to billing a customer repeatedly, so it is gated exactly as
-- the invoices it produces are.
alter table invoice_recurrences enable row level security;

create policy invoice_recurrences_select_member on invoice_recurrences
  for select using (is_org_member(organization_id));

create policy invoice_recurrences_insert_member on invoice_recurrences
  for insert with check (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy invoice_recurrences_update_member on invoice_recurrences
  for update using (is_org_role(organization_id, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[]));

create policy invoice_recurrences_delete_privileged on invoice_recurrences
  for delete using (is_org_role(organization_id, array['owner', 'admin', 'accountant']::org_role[]));

create trigger invoice_recurrences_set_updated_at
  before update on invoice_recurrences
  for each row execute function set_updated_at();

-- ── Reading one invoice by its public token ─────────────────────────────
--
-- The customer-facing page has NO session, so it cannot satisfy any
-- `is_org_member` policy and must not use the service role either — that
-- would hand an unauthenticated route a client that can read every
-- organization's data, and one bug away from a cross-tenant leak.
--
-- This function is the narrow alternative: SECURITY DEFINER, takes a token
-- and returns AT MOST the one invoice it unlocks, with only the fields the
-- customer needs. Nothing else in the schema becomes reachable.
create or replace function invoice_by_public_token(p_token text)
returns table (
  id uuid,
  organization_id uuid,
  organization_name text,
  invoice_number text,
  status invoice_status,
  currency char(3),
  issue_date date,
  due_date date,
  subtotal_minor bigint,
  tax_minor bigint,
  total_minor bigint,
  notes text,
  payment_url text,
  customer_name text,
  sent_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    i.id,
    i.organization_id,
    o.name as organization_name,
    i.invoice_number,
    i.status,
    i.currency,
    i.issue_date,
    i.due_date,
    i.subtotal_minor,
    i.tax_minor,
    i.total_minor,
    i.notes,
    i.payment_url,
    c.display_name as customer_name,
    i.sent_at
  from invoices i
  join organizations o on o.id = i.organization_id
  join customers c on c.id = i.customer_id
  where i.public_token = p_token
    and p_token is not null
    and length(p_token) >= 32
    -- A draft has not been sent to anybody. Even holding a token, there is
    -- nothing to show: it is not yet a claim on the customer's money.
    and i.status <> 'draft'
  limit 1;
$$;

create or replace function invoice_line_items_by_public_token(p_token text)
returns table (
  -- Quoted: `position` is a reserved word in a RETURNS TABLE column list,
  -- even though CREATE TABLE accepts it unquoted.
  "position" int,
  description text,
  quantity numeric,
  unit_price_minor bigint,
  tax_rate numeric,
  amount_minor bigint
)
language sql
security definer
set search_path = public
as $$
  select li."position", li.description, li.quantity, li.unit_price_minor, li.tax_rate, li.amount_minor
  from invoice_line_items li
  join invoices i on i.id = li.invoice_id
  where i.public_token = p_token
    and p_token is not null
    and length(p_token) >= 32
    and i.status <> 'draft'
  order by li."position";
$$;

-- Readable by an anonymous visitor, which is the entire point. The function
-- body is the access control.
grant execute on function invoice_by_public_token(text) to anon, authenticated, service_role;
grant execute on function invoice_line_items_by_public_token(text) to anon, authenticated, service_role;
