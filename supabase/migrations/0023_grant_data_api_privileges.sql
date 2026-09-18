-- Fixes "permission denied for table X" (Postgres 42501) on every table in
-- this schema. RLS (0011_rls_policies.sql) is the real, row-level
-- authorization boundary, but Postgres requires a coarser table-level GRANT
-- before it even evaluates RLS policies — Supabase's own platform normally
-- adds these grants automatically the moment a table is created
-- (`auto_expose_new_tables`, see supabase/config.toml's [api] section,
-- "matching the cloud default"), but that did not take effect on this
-- project's tables, so `authenticated`/`anon` have never been able to
-- touch them at all, regardless of RLS.
--
-- This does NOT weaken authorization: every table below already has RLS
-- enabled with real per-tenant policies (0011), and append-only tables
-- (e.g. audit_log) are separately protected by their own triggers that
-- reject UPDATE/DELETE outright, independent of both RLS and these grants
-- (see the module comment in 0009_audit.sql). Granting table-level
-- privileges only restores the ability for RLS to run its normal
-- evaluation — a request that RLS would reject still gets zero rows /
-- a policy violation, exactly as before.
--
-- The final two ALTER DEFAULT PRIVILEGES statements make this self-healing
-- for any future migration that adds a new table, so this class of bug
-- cannot recur.

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant all on all tables in schema public to service_role;

grant usage, select on all sequences in schema public to anon, authenticated, service_role;

grant execute on all functions in schema public to anon, authenticated, service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant select on tables to anon;
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
