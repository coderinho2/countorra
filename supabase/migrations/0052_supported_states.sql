-- The five US states Countorra supports at launch: California, Texas,
-- Arizona, Florida and New York.
--
-- `organizations.state_region` (0040) is the workspace's state of residence,
-- and the ONLY input that selects a state tax engine — read server-side,
-- never taken from a request. Until now it accepted any two capital letters.
-- The application's list lives in src/domain/tax/supported-states.ts; this
-- makes the database hold the same line, for every caller.
--
-- WHAT THIS DOES — AND DELIBERATELY DOES NOT DO
--
--   * NULL stays allowed. It means "not told yet" — a workspace created
--     before onboarding asked. Nothing is backfilled: guessing a state would
--     put a household under another state's tax rules. The application asks,
--     and calculates no state tax until it is answered.
--   * NOT VALID: rows already holding another state are left exactly as they
--     are, so this migration cannot fail on live data. Postgres still checks
--     the constraint on every insert and update, so such a workspace must
--     choose one of the five the next time it is saved — which is what the
--     Settings form asks it to do. To see them:
--
--       select state_region, count(*) from organizations
--       where state_region is not null
--         and state_region not in ('CA', 'TX', 'AZ', 'FL', 'NY')
--       group by state_region;
--
--   * RLS is unchanged: the column is read and written through the existing
--     organization policies (members read, owners/admins update).
--
-- ADDING A STATE LATER: implement its rules and engine, add it to
-- SUPPORTED_STATES, then drop and recreate this constraint with the new list.

alter table organizations
  add constraint organizations_state_region_supported
  check (state_region is null or state_region in ('CA', 'TX', 'AZ', 'FL', 'NY'))
  not valid;

comment on column organizations.state_region is
  'USPS code of the state the workspace lives in: CA, TX, AZ, FL or NY (0052). Selects the state tax engine. Null means not yet told — no state tax is calculated. Never inferred.';
