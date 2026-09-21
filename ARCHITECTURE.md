# Architecture

Phase 1 foundation for Countorra. This document explains how the
codebase is organized and why — see [DESIGN.md](DESIGN.md) for the visual
system and [CLAUDE.md](CLAUDE.md) for the design-skill precedence.

## Stack

- **Next.js 16** (App Router, TypeScript, React 19)
- **Tailwind CSS v4** (CSS-first config — tokens live in `src/app/globals.css`, no `tailwind.config.ts`)
- **Supabase** (Postgres, Auth, and — later — Storage)
- **Zod v4** for validation, **React Hook Form** for form state
- **Vitest** for unit/domain tests, **Playwright** for e2e smoke tests
- **@anthropic-ai/sdk** behind a provider abstraction (`src/domain/ai`)

Every dependency in `package.json` is there because a specific file uses
it — see `git log` / the file itself if a dependency's purpose isn't
obvious.

## Project structure

```
src/
  app/                    Next.js routes (App Router). Thin — pages fetch
                           via repositories and render; no business logic here.
  components/ui/           Design-system primitives (DESIGN.md §7–§20).
  domain/                  Pure business logic. No Next.js, no Supabase client
                           imports (except where a file is explicitly server-only).
    money/                 Integer-minor-unit arithmetic (DESIGN.md §11).
    financial/             Deterministic calculation engine (DESIGN.md §10).
    organizations/         Roles, permissions — mirrors RLS policies exactly.
    tax/                   TaxEngine interface + country registry (unimplemented).
    documents/             Document extraction interface (unimplemented).
    ai/                    Provider abstraction, tool registry, safety gate.
    audit/                 Audit-log writer (calls the append-only RPC).
    billing/                Plan/entitlement types, no payment provider.
    config/                 Feature flags.
  server/                  Anything that needs a request/session context.
    supabase/               Client factories (browser / server / admin).
    auth/                   Session helpers + Server Actions — the only
                             place `supabase.auth.*` is called.
    db/repositories/        The only place table queries are written.
  validation/schemas/       Zod schemas, one file per domain concept.
  types/database.ts         Hand-written Supabase `Database` type.
  lib/                      env.ts (validated env access), utils.ts (cn()).
supabase/
  migrations/                Numbered SQL migrations — schema, RLS, triggers.
  config.toml                 Supabase CLI project config (from `supabase init`).
tests/
  rls/                        PGlite-backed RLS tests (see below).
  e2e/                         Playwright smoke tests.
```

Nothing is dumped into a generic `components/`, `utils/`, or `helpers/`
folder — every file's location says what it's responsible for.

## Database & Row Level Security

Twelve migrations in `supabase/migrations/`, applied in order:

1. `0001` extensions + shared enums + `set_updated_at()` trigger
2. `0002` identity: `profiles`, `organizations`, `memberships`
3. `0003` RLS helper functions (`is_org_member`, `is_org_role`)
4. `0004` financial core: `accounts`, `transaction_categories`, `merchants`, `transactions`
5. `0005` accounting: `accounting_periods`, `tax_configurations`, `vat_configurations`
6. `0006` documents pipeline
7. `0007` invoicing (customers, invoices, line items)
8. `0008` AI (conversations, messages, usage, insights, **ai_actions** — the WRITE/DELETE confirmation gate)
9. `0009` audit logging — **append-only**, enforced by a trigger that rejects UPDATE/DELETE outright, independent of RLS
10. `0010` billing (plans seed data, subscriptions)
11. `0011` **RLS policies for every table above**
12. `0012` organization bootstrap trigger (owner membership + starter categories + free subscription, atomic with org creation)

**"Organization" models any financial entity** — personal, freelancer/self-employed,
or business (DESIGN brief §6) — distinguished by `organizations.entity_type`.
One table, one RLS pattern, instead of three parallel schemas.

**Launch scope: personal only.** Countorra launches as a personal finance and
personal tax product. The enum keeps all three values, but only `personal` can
be created or chosen — enforced by the schema, onboarding, and a database
trigger (`0051_personal_launch_scope.sql`) — and every workspace is presented
as personal. Invoicing (invoices, customers, their assistant tools) is deferred:
code and data kept, routes and actions switched off. The single switch is
`src/domain/organizations/launch-scope.ts`; its comments say how to re-enable
Freelancer and Business.

**The United States is the first supported market** (`organizations` defaults
to `country='US'`, `base_currency='USD'`). Jurisdiction-specific tax logic
lives entirely behind `src/domain/tax`'s `TaxEngine` interface and registry
(`src/domain/tax/register.ts`) — nothing elsewhere in the app branches on
country. `0017_us_tax_architecture.sql` adds the US-relevant storage
(`organizations.tax_identifier`/`tax_identifier_type` for an EIN/SSN/ITIN,
`sales_tax_configurations` for state-by-state nexus, and `w9`/`1099-*`
document support) without touching the EU/Romania-oriented
`vat_configurations` table added in Phase 1 — the two are deliberately
separate concepts (sales-tax nexus vs. VAT registration), not a renamed
column, so both jurisdictions' real shapes stay available when their tax
engines are eventually implemented.

**Role matrix** (mirrored exactly between SQL and `src/domain/organizations/permissions.ts`):

