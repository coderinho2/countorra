# Plaid Sandbox live verification — runbook and status

**Status: NOT PERFORMED. No Plaid Sandbox credentials have ever been available
in this environment, so Plaid has never been contacted from this repository.**

That is a statement about this machine, not about the code. Everything below is
the exact procedure to carry the verification out, written so the run produces
the evidence the report needs and nothing is left to improvisation. Sections
map one-to-one onto Task 14's requirements.

Companion documents: [PLAID-INTEGRATION.md](PLAID-INTEGRATION.md) (the adapter)
and [BANK-SYNC-WORKER.md](BANK-SYNC-WORKER.md) (the worker and scheduler).

## 0. Why it has not been done

`plaidConfig()` returns `null` unless `PLAID_CLIENT_ID`, `PLAID_SECRET`,
`PLAID_ENV` and the credential keyset are all present. With `null` there is no
provider in the registry, so:

* the Bank connections page says no provider is configured,
* `POST /api/bank-connections/worker` reports `providerConfigured: false` and
  claims nothing,
* the webhook route answers 404 before reading a body,
* and no code path exists that can construct the Plaid gateway.

Automated proof that this holds, and that sandbox credentials can only reach
the sandbox host: `src/server/bank-connections/providers/plaid/config.test.ts`
and `src/lib/env.test.ts`.

## 1. What to set (server-side only)

| Variable | Value for this run |
| --- | --- |
| `PLAID_CLIENT_ID` | from the Plaid dashboard |
| `PLAID_SECRET` | the **Sandbox** secret (sandbox and production have different secrets for the same client id) |
| `PLAID_ENV` | `sandbox` — never defaulted, never guessed |
| `PLAID_WEBHOOK_URL` | a **public https** URL ending in `/api/bank-connections/webhooks/plaid` |
| `BANK_CREDENTIAL_ENCRYPTION_KEY` | `openssl rand -base64 32`; the plural `…KEYS` is accepted as an alias |
| `BANK_SYNC_WORKER_SECRET` | `openssl rand -base64 32` |
| `PLAID_REDIRECT_URI` | `http://localhost:3000/app/bank-connections/oauth` locally, or the preview alias's equivalent — registered in the Plaid dashboard; only needed to test an OAuth sandbox institution |

Put them in `.env.local` (git-ignored) or the host's environment. Never in
source, `.env.example`, a `NEXT_PUBLIC_*` name, a log, a screenshot or a
report. None of them may appear in the client bundle — §8 below checks for
that directly.

Plaid cannot reach `localhost`. For the webhook section, either deploy a
preview and point `PLAID_WEBHOOK_URL` at it, or run a tunnel (`cloudflared
tunnel --url http://localhost:3000`, `ngrok http 3000`) and use the https URL
it prints. **Without a publicly reachable URL, the webhook section (§6 below)
cannot be done and must be reported as a limitation, not as a pass.**

## 2. Prove the environment before any provider call

Run these first and stop if any answer is wrong.

**The code-level proof** — that sandbox credentials can only reach the sandbox
host, that production is never a default, and that a missing piece means no
provider at all:

```bash
npx vitest run src/server/bank-connections/providers/plaid/config.test.ts src/lib/env.test.ts
```

**The running-deployment proof**, which needs no extra tooling and prints no
secret: start the app with the sandbox variables set and open
`/app/<orgId>/bank-connections`. The page must say **"Bank connections use
Plaid"** and carry the warning that this is a **sandbox** environment whose
data is fictional. That sentence is rendered from `plaidConfig().environment`,
so seeing it *is* the proof that `PLAID_ENV=sandbox` reached the adapter. If
the page shows no sandbox warning while Plaid is configured, the environment
is production — **stop, and remove the credentials**.

The same fact is recorded on every connection as
`bank_connections.provider_environment` (immutable by trigger, migration 0048),
so it can be re-checked later in SQL:

```sql
select provider, provider_environment from bank_connections where id = '…';
-- expect: plaid | sandbox
```

