-- FIN-01. A correctness fix, not a performance one.
--
-- THE BUG
--
-- Every authoritative financial figure in this product was computed by
-- selecting transaction rows through PostgREST and summing them in Node:
-- `getAccountBalanceMinor` issued two unbounded selects per account,
-- `listTransactionsForPeriod` issued one per period. PostgREST caps a
-- response at `max_rows` (1000, both in supabase/config.toml and by default
-- on Supabase cloud) and it does so SILENTLY — no error, no flag, no partial
-- indicator. Past a thousand rows the sums were simply wrong, and every
-- surface that consumed them was wrong with them: account balances, the
-- dashboard, the six-month cash-flow chart, the P&L report, spend by
-- category, period comparison, the financial-health score, forecasting, and
-- every AI answer derived from any of those.
--
-- A thousand transactions is roughly two years of ordinary personal spending.
-- This was not an edge case; it was the second year of every account.
--
-- WHY AGGREGATE IN SQL RATHER THAN RAISING max_rows
--
-- Raising the cap moves the cliff, it does not remove it — the next number
-- becomes the new silent-truncation point, and lowering the whole project's
-- payload ceiling is a real protection to give up for it. Aggregating here
-- removes the class of bug instead: these functions return one row per
-- (currency, kind) or one row per account, so `max_rows` is never in play
-- no matter how many transactions the aggregate spans. Postgres also sums
-- `bigint` exactly, which is the same integer-minor-unit discipline
-- src/domain/money enforces in the application — the arithmetic does not
-- become less exact by moving down a layer.
--
-- WHY THESE ARE **SECURITY INVOKER**, AND WHY THAT IS THE WHOLE POINT
--
-- Every one of these functions is `security invoker` (the default — stated
-- explicitly below so it can never be changed by accident). They run as the
-- calling role, so the existing RLS policies on `transactions` and `accounts`
-- filter the scan exactly as they filter today's row-by-row reads. That
-- matters more than it might look:
--
--   * There is NO new tenant-isolation surface. A `security definer`
--     aggregate would have needed its own membership check, and would have
--     become a fresh way to read another organization's money if that check
--     were ever wrong. This design has no privilege to misuse.
--   * `p_organization_id` is NOT a trust boundary here. It narrows the scan;
--     RLS decides what is visible. Passing another organization's id returns
--     zero rows, the same as selecting its transactions directly does today.
--     Callers still go through `requireOrgMembership` first — this is simply
--     not the layer that depends on it.
--   * `search_path` hardening is not required, because nothing here runs with
--     elevated rights. It is pinned anyway, so a future edit that adds
--     `security definer` does not silently inherit a mutable search path.
--
-- Tenant isolation, above and below the row cap, is asserted in
-- tests/rls/financial-aggregates.test.ts against real Postgres.

