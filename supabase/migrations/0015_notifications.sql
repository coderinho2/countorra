-- Notifications (Phase 2 product spec §45). Rows are written by the same
-- deterministic detectors that populate `ai_insights` (overdue invoices,
-- anomalies, recurring-payment changes) — a notification is a
-- user-facing, dismissible pointer to something the system already
-- computed, not a new source of truth.

create type notification_kind as enum (
  'overdue_invoice',
  'unusual_transaction',
  'document_needs_review',
  'document_processing_failed',
  'financial_insight',
  'upcoming_bill',
  'ai_recommendation'
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  -- Null user_id = visible to every member of the organization (e.g. an
  -- overdue invoice matters to the whole team); set = targeted at one
  -- member. Read state is still tracked per-recipient (see read_by below).
  user_id uuid references auth.users (id),
  kind notification_kind not null,
  title text not null,
  body text,
  resource_type text,
  resource_id uuid,
  created_at timestamptz not null default now()
);

create index notifications_organization_id_idx on notifications (organization_id, created_at desc);
create index notifications_user_id_idx on notifications (user_id);

-- Read state is per-viewer even for an org-wide notification, so it can't
-- be a column on `notifications` itself — a second member marking it read
-- shouldn't hide it from the first.
create table notification_reads (
  notification_id uuid not null references notifications (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);

alter table notifications enable row level security;

create policy notifications_select_member on notifications
  for select using (
    is_org_member(organization_id)
    and (user_id is null or user_id = auth.uid())
  );

-- Notifications are system-generated (via the detectors, using the admin
-- client) — no client-facing insert/update/delete policy, mirroring the
-- audit_logs / plans pattern.

alter table notification_reads enable row level security;

create policy notification_reads_select_own on notification_reads
  for select using (user_id = auth.uid());

create policy notification_reads_insert_own on notification_reads
  for insert with check (user_id = auth.uid());