Keep a terminal on `.next` server logs for the whole run; every event below is
observable there (`bank.*` event names, `BANK-SYNC-WORKER.md` §7).

## 3. Link flow (Task 14 §3)

1. Sign in, open `/app/<orgId>/bank-connections`, press **Connect a bank**.
2. In Plaid Link choose **First Platypus Bank** (`ins_109508`), the standard
   sandbox institution, and sign in with the sandbox test user
   (`user_good` / `pass_good`; any 4-digit MFA code where asked).
3. Complete Link.

Capture, from the browser's network panel and the database:

* the `startBankLink` response — it must contain **only** `linkToken` and
  `mode`; no provider id, no organization internals, no token;
* the `completeBankLink` request — the `public_token` goes up, nothing comes
  back but a connection id;
* `select status, provider, provider_environment, institution_name from
  bank_connections where id = …` → `ACTIVE`, `plaid`, `sandbox`;
* `select count(*) from bank_linked_accounts where connection_id = …` and each
  account's `mask` — the mask is 4 characters; no full account number exists
  anywhere;
* `select key_id, algorithm, length(ciphertext) > 0 as has_ciphertext,
  length(iv), length(auth_tag) from bank_provider_secrets where connection_id
  = '…'` → the key id you configured, `AES-256-GCM`, true, 16, 24; and
  `select left(secret_ref, 4) from bank_connection_credentials where
  connection_id = '…'` → `enc:`.

Then prove the credential boundary without printing a token:

```sql
-- Must all be zero.
select count(*) from bank_provider_secrets where ciphertext like 'access-%';
select count(*) from bank_connections where provider_connection_id like 'access-%';
select count(*) from audit_logs where metadata::text like '%access-sandbox-%';
```

and that the server can still read it — which the next step proves for real
rather than by inspection: the initial sync below can only succeed if the
stored credential decrypted, because the access token is what
`/transactions/sync` is called with. A sync that reaches `SUCCEEDED` **is** the
decryption proof, and no token needs to be printed to obtain it.

## 4. Initial sync through the worker (§5, §6)

Do **not** call the engine directly. Use the endpoint:

```bash
curl -s -X POST "$APP_URL/api/bank-connections/worker" -H "Authorization: Bearer $BANK_SYNC_WORKER_SECRET"
```

Before that, prove the gate: the same call with no header (**401**), with a
near-miss secret (**401**), and — after temporarily unsetting the secret and
restarting — **404**. The successful response body must be counters only.

Then record:

* `select status, trigger, attempts from bank_sync_jobs where connection_id = …`
  → the `INITIAL` job `SUCCEEDED` on attempt 1;
* `select pages_fetched, transactions_added, transactions_modified,
  transactions_removed, ledger_imported, duration_ms from bank_sync_runs …`;
* `select md5(page_cursor) from bank_connections where id = …` — **a
  fingerprint, never the cursor itself**;
* the ledger: `select count(*), sum(amount_minor) from transactions where
  organization_id = … and source = 'bank_sync'`, and that
  `select count(*) from transactions where amount_minor::text like '%.%'` is 0
  (no float ever reaches money).

Link one bank account to a Countorra account first if you want ledger rows —
until an account is linked, imports sit in `AWAITING_ACCOUNT_LINK` by design.

## 5. Incremental sync and idempotency (§7)

1. Record `md5(page_cursor)` and `md5(committed_cursor)`.
2. Invoke the worker again (a manual refresh inside five minutes is refused on
   purpose — queue a sync via the scheduler or wait).
3. Expect `transactions_added: 0` and an unchanged ledger count.
4. Fire new sandbox activity, then sync again and expect only the delta:

```bash
curl -s -X POST https://sandbox.plaid.com/sandbox/item/fire_webhook \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"'"$PLAID_CLIENT_ID"'","secret":"'"$PLAID_SECRET"'","access_token":"<sandbox item token>","webhook_code":"SYNC_UPDATES_AVAILABLE"}'
```

Report cursor **fingerprints before and after**, and added/modified/removed
counts. Never the cursor value.

