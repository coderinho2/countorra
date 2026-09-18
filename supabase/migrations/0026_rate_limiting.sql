-- Application-level rate limiting. The last blocking item from the security
-- audit and the live verification.
--
-- WHY POSTGRES, AND NOT A MAP OR A NEW VENDOR
--
-- A rate limiter is only a control if every instance of the app shares it.
-- An in-process Map is not a limiter in any deployment that can scale past
-- one process — and this app has no deployment config pinning it to one, so
-- it must be assumed it can (serverless, or several containers behind a load
-- balancer). Equally, adding Redis/Upstash would introduce a vendor and a
-- secret that are NOT configured on this project, which would mean shipping
-- something that only *looks* protected until an operator wires it up.
--
-- Postgres is already the shared, durable, transactional store every instance
-- talks to. It gives us the one property that actually matters here for free:
-- `insert … on conflict do update … returning` is a single atomic statement
-- under row locking, so the check-then-increment race the audit already found
-- twice in this codebase (AI action execution, AI usage metering) cannot
-- reappear in the limiter itself.
--
-- AUTHORIZATION BOUNDARY
--
-- Counters are never client-writable. `rate_limit_counters` has RLS enabled
-- with ZERO policies and no grants to `anon`/`authenticated` — the same
-- default-deny shape `audit_logs` and `notifications` already use. The only
-- way in is `consume_rate_limit()`, SECURITY DEFINER, granted solely to
-- `service_role`, which is reachable only from server-only code
-- (src/server/security/rate-limit.ts). That matters beyond tidiness: if a
-- client could increment a counter, it could burn *another* account's login
-- budget and lock them out — the limiter would become the denial-of-service.

create table rate_limit_counters (
  -- The scope of the limit ("auth:login:ip", "ai:message:user", …). Kept as a
  -- separate column rather than folded into the key so limits can be reasoned
  -- about, and pruned, per namespace.
  namespace text not null,
  -- A salted HMAC of the identifier, never the identifier itself. The
  -- application never sends a raw email or IP address here; see
  -- src/server/security/rate-limit.ts. Storing the hash means this table is
  -- not a list of "every email that has ever tried to log in", which for a
  -- financial product is a meaningful difference.
  key_hash text not null,
  -- Fixed-window bucketing: the identity of the window is part of the primary
  -- key, so a new window is a new row and expiry needs no separate reset.
  window_start timestamptz not null,
  count integer not null default 0,
  expires_at timestamptz not null,
  primary key (namespace, key_hash, window_start)
);

create index rate_limit_counters_expires_at_idx on rate_limit_counters (expires_at);

alter table rate_limit_counters enable row level security;
-- No policies, deliberately. Default-deny means no client role can read a
-- counter (which would leak whether an identifier is under attack) or write
-- one (which would let an attacker exhaust someone else's budget).

/**
 * Atomically consumes one unit from a fixed window and reports the outcome.
 *
 * The whole check lives in ONE statement on purpose. The alternative shape —
 * select the count, compare it in application code, then update — is the
 * exact TOCTOU pattern this audit already found in `confirmAiAction` and in
 * AI usage metering, and it fails in precisely the case a limiter exists for:
 * a burst of simultaneous requests, where every one of them reads the same
 * under-limit value and every one of them proceeds.
 *
 * Blocked attempts still increment. A retry storm therefore keeps the window
 * saturated rather than letting an attacker probe the boundary for free; the
 * window still rolls over normally, so a legitimate user is never locked out
 * for longer than `p_window_seconds`.
 */
create or replace function consume_rate_limit(
  p_namespace text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_expires_at timestamptz;
  v_count integer;
begin
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'consume_rate_limit: limit and window must be positive';
  end if;

  -- Align to a deterministic window boundary so every instance agrees on
  -- which window a given instant belongs to, without coordinating.
  v_window_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);
  v_expires_at := v_window_start + make_interval(secs => p_window_seconds);

  insert into rate_limit_counters as c (namespace, key_hash, window_start, count, expires_at)
  values (p_namespace, p_key_hash, v_window_start, 1, v_expires_at)
  on conflict (namespace, key_hash, window_start)
  do update set count = c.count + 1
  returning c.count into v_count;

  -- Opportunistic pruning: no scheduler is guaranteed on this project
  -- (pg_cron is not enabled), so the table keeps itself small by cleaning up
  -- on roughly one call in a hundred. Cheap, index-backed, and it cannot grow
  -- unboundedly between calls because the only thing that creates rows is
  -- this function.
  if random() < 0.01 then
    delete from rate_limit_counters where expires_at < clock_timestamp() - interval '1 hour';
  end if;

  return query select
    v_count <= p_limit,
    greatest(p_limit - v_count, 0),
    case
      when v_count <= p_limit then 0
      else greatest(ceil(extract(epoch from (v_expires_at - clock_timestamp())))::integer, 1)
    end;
end;
$$;

-- Server-only. Not granted to `anon` or `authenticated`, and revoked from
-- PUBLIC because Postgres grants EXECUTE to PUBLIC by default on every new
-- function — the same trap 0024 had to correct for the org_id_of_* helpers.
revoke execute on function consume_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function consume_rate_limit(text, text, integer, integer) to service_role;

-- Same treatment for the table itself: 0023 grants table privileges to
-- `authenticated` by default for every new table, which would let a client
-- attempt a write and rely on RLS alone to stop it. Counters get neither.
revoke all on table rate_limit_counters from anon, authenticated;
grant all on table rate_limit_counters to service_role;