-- ── Account balances ────────────────────────────────────────────────────
-- Mirrors the JS this replaces exactly: opening balance, plus income into
-- the account, minus everything that leaves it (expense AND the outgoing leg
-- of a transfer), plus the incoming leg of transfers pointed at it. A single
-- row is never both legs, which is why the two sides are counted separately.
--
-- Returns every account in one call, replacing an N+1 loop that issued two
-- queries per account on both the dashboard and the accounts page.
create or replace function account_balances_minor(p_organization_id uuid)
returns table (
  account_id uuid,
  currency char(3),
  balance_minor bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    a.id,
    a.currency,
    (
      a.opening_balance_minor
      + coalesce((
          select sum(case when t.kind = 'income' then t.amount_minor else -t.amount_minor end)
          from transactions t
          where t.account_id = a.id
        ), 0)
      + coalesce((
          select sum(t.amount_minor)
          from transactions t
          where t.transfer_account_id = a.id
        ), 0)
    )::bigint
  from accounts a
  where a.organization_id = p_organization_id
$$;

-- ── Transaction totals ──────────────────────────────────────────────────
-- Grouped by (currency, kind) rather than collapsed to a single number, on
-- purpose. Collapsing would force this function to decide what to do about
-- an organization holding more than one currency, and the only safe answers
-- to that ("exclude and say so", "convert at a rate") are product decisions
-- that belong in src/domain/money/aggregate.ts, not in SQL. Returning the
-- breakdown lets the domain layer apply the same rule the accounts page
-- already applies, instead of a second, quietly different one. See FIN-03.
--
-- Every filter mirrors `TransactionFilters` in
-- src/server/db/repositories/transactions.ts one-for-one, so a page's totals
-- and its rows can never describe different sets. `p_search` arrives already
-- escaped for LIKE by `escapeLikePattern` in that same module — one escaping
-- implementation shared by the list query and this one, for the same reason.
create or replace function transaction_totals(
  p_organization_id uuid,
  p_kind transaction_kind default null,
  p_account_id uuid default null,
  p_category_id uuid default null,
  p_merchant_id uuid default null,
  p_date_from date default null,
  p_date_to date default null,
  p_amount_min_minor bigint default null,
  p_amount_max_minor bigint default null,
  p_is_reviewed boolean default null,
  p_categorized_by text default null,
  p_search text default null
)
returns table (
  currency char(3),
  kind transaction_kind,
  total_minor bigint,
  transaction_count bigint,
  unreviewed_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    t.currency,
    t.kind,
    sum(t.amount_minor)::bigint,
    count(*)::bigint,
    count(*) filter (where not t.is_reviewed)::bigint
  from transactions t
  where t.organization_id = p_organization_id
    and (p_kind is null or t.kind = p_kind)
    and (p_account_id is null or t.account_id = p_account_id)
    and (p_category_id is null or t.category_id = p_category_id)
    and (p_merchant_id is null or t.merchant_id = p_merchant_id)
    and (p_date_from is null or t.occurred_on >= p_date_from)
    and (p_date_to is null or t.occurred_on <= p_date_to)
    and (p_amount_min_minor is null or t.amount_minor >= p_amount_min_minor)
    and (p_amount_max_minor is null or t.amount_minor <= p_amount_max_minor)
    and (p_is_reviewed is null or t.is_reviewed = p_is_reviewed)
    and (p_categorized_by is null or t.categorized_by = p_categorized_by)
    and (p_search is null or t.search_text ilike '%' || p_search || '%')
  group by t.currency, t.kind
$$;

-- ── Spend by category ───────────────────────────────────────────────────
-- Expenses only, grouped by category and currency. `category_id` is nullable
-- and uncategorised spend is a real bucket the reports page shows, so the
-- null group is kept rather than filtered away.
create or replace function transaction_category_totals(
  p_organization_id uuid,
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  category_id uuid,
  currency char(3),
  total_minor bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    t.category_id,
    t.currency,
    sum(t.amount_minor)::bigint
  from transactions t
  where t.organization_id = p_organization_id
    and t.kind = 'expense'
    and (p_date_from is null or t.occurred_on >= p_date_from)
    and (p_date_to is null or t.occurred_on <= p_date_to)
  group by t.category_id, t.currency
$$;

-- Explicit grants rather than relying on the schema default privileges set
-- in 0023/0024. These functions read financial data, so who may call them is
-- worth stating at the definition site instead of inferring it from two
-- earlier migrations. `anon` is excluded for the same reason 0024 excluded it
-- everywhere else; RLS would already return it nothing, so this is the second
-- lock on a door that is already shut.
revoke execute on function account_balances_minor(uuid) from public, anon;
revoke execute on function transaction_totals(uuid, transaction_kind, uuid, uuid, uuid, date, date, bigint, bigint, boolean, text, text) from public, anon;
revoke execute on function transaction_category_totals(uuid, date, date) from public, anon;

grant execute on function account_balances_minor(uuid) to authenticated, service_role;
grant execute on function transaction_totals(uuid, transaction_kind, uuid, uuid, uuid, date, date, bigint, bigint, boolean, text, text) to authenticated, service_role;
grant execute on function transaction_category_totals(uuid, date, date) to authenticated, service_role;
