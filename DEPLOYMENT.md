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
| Worker cron | none — invoke by hand | none — Vercel does not run crons on previews | every 5 minutes (`vercel.json`) |
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

`src/lib/env.ts` is the only place `process.env` is read for secrets, and
`.env.example` documents every variable. **Nothing here may be prefixed
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
| `PLAID_REDIRECT_URI` | **blocked — see §6 "Known blocker"** | unset | unset | no |
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
   issued automatically; HSTS is already sent by the app (`next.config.ts`).
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
3. **OAuth redirect — see the known blocker below.** Most large US banks
   (Chase, Bank of America, Wells Fargo, Capital One…) use OAuth, which
   requires `PLAID_REDIRECT_URI` to be one exact URI registered in the Plaid
   dashboard (Team settings → API → Allowed redirect URIs).
4. **Webhook**: `PLAID_WEBHOOK_URL` must be the public HTTPS URL of
   `/api/bank-connections/webhooks/plaid`. It is sent with each Link token; no
   dashboard setting is needed. Verification is ES256 JWT over the raw body;
   do not put any proxy in front of this route that rewrites bodies.
5. Keep the scheduler running (§7) — without it, webhook-triggered imports are
   queued and never executed.

A production Plaid secret must **never** be set in Preview or local.

### Known blocker: the OAuth return page is per-organization

Found during Task 15 and **not yet fixed** (fixing it is a Plaid integration
change, outside that task). The OAuth return page is
`/app/[orgId]/bank-connections/oauth` and takes the organization from its URL,
while `PLAID_REDIRECT_URI` is a single fixed value sent for every
organization, and the resume record kept in `sessionStorage` holds only the
Link token and connection id. So any one registered URI can serve at most one
organization: everyone else returning from their bank's OAuth page would land
on an organization they are not a member of.

Consequences until it is fixed:

* **Do not set `PLAID_REDIRECT_URI`** in any environment. Without it, Link
  works for non-OAuth institutions (and for every sandbox institution without
  OAuth, such as First Platypus Bank), and OAuth-only banks do not complete.
* Plaid Production is therefore usable for a **subset** of banks only.

The fix is small and belongs in its own task: an organization-independent
return route (for example `/app/bank-connections/oauth`) that reads the
organization from the resume record written before Link opened, with
membership still enforced server-side by the existing actions — plus a test
that one registered URI serves two different organizations.

---

<a id="worker-cron"></a>

## 7. Worker cron

`vercel.json` runs `/api/bank-connections/worker` every five minutes on the
**production** deployment (Vercel never runs crons on previews).

| Requirement | Why |
| --- | --- |
| `BANK_SYNC_WORKER_SECRET` set | Without it the route answers 404 and nothing runs. |
| `CRON_SECRET` = the same value | Vercel sends `Authorization: Bearer $CRON_SECRET`. The route accepts only the worker secret; a mismatch refuses every cron call and reports `bank.worker_cron_secret_mismatch` (error). |
| Vercel **Pro** plan | Hobby is non-commercial and limited to daily crons; a `*/5` schedule is not allowed there. |

The route is bounded for serverless: `maxDuration = 60`, and no job or provider
page starts after 30 s, so the page in flight always finishes and the rest
continues on the next invocation. Cron calls get no exemption from the secret
or the rate limit (120/hour per IP; the cron uses 12).

**Recommended:** a dead-man's switch. Create a check at healthchecks.io,
Cronitor or Better Stack with a 5-minute period and ~15-minute grace, and put
its ping URL in `BANK_SYNC_HEARTBEAT_URL` (Production only). The route pings it
after every successful invocation; if the cron stops, you are alerted.

### Not on Vercel

Any scheduler that can send an authenticated HTTP request works. Examples
(replace placeholders; keep the secret in the scheduler's own secret store):

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

1. Dashboard in **Test mode**: create the product and two recurring monthly
   prices, $19 (Premium) and $49 (Business) — these must match
   `PLAN_ENTITLEMENTS` in `src/domain/billing/entitlements.ts`.
2. Set the four variables (§3) with `sk_test_…` and the test price ids.
3. Webhook: locally, `stripe listen --forward-to
   localhost:3000/api/stripe/webhook` prints a `whsec_…` to use. On Preview,
   add a test-mode endpoint at `https://<preview-alias>/api/stripe/webhook`.
4. **Customer Portal**: Settings → Billing → Customer portal → configure and
   **save** in test mode (allow plan switching between the two prices,
   cancellation at period end, payment-method updates).
5. Verify: checkout with `4242 4242 4242 4242` → webhook → the workspace
   shows Premium; open **Manage billing**; switch plan; cancel; confirm the plan
   reverts at period end.

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

- [ ] Vercel runtime logs show `bank.worker_invocation` every five minutes
      with `invoker: "vercel-cron"`.
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
