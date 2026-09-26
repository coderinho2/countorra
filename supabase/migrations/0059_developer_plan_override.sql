-- ════════════════════════════════════════════════════════════════════════════
-- 0059 — a developer's test plan for one workspace, separate from billing
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
--
--   Bank connections, document OCR and the assistant's allowance are Premium
--   and Business features, correctly. That makes them impossible to exercise
--   on the deployment they run on without first completing a real Stripe
--   payment — so the features most worth testing are the ones hardest to
--   reach.
--
--   The tempting fixes are all wrong. Loosening the Free tier would ship the
--   features to everyone. Writing a fake `subscriptions` row would put a lie
--   into the table Stripe's webhook owns, and the next webhook would either
--   overwrite it or act on it. Both weaken the thing they are meant to help
--   test.
--
--   So this is a SEPARATE table that overrides ENTITLEMENTS ONLY. Billing
--   state stays exactly as Stripe reports it; `subscriptions` is untouched;
--   nothing here creates a customer, a subscription or an invoice.
--
-- ── WHAT MAKES IT SAFE ──────────────────────────────────────────────────────
--
--   Two independent conditions, and both are required before a row can be
--   written. Neither is in the database:
--
--     1. the signed-in user's CONFIRMED email is listed in DEVELOPER_ACCOUNTS,
--        a server environment variable. A deployment that does not set it has
--        no override mechanism at all, which is the default.
--     2. that user is an OWNER of the workspace.
--
--   What IS in the database is the part that matters most: there is no
--   insert, update or delete policy on this table for any browser role. A
--   member may read their own workspace's row, so the UI can say the plan is
--   a test override rather than a purchase — and that is all. No crafted
--   request, no manipulated client state and no forged form field can write
--   here, because no policy exists that would let it. Writes happen only
--   through the service role, from a server action that has checked both
--   conditions above.
--
--   `src/domain/billing/developer-override.ts` holds the allowlist rule;
--   `src/server/billing/developer-override.ts` is the only writer.
--
-- ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
--
--   It does not touch `subscriptions`, `plans`, or any Stripe column. It
--   grants nothing on its own: with DEVELOPER_ACCOUNTS unset, a row here —
--   however it got there — is read by an application that will not act on it,
--   because the allowlist is checked on every read as well as every write.
--
-- ── DEPLOY ORDER ────────────────────────────────────────────────────────────
--
--   MIGRATE FIRST, THEN DEPLOY, behind 0057 and 0058. The new code reads this
--   table; the old code does not know it exists, so applying it early is inert.
--
--   To roll back:
--
--   drop table if exists developer_plan_overrides;
--   create or replace function operations_schema_version() returns text language sql immutable as $$ select '0058'::text $$;

create table if not exists developer_plan_overrides (
  -- One per workspace. A developer testing two workspaces sets one in each.
  organization_id uuid primary key references organizations (id) on delete cascade,
  -- The same enum the real subscription uses, so an override can express
  -- exactly the tiers the product has and nothing else. 'free' is a
  -- meaningful value: it forces Free onto a workspace that has paid, which is
  -- how the restrictions are tested without cancelling a subscription.
  plan_id plan_tier not null,
  /** The developer who set it. Kept for the audit trail, detached rather than
   *  cascaded if that account is ever deleted. */
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table developer_plan_overrides is
  'A developer test plan for one workspace. Overrides ENTITLEMENTS ONLY and never billing: subscriptions, Stripe customers and invoices are untouched. Writable only by the service role, and only acted on when the signed-in user is in DEVELOPER_ACCOUNTS.';

drop trigger if exists developer_plan_overrides_set_updated_at on developer_plan_overrides;

create trigger developer_plan_overrides_set_updated_at
  before update on developer_plan_overrides
  for each row execute function set_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────────────
--
--   Read for members of the workspace, so Settings can label the plan
--   honestly as a test override. NOTHING ELSE. The absence of an insert,
--   update and delete policy is the control: PostgREST refuses a write that
--   no policy permits, so a member cannot grant themselves Premium by any
--   request they can construct.

alter table developer_plan_overrides enable row level security;

-- Dropped first so the file is re-runnable; Postgres has no
-- `create policy if not exists`. The drop and the create are in the same
-- migration, so no session ever sees the table without its read policy — and
-- because the only policy is a SELECT one, a re-run cannot widen access even
-- momentarily. Writes stay impossible throughout: there is no insert, update
-- or delete policy to drop or recreate.
drop policy if exists developer_plan_overrides_select_member on developer_plan_overrides;

create policy developer_plan_overrides_select_member on developer_plan_overrides
  for select
  using (is_org_member(organization_id));

-- Deliberately no `for insert`, `for update` or `for delete` policy. See above.

-- ── Schema version ─────────────────────────────────────────────────────────

create or replace function operations_schema_version()
returns text
language sql
immutable
as $$
  select '0059'::text
$$;
