# Deploying Countorra

The operator's runbook: how the app runs locally, on Vercel Preview and in
Production, what every environment variable is for and where it belongs, how
each external system (Supabase, Plaid, Stripe, email, DNS) is configured, and
how to roll out, verify, roll back and rotate.

**No secret value appears in this document, and none may ever be added.** Every
value shown is a placeholder in `<angle brackets>`. Real values live only in
`.env.local` (git-ignored) and in the Vercel project's environment settings.

Companion documents: [BANK-SYNC-WORKER.md](BANK-SYNC-WORKER.md) (the worker),
[PLAID-INTEGRATION.md](PLAID-INTEGRATION.md) (the bank adapter),
[PLAID-SANDBOX-VERIFICATION.md](PLAID-SANDBOX-VERIFICATION.md) (the sandbox
runbook), [SECURITY-RATE-LIMITING.md](SECURITY-RATE-LIMITING.md).

---

## Contents

1. [The three environments](#1-the-three-environments)
2. [Local development](#2-local-development)
3. [Environment variables](#3-environment-variables)
4. [Supabase](#4-supabase)
5. [Domain and DNS](#5-domain-and-dns)
6. [Plaid](#6-plaid)
7. [Worker cron](#worker-cron)
8. [Stripe](#8-stripe)
9. [Email](#9-email)
10. [Error tracking and logs](#10-error-tracking-and-logs)
11. [Database migrations](#11-database-migrations)
12. [Deploying](#12-deploying)
13. [Rollback](#13-rollback)
14. [Secret rotation](#14-secret-rotation)
15. [Launch smoke tests](#15-launch-smoke-tests)
16. [Post-launch checks](#16-post-launch-checks)

---

## 1. The three environments

| | Local | Preview (Vercel) | Production (Vercel) |
| --- | --- | --- | --- |
| Built from | your working tree | every pushed branch / PR | the production branch (`main`) |
| URL | `http://localhost:3000` | `https://<project>-<hash>.vercel.app` | `https://<your-domain>` |
| Supabase | the project in `.env.local` | **a separate project is strongly recommended** — see §4 | the production project |
| Plaid | Sandbox | Sandbox | Production (after approval) |
| Stripe | Test mode | Test mode | Live mode |
| Worker cron | none — invoke by hand | none — Vercel does not run crons on previews | once a day, 06:00 UTC (`vercel.json`; Vercel Hobby allows daily only) |
| Email (auth) | Supabase built-in | Supabase custom SMTP | Supabase custom SMTP |
| `VERCEL_ENV` | unset | `preview` | `production` |

The rule that keeps money and bank data safe: **Preview never holds a
production secret.** Plaid production, Stripe live and the production Supabase
service key are set for the *Production* environment only in Vercel.

The app refuses the most dangerous mix-ups by itself:

* A Vercel build with `NEXT_PUBLIC_APP_URL` pointing at localhost or plain
  `http` **fails** (`assertDeployableAppUrl`, `src/lib/env.ts`).
* Plaid, Stripe and email each refuse a **partial** configuration at first
  use rather than half-working.
* Plaid's host is derived only from `PLAID_ENV` (`sandbox` or `production`,
  never defaulted); every bank connection records which one it was made in,
  immutably, and the UI labels sandbox data as fictional.

---

## 2. Local development

```bash
npm install
cp .env.example .env.local        # fill in what you need; see §3
npm run dev                       # http://localhost:3000
```

Minimum to run: the four Supabase/Anthropic variables. Everything else is
optional — billing, bank connections and email each switch themselves off, and
the UI says so, when their variables are absent.

Useful locally:

```bash
npm test               # Vitest: unit + real-Postgres (PGlite) suites
npm run e2e            # Playwright; builds and serves a production build
npm run typecheck && npm run lint && npm run build
```

To exercise the worker by hand (the route needs `BANK_SYNC_WORKER_SECRET`):

```bash
curl -s -X POST http://localhost:3000/api/bank-connections/worker \
  -H "Authorization: Bearer $BANK_SYNC_WORKER_SECRET"
```

To receive Plaid or Stripe webhooks locally you need a public HTTPS tunnel
(`cloudflared tunnel --url http://localhost:3000`, or `stripe listen
--forward-to localhost:3000/api/stripe/webhook` for Stripe).

Generating a local secret (32 random bytes, base64):

```bash
openssl rand -base64 32
# or, without OpenSSL:
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

---

## 3. Environment variables

`src/lib/server-env.ts` (server-only) is where `process.env` is read for
secrets — `src/lib/env.ts` holds only the public values browser code may
import — and `.env.example` documents every variable. **Nothing here may be prefixed
`NEXT_PUBLIC_` except the three that already are** — that prefix inlines the
value into the browser bundle.

In the table, **P** = Production, **Pv** = Preview, **L** = local.

### Core

| Variable | P | Pv | L | Secret | Notes |
| --- | --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | ✓ | ✓ | ✓ | no | Project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✓ | ✓ | ✓ | no (public by design; RLS enforces access) | |
| `NEXT_PUBLIC_APP_URL` | `https://<your-domain>` | the preview URL is not known in advance — see below | `http://localhost:3000` | no | **Inlined at build time.** Changing it requires a rebuild. |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | preview project's key | ✓ | **yes** | Bypasses RLS. Server only. |
| `ANTHROPIC_API_KEY` | ✓ | ✓ (a separate, capped key is wise) | ✓ | **yes** | |
| `RATE_LIMIT_HASH_SECRET` | ✓ | ✓ | optional | **yes** | Optional; derived from the service key if unset. Setting it decouples rate-limit windows from service-key rotation. |

`NEXT_PUBLIC_APP_URL` on Preview: it drives auth email links, Stripe return
URLs and canonical tags. Set it to a stable preview alias (a branch domain such
as `https://staging.<your-domain>` assigned in Vercel) rather than the
per-deployment hash URL, and add that alias to Supabase's redirect allowlist.

### Billing — Stripe (all four or none)

| Variable | P | Pv | L | Secret |
| --- | --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | `sk_live_…` | `sk_test_…` | `sk_test_…` | **yes** |
| `STRIPE_WEBHOOK_SECRET` | live endpoint's `whsec_…` | test endpoint's | from `stripe listen` | **yes** |
| `STRIPE_PREMIUM_PRICE_ID` | live `price_…` | test `price_…` | test | no |
| `STRIPE_BUSINESS_PRICE_ID` | live `price_…` | test `price_…` | test | no |

Test and live ids are different objects in Stripe; a test price id in
Production fails checkout, it does not charge anyone.

### Bank connections — Plaid (client id, secret, env and key: all or none)

| Variable | P | Pv | L | Secret |
| --- | --- | --- | --- | --- |
| `PLAID_CLIENT_ID` | ✓ | ✓ | ✓ | treat as secret |
| `PLAID_SECRET` | **production** secret | **sandbox** secret | sandbox | **yes** |
| `PLAID_ENV` | `production` | `sandbox` | `sandbox` | no |
| `PLAID_WEBHOOK_URL` | `https://<your-domain>/api/bank-connections/webhooks/plaid` | `https://<preview-alias>/api/bank-connections/webhooks/plaid` | tunnel URL or unset | no |
| `PLAID_REDIRECT_URI` | `https://<your-domain>/app/bank-connections/oauth` | `https://<preview-alias>/app/bank-connections/oauth` | `http://localhost:3000/app/bank-connections/oauth` or unset | no |
| `BANK_CREDENTIAL_ENCRYPTION_KEY` | its own key | its own key | its own key | **yes** — see §14 |
| `BANK_SYNC_WORKER_SECRET` | ✓ | ✓ | ✓ | **yes** |
| `CRON_SECRET` | **same value** as `BANK_SYNC_WORKER_SECRET` | not needed (no crons on preview) | unset | **yes** |
| `BANK_SYNC_HEARTBEAT_URL` | recommended | optional | unset | contains a secret path |

`BANK_CREDENTIAL_ENCRYPTION_KEYS` (plural) is accepted as an alias.
**Never reuse the encryption key across environments**: a key shared between
Preview and Production means a preview can decrypt production bank tokens.

### Email — invoices (all or none; auth email is Supabase's, §4)

| Variable | P | Pv | L | Secret |
| --- | --- | --- | --- | --- |
| `EMAIL_PROVIDER` | `resend` | `resend` or `console` | `console` | no |
| `EMAIL_FROM_ADDRESS` | `billing@<your-domain>` (verified) | ✓ | optional | no |
| `EMAIL_FROM_NAME` | `Countorra` | ✓ | ✓ | no |
| `EMAIL_REPLY_TO` | a monitored inbox | optional | optional | no |
| `RESEND_API_KEY` | ✓ | ✓ | unset | **yes** |

### Never set in any deployed environment

`DATABASE_URL` (local RLS scripts only).

---

## 4. Supabase

### Projects

Production should be its own Supabase project. A second project for Preview is
strongly recommended: preview deployments run arbitrary branch code, and
pointing them at the production database means a bad branch can touch real
people's data. If you run a single project for now, understand that Preview is
then production-adjacent and keep its other secrets (Plaid, Stripe) in
sandbox/test mode regardless.

The production project should be on a plan with **Point-in-Time Recovery** —
this is a financial ledger.

### Auth → URL Configuration

| Setting | Value |
| --- | --- |
| Site URL | `https://<your-domain>` |
| Redirect URLs | `https://<your-domain>/auth/callback` and, for previews, `https://<preview-alias>/auth/callback` |

Signup sends people to `${NEXT_PUBLIC_APP_URL}/auth/callback`, and password
reset to `${NEXT_PUBLIC_APP_URL}/auth/callback?flow=recovery`. Supabase rejects
any redirect not on the allowlist, so an unlisted origin fails at the moment
someone clicks their confirmation email.

Keep **Confirm email** enabled.

### Custom SMTP (required before launch)

Supabase's built-in sender is rate-limited to a handful of messages per hour
and is not meant for production. **Signups will fail silently at real volume
without custom SMTP.**

Auth → Settings → SMTP: host, port, user, password from your email provider
(Resend, Postmark, SES…), sender `no-reply@<your-domain>`, sender name
`Countorra`. Then raise the auth email rate limit (Auth → Rate Limits) to
something that matches expected signups.

The sending domain needs SPF, DKIM and DMARC records (§5).

### Storage

The `documents` bucket and its policies are created by the migrations; nothing
to configure by hand.

---

## 5. Domain and DNS

After buying the domain:

1. **Vercel** → Project → Settings → Domains: add `<your-domain>` and
   `www.<your-domain>` (redirect one to the other). Follow Vercel's DNS
   instructions (an `A` / `ALIAS` record, or delegate nameservers). TLS is
   issued automatically; HSTS is already sent by the app on production
   deployments (`next.config.ts`) — without `includeSubDomains` or `preload`.
   Add those only after every subdomain is verified to serve HTTPS.
2. **Vercel env**: set `NEXT_PUBLIC_APP_URL=https://<your-domain>` for
   Production and **redeploy** (it is inlined at build time).
3. **Supabase**: Site URL and redirect allowlist (§4).
4. **Email DNS**: SPF, DKIM (from your provider) and a DMARC record
   (`v=DMARC1; p=quarantine; rua=mailto:<dmarc-inbox>` is a reasonable start)
   for the sending domain, for both Supabase SMTP and invoice email.
5. **Plaid**: webhook URL and OAuth redirect URI (§6).
6. **Stripe**: webhook endpoint (§8); portal return URLs are derived
   automatically from `NEXT_PUBLIC_APP_URL`.
7. **SEO**: nothing to change in code — `metadataBase`, `robots.txt` and
   `sitemap.xml` all follow `NEXT_PUBLIC_APP_URL`.

---

## 6. Plaid

### Sandbox (Preview and local)

`PLAID_ENV=sandbox`, the **sandbox** secret, and the full procedure in
[PLAID-SANDBOX-VERIFICATION.md](PLAID-SANDBOX-VERIFICATION.md). The Bank
connections page shows a sandbox warning, and every connection made is labelled
"Sandbox — test data".

### Production

1. Request **Production access** in the Plaid dashboard (company details, use
   case, the URL of the live privacy policy). This is a review; allow days.
2. Set the Production-only variables in Vercel (§3): production secret,
   `PLAID_ENV=production`, webhook URL, redirect URI.
3. **OAuth redirect.** Most large US banks (Chase, Bank of America, Wells
   Fargo, Capital One…) sign the customer in on their own site and send them
   back to one fixed address. Register exactly
   `https://<your-domain>/app/bank-connections/oauth` in the Plaid dashboard
   (Team settings → API → Allowed redirect URIs) and set `PLAID_REDIRECT_URI`
   to the same string. It is the same for every organization — see
   "How the OAuth return works" below. The app refuses to start bank
   features with any other value (a per-organization path, a query string,
   plain `http` on a real host).
4. **Webhook**: `PLAID_WEBHOOK_URL` must be the public HTTPS URL of
   `/api/bank-connections/webhooks/plaid`. It is sent with each Link token; no
   dashboard setting is needed. Verification is ES256 JWT over the raw body;
   do not put any proxy in front of this route that rewrites bodies.
5. Keep the scheduler running (§7) — without it, webhook-triggered imports are
   queued and never executed.

A production Plaid secret must **never** be set in Preview or local.

### How the OAuth return works

One fixed return path, `/app/bank-connections/oauth`, serves every
organization (fixed in Task 16; before that the page lived under
`/app/<orgId>/…`, which could serve only one workspace).

1. When Link starts, the server — having just checked the person's session,
   membership, permission, plan and rate limit — **seals** who they are, which
   organization, which connection (for a repair), the mode and the Link token
   into an encrypted cookie (AES-256-GCM, key derived with HKDF from the bank
   credential keyset). The cookie is HttpOnly, SameSite=Strict, scoped to
   `/app`, and expires after 30 minutes. Nothing is written to browser
   storage.
2. The bank sends the customer back to the fixed path. The page is behind the
   normal session gate and reads **no** organization from the URL.
3. The page asks the server to resume. The server opens the seal and requires
   that the signed-in person is the one who started it, that they are still a
   member with permission, that the plan still includes bank connections, and
   the rate limit — then re-opens the same Link session.
4. Completion sends only the public token. The organization, connection and
   mode are the sealed ones; anything else in the request is not read. The
   seal is single-use.

A forged, altered, expired or someone-else's seal means "start again", and
no data is touched.

---

<a id="worker-cron"></a>

## 7. Worker cron

`vercel.json` runs `/api/bank-connections/worker` **once a day** —
`0 6 * * *`, i.e. some time between 06:00 and 06:59 UTC — on the
**production** deployment (Vercel never runs crons on previews). Daily is what
Vercel's Hobby plan allows: it refuses to deploy a cron that runs more often.
Scheduled syncs therefore happen once a day; webhook-queued imports, retries
and continuations wait for the next run; manual refreshes are unaffected. See
[BANK-SYNC-WORKER.md §2](BANK-SYNC-WORKER.md#2-what-production-has-to-invoke) for the details, including the
`bank.worker_backlog` warnings this cadence produces.

| Requirement | Why |
| --- | --- |
| `BANK_SYNC_WORKER_SECRET` set | Without it the route answers 404 and nothing runs. |
| `CRON_SECRET` = the same value | Vercel sends `Authorization: Bearer $CRON_SECRET`. The route accepts only the worker secret; a mismatch refuses every cron call and reports `bank.worker_cron_secret_mismatch` (error). |
| A daily schedule on Hobby | Hobby refuses any cron more frequent than daily. On **Pro**, `*/5 * * * *` is allowed — change `vercel.json` and `tests/server/vercel-config.test.ts` together. Hobby is for non-commercial use under Vercel's terms. |

The route is bounded for serverless: `maxDuration = 60`, and no job or provider
page starts after 30 s, so the page in flight always finishes and the rest
continues on the next invocation. Cron calls get no exemption from the secret
or the rate limit (120/hour per IP; a daily cron uses 1, a five-minute
scheduler 12).

**Recommended:** a dead-man's switch. Create a check at healthchecks.io,
Cronitor or Better Stack with a **1-day period and ~3-hour grace** (Hobby fires
within the scheduled hour) — or 5 minutes / ~15 minutes if you add a
five-minute scheduler below — and put its ping URL in
`BANK_SYNC_HEARTBEAT_URL` (Production only). The route pings it
after every successful invocation; if the cron stops, you are alerted.

### Not on Vercel — or more often than Hobby allows

Any scheduler that can send an authenticated HTTP request works, alongside the
daily Vercel cron or instead of it. On Hobby, one of these is the way to get
five-minute imports without upgrading. Examples (replace placeholders; keep the
secret in the scheduler's own secret store):

**GitHub Actions** (`.github/workflows/bank-worker.yml`; GitHub's minimum is
every 5 minutes and it may be delayed under load):

```yaml
on:
  schedule: [{ cron: "*/5 * * * *" }]
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: >
          curl -fsS -X POST "https://<your-domain>/api/bank-connections/worker"
          -H "Authorization: Bearer ${{ secrets.BANK_SYNC_WORKER_SECRET }}"
```

**Supabase `pg_cron` + `pg_net`** (runs inside the database; store the secret
in Supabase Vault rather than inline):

```sql
select cron.schedule('bank-worker', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://<your-domain>/api/bank-connections/worker',
    headers := jsonb_build_object('Authorization', 'Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name = 'bank_sync_worker_secret'))
  );
$$);
```

**systemd timer / crontab**:

```cron
*/5 * * * * curl -fsS -X POST https://<your-domain>/api/bank-connections/worker -H "Authorization: Bearer $(cat /etc/countorra/worker-secret)"
```

Whatever the scheduler, running it more often costs nothing extra: scheduled
syncs are keyed to a six-hour window and each connection has at most one active
job.

---

## 8. Stripe

### Test mode (local and Preview)

`scripts/stripe-test-setup.mjs` does the API-side setup and a read-only
pre-flight. It accepts only a `sk_test_…` key, stops on a live key before any
call, never prints a key or id, and only ever ADDS missing lines to
`.env.local`.

1. Stripe Dashboard, **Test mode** on: Developers → API keys → copy the
   secret test key into `.env.local` as `STRIPE_SECRET_KEY=`.
2. Dashboard (test mode) → Settings → Billing → **Customer portal** → click
   **Save** once. That creates the test-mode *default* portal configuration,
   which only the Dashboard can create; Countorra's portal sessions use the
   default.
3. `node scripts/stripe-test-setup.mjs setup` — finds or creates two products
   with one recurring monthly USD price each, by lookup key
   (`countorra_premium_monthly` $19, `countorra_business_monthly` $49 — these
   must match `PLAN_ENTITLEMENTS`; no Free price), writes
   `STRIPE_PREMIUM_PRICE_ID` / `STRIPE_BUSINESS_PRICE_ID` if absent, and sets
   the default portal to what Countorra supports: invoice history,
   payment-method update, billing email/address, cancel **at period end** with
   no proration, and switching only between the two prices with
   `always_invoice` (an upgrade is billed immediately — with
   `create_prorations` an upgrade followed by cancel-at-period-end would never
   be charged).
4. Webhook signing secret, locally: install the Stripe CLI, `stripe login`,
   then `stripe listen --print-secret` and put the `whsec_…` in `.env.local`
   as `STRIPE_WEBHOOK_SECRET=`. Keep
   `stripe listen --forward-to localhost:3000/api/stripe/webhook --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_succeeded,invoice.payment_failed`
   running while testing — it signs with that same secret, so the existing
   endpoint verifies real deliveries unchanged. On Preview, add a test-mode
   endpoint at `https://<preview-alias>/api/stripe/webhook` with the same
   seven events and use its signing secret instead.
5. `node scripts/stripe-test-setup.mjs check` — every line must say YES.
6. Automated suite: `npx vitest run tests/stripe-test-mode`. It talks to the
   real Stripe API (prices match the canonical plans, Checkout with the
   server's price, payment → signed webhook → plan, plan change, cancellation,
   a declined card, the Customer Portal, and deletion cancelling a real
   subscription) and deletes what it creates. With no Stripe variables at all
   it is skipped (BLOCKED); with some but not all, or a non-`sk_test_` key, it
   FAILS rather than skipping; with a live key it refuses to run.
7. By hand, with the app and `stripe listen` running: checkout with
   `4242 4242 4242 4242` → webhook → the workspace shows Premium; open
   **Manage billing**; switch plan; cancel; confirm the plan reverts at period
   end. The suite cannot complete a hosted Checkout page or receive a real
   delivery on its own.

### Live mode (Production only)

1. Activate the Stripe account (business details, payout bank account).
2. Decide on tax: **Stripe Tax** (or your own handling) for sales tax / VAT on
   consumer subscriptions.
3. Recreate the product and both prices **in live mode** — test objects do not
   carry over. Note the live price ids.
4. Webhook endpoint (live): `https://<your-domain>/api/stripe/webhook`, with
   exactly these events:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`.
   Copy its signing secret.
5. **Customer Portal**: configure and save again **in live mode** — it is a
   separate configuration. Without it, "Manage billing" fails.
6. Set the four Production variables in Vercel; redeploy.
7. One real purchase with your own card, confirm the plan change, then refund
   and cancel it.

Only the webhook can grant a paid plan; the checkout success page never does.
The webhook answers 503 while Stripe is unconfigured, so Stripe retries rather
than losing events.

### Deleting a workspace that has a subscription

A workspace is never deleted while Stripe may still be charging for it
(`src/server/billing/deletion-safety.ts`, migration 0050):

1. Account deletion takes a per-workspace teardown lock. A second deletion is
   refused, and Checkout / Manage billing refuse while it is held (it lapses
   after 15 minutes if an attempt crashes).
2. The Stripe customer and subscription are read from the workspace's own
   row — never from the request. Open Checkout sessions for that customer are
   expired, then every subscription on the customer that is not `canceled` or
   `incomplete_expired` is canceled **immediately**, with no proration credit
   and no final invoice (refunds are a business decision — see
   `LEGAL_FACTS.refundPolicy`).
3. Stripe is asked again. Only when it reports nothing that can bill is the
   cancellation recorded locally and deletion allowed to continue.
4. If any of that cannot be established — Stripe unreachable, Stripe not
   configured while the workspace has a customer, or a recorded subscription
   id this Stripe account does not recognise (e.g. test-mode ids under live
   keys) — **nothing is deleted**, the lock is released, and the person gets a
   plain message with no provider detail.
5. The database backs this up on its own: no browser session can delete an
   organization, and nobody (service role included) can delete one whose row
   still records a live Stripe subscription.

Stripe customers are not deleted — Stripe keeps its invoice and payment
records under its own obligations. Switching a deployment between test and
live keys while workspaces still hold subscriptions from the other mode will
block their deletion (step 4) until resolved by hand.

Test-mode check before going live: subscribe a throwaway workspace with
`4242 4242 4242 4242`, delete the account that owns it, and confirm in the
Stripe dashboard that the subscription is **Canceled** and the customer has no
open Checkout sessions.

---

## 9. Email

* **Auth email** (verification, password reset) is sent by **Supabase** —
  configure custom SMTP (§4).
* **Invoice email** is sent by the app through `EMAIL_PROVIDER`. With
  `console` (the default) nothing is delivered and the UI says so. For real
  delivery use `resend` with a verified domain and `RESEND_API_KEY`.

---

## 10. Error tracking and logs

Every error and operational event goes through one boundary,
`src/lib/observability.ts`, which redacts before anything is written:
credentials, prompts, amounts, emails and personal names never leave it, and
short error messages are scrubbed of token-, key-, email- and account-number-
shaped text. Unhandled route errors reach the same boundary through
`src/instrumentation.ts` (`onRequestError`), recorded by route **pattern**,
never the concrete path or headers.

**Out of the box** (no vendor): records go to the console. In production each
record is **one JSON line** (`severity`, `scope`, `event`, `detail`, `at`), so
Vercel's runtime logs are searchable by `event`, and a **Vercel log drain**
(Project → Settings → Log Drains) can forward them to any log or alerting
service with no code change.

**Adding an error-tracking vendor** is a change to one file:
`src/instrumentation.ts` → `register()` initialises the vendor and calls
`registerObservabilitySink({ name, capture })`. The sink receives records that
are already redacted; a failing sink is ignored so it can never break a
request. No vendor is hard-coded, and the app runs identically without one.

Events worth alerting on (all `warning` or `error`):

| Event | Meaning |
| --- | --- |
| `bank.worker_cron_secret_mismatch` | Every cron call is being refused. |
| `bank.worker_backlog` | Due work has waited > 30 min, or a worker died holding a lease. |
| `bank.worker_invocation` at `warning` | An invocation had failed or abandoned jobs. |
| `bank.webhook_rejected` (sustained) | Webhook verification failing — wrong environment or tampering. |
| `billing.webhook_signature_rejected` | Wrong `STRIPE_WEBHOOK_SECRET`, or forged calls. |
| `billing.webhook_unknown_price` | A subscription on a price this deployment does not know. |
| any `scope: "route"` error | An unhandled server error. |

---

## 11. Database migrations

Migrations live in `supabase/migrations`, applied in filename order, and are
**never edited once applied** — a change is always a new file.

```bash
npx supabase link --project-ref <project-ref>       # once per machine
npx supabase migration list --linked                # local vs remote
npx supabase db push --linked                       # apply pending migrations
```

Rules:

* Apply migrations **before** deploying code that depends on them. Every
  migration so far is additive and backward compatible, so the running version
  keeps working while the new schema lands.
* Run the full suite first: `tests/rls` applies every migration to a real
  Postgres (PGlite) and exercises RLS against it.
* After pushing, confirm `migration list` shows local = remote with no gaps.
* For Preview's separate project, push the same migrations there.

---

## 12. Deploying

### First time

1. Push the repository to GitHub (private).
2. Vercel → Add New → Project → import the repository. Framework: Next.js
   (detected). Production branch: `main`.
3. Set environment variables per environment (§3). Start with Preview in
   sandbox/test mode.
4. Deploy. Check the preview (§15), then promote.

### Every change

1. Tests, typecheck, lint and build pass locally.
2. Migrations (if any) pushed and verified (§11).
3. Push a branch → Preview deployment → check it.
4. Merge to `main` → Production deployment.

---

## 13. Rollback

**Code**: Vercel → Deployments → the last good production deployment →
**Promote to Production** (instant; no rebuild). Or `git revert` and push.

**Environment variables**: changing a variable only takes effect on the next
deployment. After fixing a bad value, redeploy (or promote a deployment that
was built with the good value — `NEXT_PUBLIC_*` values are baked into each
build).

**Database**: migrations are forward-only. Roll forward with a new migration
that undoes the change; for data loss, restore with Point-in-Time Recovery.
Because migrations have been additive, rolling code back does not require
rolling the schema back.

**Integrations**:

* Stripe: disable the webhook endpoint to stop processing; events queue on
  Stripe's side and are retried when re-enabled.
* Plaid: unset `PLAID_*` to switch bank connections off entirely — the page
  says no provider is configured, the worker claims nothing, and the webhook
  route answers 404. Existing imported transactions are untouched.
* Worker: remove `BANK_SYNC_WORKER_SECRET` to stop all background syncing
  (the route answers 404).

---

## 14. Secret rotation

Rotate on staff changes, on any suspected exposure, and on a schedule.

| Secret | How |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → API keys → create a new secret key → set it in Vercel → redeploy → revoke the old key. |
| `ANTHROPIC_API_KEY` | Create a new key → set → redeploy → delete the old one. |
| `STRIPE_SECRET_KEY` | Stripe → roll the key (Stripe keeps the old one valid for a window you choose) → set → redeploy. |
| `STRIPE_WEBHOOK_SECRET` | Roll the endpoint's signing secret (Stripe offers an overlap period) → set → redeploy. |
| `PLAID_SECRET` | Plaid dashboard → rotate → set → redeploy. Existing items keep working. |
| `BANK_SYNC_WORKER_SECRET` + `CRON_SECRET` | Generate → set **both** to the new value → redeploy. The next cron call uses it. |
| `RATE_LIMIT_HASH_SECRET` | Set → redeploy. Current rate-limit windows reset; nothing else is affected. |
| `BANK_CREDENTIAL_ENCRYPTION_KEY` | See below. |

**The bank credential key is special** — it protects stored Plaid access
tokens, and losing it means every connection must be linked again.

The variable is a *keyset*: `<new-id>:<new-key>,<old-id>:<old-key>`, newest
first. The first key encrypts; every listed key can decrypt. So:

1. **Adding a key is safe and immediate**: prepend the new key, redeploy. New
   credentials use it; existing ones still decrypt with the old key.
2. **Retiring a key requires re-encrypting existing credentials first.** The
   function exists (`rotateStoredCredential` in
   `src/server/bank-connections/secret-store.ts`) but **no command runs it yet**.
   Until that exists, **never remove a key from the list** — doing so makes
   every credential encrypted under it unreadable.

Never paste a secret into a chat, an issue, a commit, a screenshot or a log.

---

## 15. Launch smoke tests

Run on the Preview first (sandbox/test mode), then on Production.

**Platform**

- [ ] `https://<your-domain>` loads over HTTPS; `http://` redirects.
- [ ] Response headers include `Strict-Transport-Security`,
      `Content-Security-Policy`, `X-Frame-Options: DENY`.
- [ ] `/robots.txt` and `/sitemap.xml` name the real domain.
- [ ] `/privacy`, `/terms`, `/security`, `/pricing` load and are current.

**Auth**

- [ ] Sign up with a fresh address → the confirmation email arrives (custom
      SMTP) → the link lands on the real domain and signs you in.
- [ ] Password reset email arrives and works.
- [ ] Sign out; `/app` redirects to `/login`.

**Product**

- [ ] Onboarding creates a workspace; add an account and a transaction.
- [ ] AI assistant answers from that data.
- [ ] Upload a PDF document.

**Billing**

- [ ] Pricing → upgrade → Checkout → back to Settings → plan shows the new
      tier **after** the webhook (not before).
- [ ] Manage billing opens the Customer Portal.
- [ ] Stripe dashboard: the webhook endpoint shows 2xx deliveries.

**Bank connections**

- [ ] The page shows the correct environment (sandbox warning on Preview; none
      in Production).
- [ ] Connect a bank → accounts appear → link one to a Countorra account.
- [ ] Within five minutes the worker imports transactions (Production), or
      invoke it by hand (Preview).
- [ ] `curl -X POST https://<your-domain>/api/bank-connections/worker` with
      **no** header → `401`.
- [ ] Disconnect → the connection shows Disconnected; imported transactions
      remain.

**Logs**

- [ ] Vercel runtime logs show `bank.worker_invocation` once a day, between
      06:00 and 06:59 UTC, with `invoker: "vercel-cron"` (the first one the
      morning after the deployment; trigger it sooner from Vercel → Settings →
      Cron Jobs → Run).
- [ ] No `bank.worker_cron_secret_mismatch`.
- [ ] The heartbeat monitor (if configured) shows regular pings.

---

## 16. Post-launch checks

**Daily for the first week, then weekly:**

- Vercel logs: any `error` severity, any `scope: "route"` error, any
  `bank.worker_backlog`.
- Stripe: failed webhook deliveries; `invoice.payment_failed` volume.
- Plaid dashboard: item errors, webhook delivery failures.
- Supabase: auth email bounce/complaint rates (via the SMTP provider), database
  size, slow queries, and that backups/PITR are running.
- The heartbeat monitor is green.
- `npm audit` on the main branch.

**Monthly:** review who has access to Vercel, Supabase, Stripe and Plaid;
rotate anything tied to someone who left (§14).
