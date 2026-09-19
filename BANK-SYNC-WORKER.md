# Bank sync worker and scheduler

How queued bank sync work actually runs, and exactly what a production
deployment has to invoke. Provider-independent: nothing here knows what Plaid
is. See [PLAID-INTEGRATION.md](PLAID-INTEGRATION.md) for the provider adapter
and [ARCHITECTURE.md](ARCHITECTURE.md) for how the layers fit together.

## 1. What runs the work

```
scheduler (per invocation)              worker (per invocation)
  reclaim abandoned leases                claim ONE due job  (FOR UPDATE SKIP LOCKED)
  connections due for a sync              executeClaimedSyncRun
  enqueue SCHEDULED jobs                    → BankConnectionProvider → ledger
                                          repeat until job budget / deadline / empty queue
```

| Piece | Where |
| --- | --- |
| Worker and scheduler | `src/server/bank-connections/worker.ts` |
| Bounds and policy (pure) | `src/domain/bank-connections/worker.ts` |
| One job's work | `executeClaimedSyncRun` in `src/server/bank-connections/sync.ts` |
| Claim, heartbeat, sweep, due query | migration `0049_bank_sync_worker.sql` |
| HTTP entry point | `POST/GET /api/bank-connections/worker` |

Postgres is the only queue. There is no Redis, no broker, no in-memory list:
the jobs were already durable rows with a state machine, a lease, an
idempotency key and a one-active-job index — what was missing was a claim
operation, not infrastructure.

## 2. What production has to invoke

One authenticated HTTP call, on a schedule:

```
POST https://<your-origin>/api/bank-connections/worker
Authorization: Bearer $BANK_SYNC_WORKER_SECRET
```

* `?mode=both` (default) — reclaim abandoned leases, queue due syncs, then work
* `?mode=schedule` — reclaim and queue only
* `?mode=work` — execute queued jobs only

`GET` is accepted too, because Vercel Cron issues GET. Every verb needs the
secret. Ideal cadence: **every five minutes**; the deployed Vercel cron runs
**once a day** (see below). Nothing breaks at any cadence — a scheduled sync is
keyed to a six-hour window, so more frequent invocations create no extra
provider traffic, and less frequent ones only delay webhook-triggered imports,
retries and continuations.

On Vercel this is already configured — `vercel.json` at the repository root:

```json
{
  "crons": [{ "path": "/api/bank-connections/worker", "schedule": "0 6 * * *" }]
}
```

