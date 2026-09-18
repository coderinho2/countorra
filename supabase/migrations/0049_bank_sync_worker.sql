-- BANK SYNC WORKER AND SCHEDULER.
--
-- Task 11 built the job table, Task 12 built the Plaid adapter, and nothing
-- ran the jobs: `bank_claim_sync_job` can only claim a job whose id the caller
-- already knows, so a queued retry, a webhook's job and a continuation all sat
-- until somebody pressed a button. This migration adds the three database
-- operations a durable worker needs, and nothing else:
--
--   * bank_claim_next_sync_jobs — find and claim due jobs, atomically, with
--     FOR UPDATE SKIP LOCKED so concurrent workers never take the same job;
--   * bank_heartbeat_sync_job — extend a lease the caller still owns, and say
--     so plainly when it has lost it;
--   * bank_reclaim_expired_sync_leases — recover jobs abandoned by a crashed
--     worker, without waiting for somebody to ask for that job by id.
--
-- Plus the query the scheduler picks connections with, and the indexes that
-- make both bounded reads rather than scans.
--
-- WHAT IS NOT CHANGED
--
-- The job state machine, its guard, the retry limits, the 600-second lease,
-- the one-active-job index, the cursor rules and every reconciliation rule are
-- Task 11's and stay as they were. The claim transition is not reimplemented:
-- it moves into bank__claim_sync_job, and both the by-id and the batch entry
-- points call that one copy.

-- ── 1. Lease ownership ──────────────────────────────────────────────────
--
-- Which worker holds a running job. Deliberately NOT granted to members: it
-- names a process, which is this deployment's business and not a tenant's.

alter table bank_sync_jobs
  add column lease_owner text check (lease_owner is null or lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,63}$');

comment on column bank_sync_jobs.lease_owner is
  'The worker execution identity holding this job lease. Null for a job run inline by a request. Cleared automatically when the job stops running.';

-- ── 2. Indexes for the worker's two queries ─────────────────────────────
--
-- The claim query filters on the same predicate 0047's due index used, but
-- orders by when a job became due, so it needs that expression as its key:
-- otherwise a thousand queued jobs are sorted on every worker loop. The old
-- index is replaced rather than joined by a second one on the same predicate.

drop index if exists bank_sync_jobs_due_idx;

create index bank_sync_jobs_claimable_idx
  on bank_sync_jobs (coalesce(next_attempt_at, created_at), id)
  where status in ('QUEUED', 'RETRYABLE');

-- The stale-lease sweep reads only running jobs whose lease has run out.
create index bank_sync_jobs_lease_idx
  on bank_sync_jobs (lease_expires_at)
  where status = 'RUNNING';

-- The scheduler reads syncable connections, oldest attempt first.
create index bank_connections_schedulable_idx
  on bank_connections (coalesce(last_sync_attempt_at, created_at))
  where status in ('ACTIVE', 'DEGRADED');

-- ── 3. Guard: an expired lease cannot be renewed ────────────────────────
--
-- This closes the one hole in Task 11's lease handling. A worker whose lease
-- ran out could still commit pages, because ingestion renews the lease and
-- nothing checked whether the lease being renewed was still alive. Now it
-- cannot: the renewal raises, so the whole page — cursor move included — rolls
-- back, and the work is left to whoever legitimately holds the job next.
--
-- Otherwise this is 0047's function with one addition: a job that stops
-- running also stops owning a lease.

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
       or new.lease_expires_at is not null or new.lease_owner is not null or new.failure_category is not null then
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

  if new.status <> 'RUNNING' then
    new.lease_owner := null;
  end if;

  if new.id <> old.id or new.organization_id <> old.organization_id or new.connection_id <> old.connection_id or new.trigger <> old.trigger
     or new.idempotency_key <> old.idempotency_key or new.max_attempts <> old.max_attempts or new.created_at <> old.created_at then
    raise exception 'a bank sync job identity cannot change' using errcode = 'check_violation';
  end if;
  if new.requested_by is distinct from old.requested_by and not (new.requested_by is null and pg_trigger_depth() > 1) then
    raise exception 'bank_sync_jobs.requested_by cannot be changed' using errcode = 'check_violation';
  end if;
  if new.webhook_event_id is distinct from old.webhook_event_id and not (new.webhook_event_id is null and pg_trigger_depth() > 1) then
    raise exception 'bank_sync_jobs.webhook_event_id cannot be changed' using errcode = 'check_violation';
  end if;

  if new.status = old.status then
    if (to_jsonb(new) - 'requested_by' - 'webhook_event_id' - 'updated_at' - 'lease_expires_at') <> (to_jsonb(old) - 'requested_by' - 'webhook_event_id' - 'updated_at' - 'lease_expires_at')
       or (new.lease_expires_at is distinct from old.lease_expires_at and old.status <> 'RUNNING') then
      raise exception 'a bank sync job changes only by moving to another status' using errcode = 'check_violation';
    end if;
    if new.lease_expires_at is distinct from old.lease_expires_at and (old.lease_expires_at is null or old.lease_expires_at <= now()) then
      raise exception 'this sync job lease has expired and cannot be renewed' using errcode = 'check_violation';
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