## 6. Webhook (§8)

With `PLAID_WEBHOOK_URL` publicly reachable, fire the webhook above and check:

* the route answered **200** in milliseconds, before any provider call
  (`bank.webhook_handled` with `outcome: SYNC_ENQUEUED`);
* `select status, event_type, outcome from bank_webhook_events order by
  received_at desc limit 1`;
* a `WEBHOOK` job appears `QUEUED`;
* the next worker invocation runs it and the ledger changes exactly once;
* replay the same delivery (same body, same `plaid-verification` header) and
  expect `{"received":true,"duplicate":true}` and **no second job**;
* tamper with one byte of the body and expect **400**, with nothing written.

Do not relax verification to make this pass. If the URL cannot be made public,
report §8 as a limitation.

## 7. Pending → posted, reauthentication, disconnect, scheduler (§9–§12)

| Scenario | How to drive it in sandbox |
| --- | --- |
| Pending → posted | Sandbox ships mostly posted transactions; a pending one can be created with `/sandbox/transactions/create` on a `transactions`-enabled item, then advanced. If it cannot be reproduced reliably, report `NOT VERIFIED — SANDBOX SCENARIO LIMITATION`. |
| Reauthentication | `POST /sandbox/item/reset_login` → next sync returns `ITEM_LOGIN_REQUIRED` → connection must become `REQUIRES_REAUTH`, the scheduler must stop queueing it, "Sign in again" must open update-mode Link, and after Link the connection must return to `ACTIVE` and sync. |
| Disconnect | Press **Disconnect** → `/item/remove` is called, `bank_provider_secrets` row for that connection is gone, connection is `DISCONNECTED`, imported ledger rows remain, and a second disconnect is a no-op. |
| Scheduler | Backdate `last_sync_attempt_at` by seven hours, invoke `?mode=schedule` twice, expect exactly one `SCHEDULED` job, then `?mode=work` to run it. |

## 8. Live security checks (§13)

```bash
# Client bundle and page HTML: names may appear, values must not.
grep -rIl -- "$PLAID_SECRET" .next/static .next/server 2>/dev/null   # expect no output
grep -rIo "access-sandbox-[A-Za-z0-9-]*" .next 2>/dev/null           # expect no output
```

In the browser console on the Bank connections page, check
`localStorage`, `sessionStorage`, `document.cookie` and the page HTML for
`access-`, `public-`, `link-sandbox-`, the client id and the secret. The only
Plaid values that may appear are the short-lived `link_token` while Link is
open and `cdn.plaid.com` as a script host.

Multi-tenancy, with a second organization signed in as a different user: it
must not be able to read the connection, refresh it, disconnect it, or see it
in its own workspace. The automated equivalents already run in
`tests/rls/bank-connections.test.ts` and `tests/rls/bank-worker.test.ts`.

## 9. Cleanup (§17)

Disconnect the sandbox item through the UI (which calls `/item/remove` and
destroys the credential), then confirm `bank_provider_secrets` holds nothing
for it. Keep the connection row and the imported rows only if they are wanted
as audit evidence — and if they are kept, they stay labelled
`provider_environment = 'sandbox'`, which the UI shows as **Sandbox — test
data**. Remove `PLAID_*` and the worker secret from the environment afterwards
if the machine is shared. Never touch "My finances" or any unrelated data.

## 10. Known sandbox limitations to expect

* Plaid cannot reach `localhost`; webhooks need a public https URL.
* Sandbox institutions return a fixed, small transaction set, so volume
  behaviour (continuations at 20 pages) is not exercised by sandbox data —
  that is covered against real Postgres with 1,600 synthetic transactions in
  `tests/rls/bank-scheduler.test.ts`.
* Sandbox item states are driven by `/sandbox/*` endpoints rather than by
  natural bank behaviour, so timing-dependent paths (a lease expiring
  mid-page) are exercised in tests, not live.
* `/sandbox/*` endpoints are deliberately **not** in the gateway: the
  production adapter has no sandbox-only methods. Drive them with curl, as
  above.
