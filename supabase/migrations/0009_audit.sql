-- Audit logging (DESIGN brief §16): append-only by construction, not just
-- by convention. `audit_logs` has no `updated_at` and no application code
-- path that updates or deletes a row — enforced below by a trigger that
-- rejects UPDATE/DELETE outright, independent of whatever RLS policies
-- exist. This is deliberately redundant with RLS (0011): a table's RLS
-- policies protect it from a misused anon/authenticated role, but a bug in
-- a future SECURITY DEFINER function or a service-role script could still
-- issue an UPDATE — the trigger closes that gap at the table level itself.

create table audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references organizations (id) on delete set null,
  actor_id uuid references auth.users (id),
  actor_type text not null default 'user' check (actor_type in ('user', 'ai', 'system')),
  action text not null,
  resource_type text,
  resource_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);

create index audit_logs_organization_id_idx on audit_logs (organization_id, created_at desc);
create index audit_logs_actor_id_idx on audit_logs (actor_id);

create or replace function reject_audit_log_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_logs is append-only: % is not permitted', tg_op;
end;
$$;

create trigger audit_logs_no_update
  before update on audit_logs
  for each row execute function reject_audit_log_mutation();

create trigger audit_logs_no_delete
  before delete on audit_logs
  for each row execute function reject_audit_log_mutation();

-- The only sanctioned way to write an audit row: SECURITY DEFINER, so
-- normal application code (running as `authenticated`, subject to RLS)
-- can still record events even though its RLS policy on audit_logs is
-- select-only. src/domain/audit calls this via an RPC rather than an
-- INSERT through the ORM/query builder.
create or replace function record_audit_event(
  p_organization_id uuid,
  p_action text,
  p_resource_type text default null,
  p_resource_id uuid default null,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_type text default 'user'
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into audit_logs (organization_id, actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (p_organization_id, auth.uid(), p_actor_type, p_action, p_resource_type, p_resource_id, p_metadata)
  returning id into v_id;

  return v_id;
end;
$$;

create table security_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  user_id uuid references auth.users (id),
  organization_id uuid references organizations (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index security_events_created_at_idx on security_events (created_at desc);

create trigger security_events_no_update
  before update on security_events
  for each row execute function reject_audit_log_mutation();

create trigger security_events_no_delete
  before delete on security_events
  for each row execute function reject_audit_log_mutation();
