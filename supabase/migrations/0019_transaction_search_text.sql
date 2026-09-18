-- Security fix, not a feature addition: transactions.ts's free-text search
-- previously used PostgREST's `.or()` filter — a mini-DSL where `,` `.`
-- `(` `)` `"` are syntax, not data. The existing SQL-wildcard escaping
-- (for `%`/`_` inside ILIKE) only protects the *Postgres* layer; it does
-- nothing for the *PostgREST* layer `.or()` also parses, so a search
-- string containing a comma or quote could have broken out of the
-- intended filter and appended an attacker-chosen condition. Hand-rolling
-- correct escaping for a DSL with no way to verify it against a real
-- PostgREST server in this sandbox was judged too risky to ship — this
-- migration removes the need for `.or()` entirely instead.
--
-- A single generated column lets "search description or memo" become one
-- safe, single-column `.ilike()` call (the same proven-safe pattern
-- customers.ts and invoices.ts already use, which never touches `.or()`).

alter table transactions
  add column search_text text generated always as (coalesce(description, '') || ' ' || coalesce(memo, '')) stored;

-- No trigram GIN index here on purpose: `pg_trgm` isn't guaranteed
-- available and accelerating a leading-wildcard ILIKE is a performance
-- concern, not a correctness one — premature at this data scale (see
-- ARCHITECTURE.md's performance section). A plain sequential scan is
-- correct; revisit with `create extension pg_trgm` + a trigram index if
-- transaction search ever needs to be faster than that.
