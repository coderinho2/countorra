# Plaid integration

How bank connections work in Countorra, what has to be configured, and how to
operate it. No credential appears in this file, and none belongs here.

Everything below sits behind the provider-independent architecture from Task
11: Countorra's domain talks to `BankConnectionProvider`
(`src/domain/bank-connections/provider.ts`), and Plaid lives entirely inside
`src/server/bank-connections/providers/plaid/`. Replacing or adding a provider
is another adapter in that directory and an entry in
`src/server/bank-connections/providers.ts`.

---

## 1. What has to be configured

All server-only. None may ever be prefixed `NEXT_PUBLIC_` — that inlines it
into the browser bundle.

| Variable | Required | What it is |
|---|---|---|
| `PLAID_CLIENT_ID` | yes | Plaid dashboard → Developers → Keys |
| `PLAID_SECRET` | yes | The secret **for the environment named below**. Sandbox and production have different secrets for the same client id. |
| `PLAID_ENV` | yes | `sandbox` or `production`. Never defaulted or guessed. |
| `BANK_CREDENTIAL_ENCRYPTION_KEY` | yes | Encrypts stored access tokens. See §5. |
| `PLAID_WEBHOOK_URL` | no | `https://<origin>/api/bank-connections/webhooks/plaid`. Omit locally; Plaid cannot reach localhost. |
| `PLAID_REDIRECT_URI` | no | Required only for OAuth institutions, and **must not be set yet**: the return page is per-organization while the URI is one fixed value, so OAuth can serve only one organization. See [DEPLOYMENT.md §6, "Known blocker"](DEPLOYMENT.md#known-blocker-the-oauth-return-page-is-per-organization). |

**All or nothing.** `src/lib/env.ts` refuses a deployment that sets some of
`PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` but not all, and refuses Plaid
without an encryption key. A deployment that can start a bank Link but cannot
store the resulting token would fail on a customer who has already typed their
bank password.

With none of it set, the product runs normally and the Bank connections page
says no provider is configured. Nothing is faked.

`BANK_SYNC_WORKER_SECRET` is also required in practice: it is what lets a
scheduler run the queued sync jobs. See
[BANK-SYNC-WORKER.md](BANK-SYNC-WORKER.md).

Plaid has never been contacted from this repository — no credentials have been
available. The step-by-step procedure for a Sandbox verification, and the
evidence it should produce, is
[PLAID-SANDBOX-VERIFICATION.md](PLAID-SANDBOX-VERIFICATION.md).

## 2. Sandbox versus production

* `PLAID_ENV` is the only switch. The base URL, the provider version string
  (`2020-09-14+sandbox`) and the `provider_environment` recorded on every
  connection all derive from it.
* `bank_connections.provider_environment` is written at link time from the
  adapter and is immutable (`bank_connections_environment_guard`, migration
  0048). Sandbox connections carry a "Sandbox — test data" badge in the UI, and
  the assistant is told the data is fictional.
* **Never put production credentials in a test environment.** No automated test
  in this repository reads `PLAID_*`; the suites use a deterministic double
  (`tests/fixtures/plaid-gateway-double.ts`).
* Sandbox test credentials for the Link dialog are Plaid's own
  (`user_good` / `pass_good`), documented by Plaid, not stored here.

## 3. The Link flow

```
browser: "Connect a bank"
  → startBankLinkAction        (session → membership → bank:manage → rate limit
                                → provider configured? → plan entitled?)
  → POST /link/token/create    (server, with PLAID_CLIENT_ID/SECRET)
  ← link_token                 (short-lived, no credential — the ONLY provider
                                value the browser ever receives)
browser: Plaid's dialog (cdn.plaid.com), customer signs in at their bank
  → public_token
  → completeBankLinkAction     (same gates again)
  → POST /item/public_token/exchange   → access_token + item_id
  → POST /item/get, /institutions/get_by_id  (institution comes from PLAID,
                                              never from the browser)
  → encrypt access_token → bank_provider_secrets
  → bank_connection_credentials keeps only `enc:<uuid>`
  → connection PENDING → ACTIVE, initial sync job queued
```

Nothing the browser sends is trusted beyond ids and the public token: accounts,
balances, institution, status and transactions are all read from Plaid
server-side.

**OAuth institutions** return the customer to `PLAID_REDIRECT_URI`. That page
(`/app/[orgId]/bank-connections/oauth`) re-opens Link with the same token and
the received URL, then finishes through the same actions. It requires a
session like every other page.

## 4. Re-authentication (update mode)

When Plaid reports `ITEM_LOGIN_REQUIRED` (or a webhook says so), the connection
moves to `REQUIRES_REAUTH`, syncing stops, and the page shows "Sign in again".

That button creates a Link token **with the stored access token** (read
server-side, never sent to the browser), and after the dialog closes
`completeBankReauthAction` asks Plaid — `/item/get` — whether the item is
healthy. Only Plaid's answer moves the connection back to ACTIVE. A closed
dialog, or a forged call, changes nothing.

## 5. Credential storage and rotation

* `bank_provider_secrets` (migration 0048) holds AES-256-GCM ciphertext, a
  random 96-bit IV, the authentication tag, and the id of the key used. The
  organization and connection are bound in as additional authenticated data, so
  a row moved to another connection cannot be decrypted at all.
* The table has RLS on with **no policy**, every privilege revoked from `anon`
  and `authenticated`, and is written only by server code with the service role.
* The key never touches the database. A database dump alone decrypts nothing.

**Format.** `BANK_CREDENTIAL_ENCRYPTION_KEY` is `<key-id>:<base64 32 bytes>`,
newest first, comma-separated. A bare base64 key is accepted as id `primary`.

```
openssl rand -base64 32
```

**To rotate:**

1. Add the new key at the FRONT, keeping the old one:
   `BANK_CREDENTIAL_ENCRYPTION_KEY=2027-01:<new>,primary:<old>` and deploy.
   New credentials use the new key; existing rows still decrypt with the old.
2. Re-encrypt each row: `rotateStoredCredential(admin, keyset, connectionId)`
   (`src/server/bank-connections/secret-store.ts`) for every connection.
3. Remove the retired key from the variable and deploy.

Losing the key means no stored credential can be decrypted and every
connection must be linked again. That is the intended trade: the key is the
only thing protecting a bank credential.

## 6. Webhooks

`POST /api/bank-connections/webhooks/plaid`

1. Not configured → `404`, before the body is read or a database client exists.
2. `plaid-verification` (a JWT) is verified: `alg` must be ES256, the key is
   fetched from Plaid by `kid` and cached, an expired key is refused, the
   payload's `request_body_sha256` is compared against the raw body in constant
   time, and `iat` must be within five minutes.
3. The event is claimed in `bank_webhook_events` by
   `(provider, provider_event_id)`. Plaid gives webhooks no id of their own, so
   identity is the SHA-256 of the body it signed: a redelivery collapses onto
   one row, sequentially or concurrently.
4. Only then is the body parsed and classified. Nothing in it is treated as
   transaction data: `TRANSACTIONS:*` enqueues a sync that fetches from Plaid
   with the stored credential.

Handled: `TRANSACTIONS:*`, `ITEM:ERROR`, `ITEM:PENDING_EXPIRATION`,
`ITEM:PENDING_DISCONNECT`, `ITEM:USER_PERMISSION_REVOKED`,
`ITEM:USER_ACCOUNT_REVOKED`, `ITEM:LOGIN_REPAIRED`,
`ITEM:NEW_ACCOUNTS_AVAILABLE`. Anything else is acknowledged with `200` and
recorded as `UNSUPPORTED` — Plaid requires a 2xx, and guessing at an event's
meaning is how state gets corrupted.

Set the URL in `PLAID_WEBHOOK_URL` (it is sent with every Link token) and, for
existing items, through Plaid's `/item/webhook/update`.

## 7. Sync architecture

`/transactions/sync`, cursor-based, at most 500 transactions per request:

```
claim job (RUNNING + run row, one transaction)
  → credential from the secret store
  → page from Plaid  → validate → normalize → ingest + advance cursor (atomic)
  → reconcile changed rows in bounded batches
  → … up to MAX_PAGES_PER_RUN (20), then a CONTINUATION job
  → complete run + job → connection status from the lifecycle rules
```

* `committed_cursor` moves only when a pagination run completes; a
  `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` error resets the page cursor to
  it and retries. Ingestion is idempotent, so replaying pages is harmless.
* Amounts arrive as JSON numbers and become decimal strings immediately
  (`plaidAmountToDecimal`), then integer minor units through
  `src/domain/money`. Positive means money left the account → DEBIT → expense.
* Credit and loan balances have their sign flipped, because Plaid reports what
  is owed as positive. Those figures are display-only; Countorra's balances are
  always derived from the ledger.
* Pending transactions never enter the ledger. The posted transaction that
  replaces one — same id, or a new id with `pending_transaction_id` — is what
  gets imported, so pending → posted cannot produce two ledger rows.
* **A background worker runs queued jobs**: `POST /api/bank-connections/worker`,
  invoked on a schedule with `BANK_SYNC_WORKER_SECRET`. It claims due jobs one
  at a time (`FOR UPDATE SKIP LOCKED`), holds a 600-second lease it extends per
  page, and stops at 25 jobs or 50 seconds. A manual refresh still runs up to
  three pages inline and leaves the rest to it. Periodic syncs are queued every
  six hours per connection. Full detail, including exactly what a deployment
  must invoke: **[BANK-SYNC-WORKER.md](BANK-SYNC-WORKER.md)**.
* Without that secret configured the endpoint answers 404 and nothing imports
  automatically — links, manual refreshes and webhook verification still work,
  but a webhook's queued job waits.

## 8. Retries

Bounded: five attempts, exponential backoff capped at 30 minutes, one active
job per connection (a partial unique index, not application code). A job whose
worker stopped mid-run is recovered by the scheduler's lease sweep with
`LEASE_EXPIRED`, which never counts against the connection's health.

Retried: `INTERNAL_SERVER_ERROR`, `PLANNED_MAINTENANCE`, `INSTITUTION_DOWN`,
`INSTITUTION_NOT_RESPONDING`, `PRODUCT_NOT_READY`, rate limits, cursor resets,
timeouts and network faults.

Not retried: `ITEM_LOGIN_REQUIRED`, `ITEM_LOCKED`, `PENDING_EXPIRATION`,
`ITEM_NOT_FOUND`, `INVALID_ACCESS_TOKEN`, `USER_PERMISSION_REVOKED`,
`INVALID_API_KEYS`, malformed responses.

## 9. Entitlements

Bank connections are a Premium and Business entitlement, read from the
canonical model (`entitlementsFor` → `PLAN_ENTITLEMENTS`). A lapsed
subscription is Free there and therefore Free here.

Whether the **deployment** has Plaid configured is a separate fact and is
checked first: no plan can conjure a provider, and a configured provider does
not grant a Free workspace the feature. The UI states whichever is true.

## 10. Testing

| Suite | What it covers |
|---|---|
| `src/server/bank-connections/providers/plaid/*.test.ts` | Amount, sign, balance, account and transaction mapping; error classification; webhook JWT verification against real ES256 keys (forgery, algorithm confusion, replay, tampering). |
| `src/server/bank-connections/credential-crypto.test.ts` | Encryption round-trip, AAD binding, tampering, key rotation. |
| `tests/server/plaid-adapter.test.ts` | The adapter against a Plaid-shaped double: Link token, exchange, accounts, cursor pagination, provider errors, malformed responses, revoke, item health, webhook verification. Asserts the SDK is imported in exactly one file. |
| `tests/server/bank-secret-store.test.ts` | What the store writes and refuses to return. |
| `tests/rls/bank-provider-secrets.test.ts` | Migration 0048 against real Postgres: unreachable from any browser role, one credential per connection, refused for a disconnected connection, gone with the organization. |
| `tests/rls/plaid-sync-integration.test.ts` | End-to-end against real Postgres: link, import, pending → posted, corrections, removals, currencies, multiple accounts, re-authentication, retries, webhooks, disconnect, 1,000 and 5,000 transactions, log redaction. |
| `tests/e2e/bank-connections.spec.ts` | The page in a browser: unconfigured, plan-locked, ready, and existing-history states. |

To run the live sandbox Link flow manually: set `PLAID_ENV=sandbox` with
sandbox keys and an encryption key, start the app, and connect a bank using
Plaid's sandbox credentials. **No automated test does this**, and nothing in
this repository has been run against a real Plaid environment.

## 11. Disconnecting and deletion

Disconnect revokes the item at Plaid (best effort — a Plaid outage must not
trap a customer), destroys the credential in the store (required), then in one
transaction marks the connection DISCONNECTED, cancels its jobs and detaches its
accounts. Imported transactions stay in the books; late webhooks for it are
recorded and ignored.

Organization deletion destroys every credential first
(`releaseOrganizationBankCredentials`, called by the account-deletion flow) and
refuses to proceed if one cannot be destroyed, so no bank credential is ever
orphaned in the secret store.