-- ── 4. Recovering a job whose worker stopped ────────────────────────────
--
-- The run is failed with LEASE_EXPIRED and the job goes back in line while
-- attempts remain. LEASE_EXPIRED is this deployment's failure and not the
-- bank's, so it never counts against the connection's health.

create or replace function bank__reclaim_expired_lease(p_job_id uuid)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_job bank_sync_jobs%rowtype;
begin
  select * into v_job from bank_sync_jobs where id = p_job_id for update;
  if v_job.id is null then
    return 'NOT_FOUND';
  end if;
  if v_job.status <> 'RUNNING' or v_job.lease_expires_at is null or v_job.lease_expires_at > now() then
    return 'HELD';
  end if;

  update bank_sync_runs set status = 'FAILED', failure_category = 'LEASE_EXPIRED', completed_at = now()
   where job_id = v_job.id and status = 'RUNNING';

  if v_job.attempts < v_job.max_attempts then
    update bank_sync_jobs set status = 'RETRYABLE', failure_category = 'LEASE_EXPIRED', next_attempt_at = now(), lease_expires_at = null
     where id = v_job.id;
    return 'RETRYABLE';
  end if;

  update bank_sync_jobs set status = 'FAILED', failure_category = 'LEASE_EXPIRED', completed_at = now(), lease_expires_at = null
   where id = v_job.id;
  return 'FAILED';
end;
$$;

-- Sweeps abandoned jobs. Bounded, and SKIP LOCKED so two sweepers running at
-- once share the work rather than blocking on each other.

create or replace function bank_reclaim_expired_sync_leases(p_limit int)
returns int
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_reclaimed int := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'bank_reclaim_expired_sync_leases: limit must be between 1 and 500' using errcode = 'check_violation';
  end if;

  for v_id in
    select id from bank_sync_jobs
     where status = 'RUNNING' and lease_expires_at is not null and lease_expires_at <= now()
     order by lease_expires_at
     limit p_limit
     for update skip locked
  loop
    if bank__reclaim_expired_lease(v_id) in ('RETRYABLE', 'FAILED') then
      v_reclaimed := v_reclaimed + 1;
    end if;
  end loop;

  return v_reclaimed;
end;
$$;

-- ── 5. Claiming ─────────────────────────────────────────────────────────
--
-- 0047's claim, with the expired-lease recovery factored out and a worker
-- identity recorded. Behaviour is otherwise unchanged, and the by-id entry
-- point below calls exactly this.

create or replace function bank__claim_sync_job(p_organization_id uuid, p_job_id uuid, p_lease_seconds int, p_worker text)
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
    raise exception 'bank__claim_sync_job: lease must be between 30 and 3600 seconds' using errcode = 'check_violation';
  end if;
  if p_worker is not null and p_worker !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,63}$' then
    raise exception 'bank__claim_sync_job: a worker identity is 8 to 64 characters of A-Za-z0-9_.:-' using errcode = 'check_violation';
  end if;

  select * into v_job from bank_sync_jobs where id = p_job_id and organization_id = p_organization_id for update;
  if v_job.id is null then
    return null;
  end if;

  select status into v_connection_status from bank_connections where id = v_job.connection_id for update;

  if v_job.status = 'RUNNING' and v_job.lease_expires_at <= now() then
    if bank__reclaim_expired_lease(v_job.id) = 'FAILED' then
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
         lease_owner = p_worker, lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where id = v_job.id;
  update bank_connections set last_sync_attempt_at = now() where id = v_job.connection_id;

  insert into bank_sync_runs (organization_id, job_id, connection_id, attempt)
  values (p_organization_id, v_job.id, v_job.connection_id, v_job.attempts + 1)
  returning id into v_run_id;

  return v_run_id;
end;
$$;

create or replace function bank_claim_sync_job(p_organization_id uuid, p_job_id uuid, p_lease_seconds int)
returns uuid
language plpgsql
set search_path = public
as $$
begin
  return bank__claim_sync_job(p_organization_id, p_job_id, p_lease_seconds, null);
end;
$$;

-- Finds due jobs and claims them, one atomic claim per job.
--
-- FOR UPDATE SKIP LOCKED is what lets many workers run at once: a row another
-- worker is already claiming is passed over rather than waited for, so no
-- worker blocks and no job is taken twice. A job whose connection was
-- disconnected while it waited is cancelled by the claim and not returned,
-- which is also how the queue clears work that can no longer be done.