| | read | write (insert/update) | delete |
|---|---|---|---|
| owner, admin, accountant | ✓ | ✓ | ✓ |
| manager, employee | ✓ | ✓ | — |
| viewer | ✓ | — | — |

A member can never change their own role (self-escalation is blocked at
the RLS level, not just in the UI).

### Testing RLS without Docker

This sandbox has no Docker, so the normal `supabase start` local-dev stack
isn't available. `tests/rls/harness.ts` instead runs the **real, unmodified
migration files** against [`@electric-sql/pglite`](https://pglite.dev) — an
in-process WASM Postgres — with a minimal mock of `auth.users` /
`auth.uid()` so the actual RLS policies execute for real, under two
different simulated users. `npm test` runs these alongside everything else.

This caught a real bug during development: the `organizations` SELECT
policy originally only checked `is_org_member()`, but the owner's
membership row is created by an `AFTER INSERT` trigger — which runs *after*
Postgres evaluates RETURNING-visibility for the INSERT itself. Every
first-time "create your organization" call would have failed RLS. See the
comment on `organizations_select_member` in `0011_rls_policies.sql`.

**Before using this against a real Supabase project**, also run the
migrations for real (`supabase link` + `supabase db push`, or paste them
into the SQL editor in order) and re-verify with `supabase test db` once
Docker is available — the PGlite tests are strong evidence, not a
replacement for testing against the actual platform.

## Money

`src/domain/money` is the only code allowed to do arithmetic on `*_minor`
columns. Amounts are integers; all arithmetic happens in `BigInt`
internally with rounding applied exactly once, at the end — see the module
comment in `money.ts` for why this matters and `money.test.ts` for the
edge cases it protects (the classic `$100 / 3` remainder-loss problem,
half-up rounding on VAT calculations, etc).

## AI

`src/domain/ai/provider.ts` is a provider-agnostic interface;
`src/domain/ai/providers/anthropic.ts` is the only file that imports the
Anthropic SDK. Tools (`src/domain/ai/tools/registry.ts`) declare an
`operationMode` (`read | analyze | calculate | suggest | write | delete`);
`AIService` (`src/domain/ai/service.ts`) executes non-mutating tools
immediately and returns WRITE/DELETE calls as `pendingConfirmations`
instead of executing them — enforced again at the database level by a
check constraint on `ai_actions` (an action can't reach `confirmed` /
`executed` status without `confirmed_by` set). The AI never computes a
financial number itself: every `calculate`-mode tool fetches rows via a
repository and hands them to `src/domain/financial/calculation-engine.ts`,
a pure, independently-tested function.

## Auth

`src/server/auth/session.ts` (`requireUser`, `requireOrgMembership`) and
`src/server/auth/actions.ts` (sign up/in/out, password reset) are the only
files that call `supabase.auth.*`. `src/proxy.ts` (Next.js 16 renamed the
`middleware.ts` convention to `proxy.ts`) refreshes the session cookie on
every request and redirects unauthenticated `/app/*` requests to `/login`;
per-organization membership/role checks happen in `requireOrgMembership`,
not in the proxy, since it only knows "is there a session," not "does this
session belong to this org." RLS is still the real boundary — these are
defense-in-depth, not the only layer.

## Environment variables

See `.env.example`. Two modules read `process.env`, split by who may see
the result (Task 18):

- `src/lib/env.ts` — `publicEnv` (the `NEXT_PUBLIC_*` values) and the
  deploy-time app-URL check. Browser code imports this, so it names no server
  variable at all.
- `src/lib/server-env.ts` — `serverEnv()`, every secret, validated with Zod at
  first use. It begins with `import "server-only"`, so a Client Component that
  reaches it fails the build.

Stripe's configuration is read in `src/server/billing/stripe-config.ts`, also
server-only. `tests/security/server-env-boundary.test.ts` and
`tests/e2e/browser-bundle-env.spec.ts` check the boundary in source and in the
built client output.

## Running locally

```bash
cp .env.example .env.local   # fill in a real Supabase project's values
npm install
npm run dev
```

To apply the schema to a real Supabase project:

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

## Testing

```bash
npm test          # vitest — domain logic, validation schemas, RLS (via PGlite)
npm run typecheck
npm run lint
npm run e2e        # playwright — currently a single smoke test
```

## Deferred to later phases (intentionally)

Everything DESIGN brief §3 and §39 list as explicitly out of scope for
Phase 1: the invoice/expense/transaction/document management UI, the AI
chat UI, dashboards and reporting, onboarding, billing UI, notification
center. Also deferred, and called out inline where relevant:

- **Tax calculation** for every registered country — `src/domain/tax/countries/us.ts`
  (the first market) and `romania.ts` both throw on purpose — needs a
  dedicated, verified research phase per jurisdiction.
- **Document OCR/extraction** — `src/domain/documents` has the interface
  and pipeline tables; no provider is wired in.
- **Live RLS verification against real Supabase** — strong PGlite evidence
  exists (`tests/rls`), but this sandbox has no Docker to run
  `supabase test db` or a live project to `db push` against.
- **Payment provider integration** — `src/domain/billing` has types only;
  `subscriptions` has no client-writable path by design (only a service-role
  webhook, not yet built, should ever change `plan_id`).