* Vercel runs crons on the **production** deployment only, never on previews.
* Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. The route checks it
  exactly like any other caller against `BANK_SYNC_WORKER_SECRET` — a cron call
  gets no exemption from the secret or the rate limit — so **set `CRON_SECRET`
  to the same value as `BANK_SYNC_WORKER_SECRET`**. If they differ, every cron
  call is refused and the route reports `bank.worker_cron_secret_mismatch` at
  **error** severity (only when the caller presents `CRON_SECRET` itself, so a
  stranger's wrong guess can never raise it).
* **Daily, because of Vercel Hobby.** Hobby refuses to deploy a cron that runs
  more than once a day, and may fire a daily cron at any minute within the
  scheduled hour (here 06:00–06:59 UTC, overnight in the US). What that means:
  * each connection gets its scheduled sync once a day, overnight;
  * a Plaid webhook's queued import, a retry and a continuation wait until the
    next daily run — up to a day;
  * manual refreshes, new links and repairs are unaffected: they run in the
    request, not in the worker;
  * a job that waited more than 30 minutes is reported as
    `bank.worker_backlog` (warning) on the run that picks it up. On a daily
    schedule that warning is expected whenever webhooks queued work, and is
    not by itself a fault.
* **For faster imports without Pro**, keep the daily Vercel cron and add an
  external scheduler calling the same URL every five minutes — GitHub Actions
  or Supabase `pg_cron` (examples in DEPLOYMENT.md §7). Both are free, both use
  the same secret, and running more often costs nothing extra. On **Pro**, set
  the schedule back to `*/5 * * * *` and update tests/server/vercel-config.test.ts.
* Hobby is for non-commercial use under Vercel's terms; a paid product
  belongs on Pro.

Anywhere else — GitHub Actions, a systemd timer, Cloud Scheduler, a Kubernetes
CronJob, Supabase `pg_cron` + `pg_net`, a long-running container in a `while`
loop with `sleep 300`, or a person with curl — call the same URL with the same
header. Nothing about the work depends on which. See
[DEPLOYMENT.md](DEPLOYMENT.md#worker-cron) for a worked example of each.

A deployment that never invokes it still works: links, manual refreshes and
webhooks all function, but a webhook's queued job, a retry and a continuation
wait for an invocation. **No worker means no automatic imports** — the Bank
connections page then shows "Import queued" and nothing more happens, which is
honest but not what anybody wants in production.

### Configuration

| Variable | Required for the worker | Meaning |
| --- | --- | --- |
| `BANK_SYNC_WORKER_SECRET` | yes | 32+ characters, compared in constant time. Without it the route answers **404** and no background sync exists. |
| `CRON_SECRET` | on Vercel | Must equal `BANK_SYNC_WORKER_SECRET`; it is what Vercel Cron sends. Not a second key. |
| `BANK_SYNC_HEARTBEAT_URL` | no | An https dead-man's-switch URL, pinged after each successful invocation. Never logged. |
| `PLAID_*`, `BANK_CREDENTIAL_ENCRYPTION_KEY` | yes, in practice | With no provider configured the worker claims nothing at all. |

The secret authorizes an operator, not a tenant. The response body is counters
only — no organization, connection, institution, amount, worker identity or
credential — because it ends up in cron logs.

## 3. Bounds

Every one of these is a constant in `src/domain/bank-connections/worker.ts`:

| Bound | Value | Why |
| --- | --- | --- |
| Jobs per invocation | 25 | The rest waits for the next invocation. That is what a durable queue is for. |
| Function limit (route) | 60 s | `export const maxDuration = 60` on the worker route. |
| Start budget per invocation (route) | 30 s | No job is claimed and **no new provider page is started** after it: 60 s − 25 s (one provider call's own timeout) − 5 s to commit and answer. The page in flight always finishes; the rest continues in a CONTINUATION job. |
| Wall clock per invocation (direct callers) | 50 s | The default when `runBankSyncWorker` is called without the route's budget — a long-running worker process, for instance. |
| Jobs claimed per round trip | 1 | A claimed job is leased to this invocation; claiming more would strand leases on work nobody is doing. |
| Scheduled sync interval | 6 h | Well under any provider's per-item limits, and fresh enough that yesterday's transactions are there in the morning. |
| Connections queued per scheduler run | 50 | One invocation cannot point a whole deployment at a provider at once. |
| Leases reclaimed per scheduler run | 100 | Bounded recovery. |
| Attempts per job | 5 | Task 11's limit, unchanged. |
| Backoff | 60 s doubling, capped at 30 min | Task 11's, unchanged. |
| Lease | 600 s, extended per page | Task 11's, unchanged. |
| Pages per run | 20, then a CONTINUATION job | Task 12's, unchanged. |

A worker invocation ends for exactly one of three reasons — `job_limit`,
`time_limit`, `queue_empty` — and says which in its summary and its
`bank.worker_finished` event.

## 4. Claiming, leases and crash safety

`bank_claim_next_sync_jobs(limit, lease_seconds, worker)` selects due jobs
`FOR UPDATE SKIP LOCKED` and claims each through the same transition Task 11
used, recording `bank_sync_jobs.lease_owner` (a worker identity, never readable
by members). Two workers therefore never hold the same job: the first moves it
QUEUED → RUNNING under a row lock, and the second skips the locked row and, on
any later look, sees a job that is no longer claimable.

**The fence is the run id.** Each attempt creates one `bank_sync_runs` row, and
every write a run makes — ingesting a page, moving the cursor, completing —
goes through a SQL function that refuses a run which is not the job's current
attempt. So the dangerous sequence is impossible:

```
worker A owns job → A's lease expires → B reclaims and claims (new run)
  → A comes back and tries to write → rejected; A reports "abandoned"
```

Three things make that safe rather than merely unlikely:

1. **Heartbeat.** Before each page after the first, the worker calls
   `bank_heartbeat_sync_job`. `LOST` means stop now — before the provider call
   and before any write.
2. **The database refuses a renewal of an expired lease** (guard in 0049).
   Ingesting a page renews the lease, so a worker that has lost its lease
   cannot commit a page at all; the whole page, cursor move included, rolls
   back.
3. **The sweep.** `bank_reclaim_expired_sync_leases` fails the abandoned run
   with `LEASE_EXPIRED` and puts the job back in line while attempts remain.
   `LEASE_EXPIRED` is this deployment's failure, not the bank's, so it never
   counts against the connection's health.

### At least once, not exactly once

A crash between a provider response and the database commit means that page is
fetched again. That is safe, and it is the design rather than an accident:

| Crash point | What happens |
| --- | --- |
| After claim | Lease expires → swept → retried. No provider call was made. |
| Before the provider call | As above. |
| After the provider response | The page is fetched again. Ingest is keyed by provider transaction id and content hash, so a repeat adds nothing. |
| Before the ledger commit | Page and cursor move in ONE transaction. Nothing is half-applied. |
| After the ledger commit, before the cursor commit | Not a distinct state: they are the same transaction. |
| After the cursor commit | The next run resumes from the committed cursor and finds nothing new. |
| Before the continuation job is created | The connection keeps its cursor; the next scheduled sync resumes from it. No page is skipped. |

Exactly-once delivery is not available from a bank provider and is not claimed
anywhere in this system.

## 5. What the scheduler will and will not queue

Queued: connections whose status is **ACTIVE** or **DEGRADED** (the last import
did not finish — a scheduled import *is* the retry), with no active job, last
attempted longer ago than the interval, oldest first.

Never queued: **REQUIRES_REAUTH** (waiting for a person), **ERROR** (imports
have stopped and need attention), **PENDING** (a link that was never finished),
**DISCONNECTED** (gone). A connection whose provider this deployment no longer
configures is skipped rather than given work nothing can run.

Running the scheduler twice changes nothing: a scheduled job's idempotency key
is `<connection>|SCHEDULED|window-<n>` where the window is the interval, so the
second invocation is a `DUPLICATE`, and the one-active-job index refuses a
second job for a connection that is already syncing.

## 6. Webhook → worker → ledger

```
Plaid POST → signature verified on the raw body → event claimed by id
  → enqueue WEBHOOK sync job → 200 (a few milliseconds, no provider call)
        ↓
  worker claims it → executeClaimedSyncRun → /transactions/sync → ledger
```

The webhook handler still makes no provider call and writes no financial row.
A redelivered event is the same event id and the same idempotency key, so three
deliveries produce one job and one import.

## 7. Observability

Stable event names, safe fields only:

| Event | Fields |
| --- | --- |
| `bank.worker_started` | worker id, bounds |
| `bank.worker_job_finished` | worker id, job id, connection id, organization id, trigger, attempt, result, failure category, continuation, duration |
| `bank.worker_finished` | worker id, counts by outcome, why it stopped, duration |
| `bank.worker_skipped` | reason (no provider configured) |
| `bank.scheduler_finished` | leases reclaimed, considered, created, already active, duplicates, skipped, interval, duration |
| `bank.sync_leases_reclaimed` | count |
| `bank.sync_lease_lost` | worker id, job id, run id, heartbeat result, pages so far |
| `bank.worker_unauthorized` | route, invoker (`vercel-cron` or `other`) |
| `bank.worker_invocation` | invoker, mode, provider configured, executed, failed, abandoned, why it stopped, duration — **one line per invocation**, `warning` if anything failed |
| `bank.worker_backlog` | due jobs, oldest due age, running-past-lease — **only when unhealthy** (oldest due job older than 30 min, or a lease abandoned): the cron has stopped or cannot keep up |
| `bank.worker_cron_secret_mismatch` | route, invoker — **error**: Vercel is sending a `CRON_SECRET` that is not the worker secret |
| `bank.worker_heartbeat_failed` | HTTP status or error name — never the URL |
| `bank.sync_deadline_reached` | job, run, pages so far — a run stopped at the time budget and left a continuation |

`bank.scheduler_finished` also carries `dueJobs` and `oldestDueAgeSeconds`, so
queue depth is visible on every run without an extra line.

### Knowing the cron is alive

Every signal above is emitted by an invocation — so if the cron stops
entirely, they all go quiet together. Two things cover that:

1. **A dead-man's switch.** Set `BANK_SYNC_HEARTBEAT_URL` to a check at any
   service that alerts when pings *stop* (healthchecks.io, Cronitor, Better
   Stack heartbeats…) with a period matching the cadence — **1 day with ~3
   hours' grace** for the daily Vercel cron (Hobby fires within the hour), or
   5 minutes with ~15 minutes' grace for a five-minute scheduler. The route
   pings it after each successful invocation — not after a refused, rate-limited
   or failed one.
2. **The backlog warning**, which catches the cron running but not keeping
   up.

Never logged: access tokens, public tokens, credential ciphertext, webhook
secrets, account numbers, amounts, merchant names, transaction descriptions, or
a provider's own message. Per-transaction logging does not exist — counts only.

## 8. Tests

| Where | What |
| --- | --- |
| `src/domain/bank-connections/worker.test.ts` | the bounds and the stop decision, pure |
| `tests/rls/bank-worker.test.ts` | claiming (one job/two workers, ten workers, disjoint batches), lease ownership and fencing, retries and backoff, crash points, isolation, a 1,000-job queue read through its index |
| `tests/rls/bank-scheduler.test.ts` | what is queued and what is not, duplicate invocations, a 1,600-transaction backlog drained by continuations alone, webhook → worker → ledger |
| `tests/server/bank-worker-route.test.ts` | 404 with no secret, 401 on a near miss, rate limiting before comparison, modes, counters-only responses |
| `tests/e2e/bank-connections.spec.ts` | queued / importing / retry / failed shown honestly, no progress theatre, nothing secret in the browser |

**One honest limit.** The real-Postgres tests run on PGlite, which is a
single-backend Postgres: two claims cannot physically overlap in-process. What
those tests verify is that a claim is atomic and its outcome exclusive (a job
claimed once is never claimable again; interleaved workers get disjoint sets).
`FOR UPDATE SKIP LOCKED` under true contention is Postgres's own behaviour and
is what makes this safe across connections, but it is not exercised in-process
and is not claimed to be.