create or replace function bank_claim_next_sync_jobs(p_limit int, p_lease_seconds int, p_worker text)
returns table (job_id uuid, organization_id uuid, connection_id uuid, trigger text, attempt int, run_id uuid)
language plpgsql
set search_path = public
as $$
declare
  v_candidate record;
  v_run_id uuid;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'bank_claim_next_sync_jobs: limit must be between 1 and 100' using errcode = 'check_violation';
  end if;
  if p_worker is null then
    raise exception 'bank_claim_next_sync_jobs: a worker identity is required' using errcode = 'check_violation';
  end if;

  for v_candidate in
    select j.id, j.organization_id
      from bank_sync_jobs j
     where j.status in ('QUEUED', 'RETRYABLE')
       and (j.next_attempt_at is null or j.next_attempt_at <= now())
     order by coalesce(j.next_attempt_at, j.created_at), j.id
     limit p_limit
     for update skip locked
  loop
    v_run_id := bank__claim_sync_job(v_candidate.organization_id, v_candidate.id, p_lease_seconds, p_worker);
    if v_run_id is not null then
      return query
        select j.id, j.organization_id, j.connection_id, j.trigger, j.attempts, v_run_id
          from bank_sync_jobs j
         where j.id = v_candidate.id;
    end if;
  end loop;
end;
$$;

-- ── 6. Heartbeat ────────────────────────────────────────────────────────
--
-- Extends a lease the caller still holds, and answers LOST when it does not —
-- which is how a worker learns to stop before making a provider call or
-- writing anything. A lease that has already expired is never extended:
-- whoever reclaims the job owns it, not whoever held it last.

create or replace function bank_heartbeat_sync_job(p_organization_id uuid, p_run_id uuid, p_worker text, p_lease_seconds int)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_run record;
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'bank_heartbeat_sync_job: lease must be between 30 and 3600 seconds' using errcode = 'check_violation';
  end if;

  select r.id, r.status, r.job_id, j.status as job_status, j.lease_owner, j.lease_expires_at
    into v_run
    from bank_sync_runs r join bank_sync_jobs j on j.id = r.job_id
   where r.id = p_run_id and r.organization_id = p_organization_id
   for update of j;
  if v_run.id is null then
    return 'NOT_FOUND';
  end if;
  if v_run.status <> 'RUNNING' or v_run.job_status <> 'RUNNING'
     or v_run.lease_owner is distinct from p_worker
     or v_run.lease_expires_at is null or v_run.lease_expires_at <= now() then
    return 'LOST';
  end if;

  update bank_sync_jobs set lease_expires_at = now() + make_interval(secs => p_lease_seconds) where id = v_run.job_id;
  return 'EXTENDED';
end;
$$;

-- ── 7. What the scheduler may sync ──────────────────────────────────────
--
-- Connections whose imports are working (ACTIVE) or briefly unwell (DEGRADED,
-- which means the last import did not finish — a scheduled import IS the
-- retry), that nothing is already syncing, and whose last attempt is older
-- than the configured interval. Never a connection waiting for a person
-- (REQUIRES_REAUTH), stopped (ERROR), still being set up (PENDING) or gone
-- (DISCONNECTED). Bounded, and oldest-attempt-first so a large deployment
-- reaches every connection instead of starving the tail.

create or replace function bank_connections_due_for_sync(p_limit int, p_min_interval_seconds int)
returns table (connection_id uuid, organization_id uuid, provider text)
language sql
stable
set search_path = public
as $$
  select c.id, c.organization_id, c.provider
    from bank_connections c
   where c.status in ('ACTIVE', 'DEGRADED')
     and coalesce(c.last_sync_attempt_at, c.created_at) <= now() - make_interval(secs => greatest(coalesce(p_min_interval_seconds, 3600), 60))
     and not exists (
       select 1 from bank_sync_jobs j
        where j.connection_id = c.id and j.status in ('QUEUED', 'RUNNING', 'RETRYABLE')
     )
   order by coalesce(c.last_sync_attempt_at, c.created_at), c.id
   limit greatest(least(coalesce(p_limit, 50), 500), 1)
$$;

-- ── 8. Privileges ───────────────────────────────────────────────────────
--
-- 0023 grants EXECUTE on every new public function to anon and authenticated,
-- so each of these has to take it back. The worker runs as service_role only:
-- a browser must not be able to claim a job, extend a lease, or ask which
-- connections are due.

revoke execute on function bank__reclaim_expired_lease(uuid) from public, anon, authenticated;
revoke execute on function bank_reclaim_expired_sync_leases(int) from public, anon, authenticated;
revoke execute on function bank__claim_sync_job(uuid, uuid, int, text) from public, anon, authenticated;
revoke execute on function bank_claim_next_sync_jobs(int, int, text) from public, anon, authenticated;
revoke execute on function bank_heartbeat_sync_job(uuid, uuid, text, int) from public, anon, authenticated;
revoke execute on function bank_connections_due_for_sync(int, int) from public, anon, authenticated;

grant execute on function bank__reclaim_expired_lease(uuid) to service_role;
grant execute on function bank_reclaim_expired_sync_leases(int) to service_role;
grant execute on function bank__claim_sync_job(uuid, uuid, int, text) to service_role;
grant execute on function bank_claim_next_sync_jobs(int, int, text) to service_role;
grant execute on function bank_heartbeat_sync_job(uuid, uuid, text, int) to service_role;
grant execute on function bank_connections_due_for_sync(int, int) to service_role;
