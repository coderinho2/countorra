# RATE LIMITING SECURITY HARDENING

**Date:** 2026-09-05 · **Scope:** the last blocking item from the Security Red
Team Audit and the Live Supabase Security Verification.

No secret value appears in this document, in the source, in logs, or in test
output.

---

## Executive summary

**Implemented:** server-side, distributed, atomic rate limiting across eight
operations, enforced inside the Server Actions themselves — not in the UI, not
in the proxy — so calling the backend directly hits the same control.

**Backing store:** Postgres, via a `SECURITY DEFINER` function
(`consume_rate_limit`) reachable only by the service role. Counters are not
readable or writable by any client role. Migration `0026_rate_limiting.sql` is
applied to the live project and verified there.

**Atomic:** yes. The whole decision is one
`insert … on conflict do update … returning` statement. Proven against the real
project, not just locally: **40 genuinely parallel HTTP requests against a
limit of 5 admitted exactly 5**, and 50 parallel increments lost none. A
read-then-increment limiter fails both — which matters, because this codebase
has already shipped that bug twice (AI action execution, AI usage metering).

**Provider work is prevented before the limit check:** yes. In `sendAiMessage`
the order is authenticate → authorize → **rate limit** → plan entitlement →
persist → Anthropic. Verified by test: after the limit is reached, the provider
is called 0 further times and the user's message is not even written.

**Plan entitlements are a separate control:** free 3/day, premium 100/day,
business 500/day, each enforced independently of the rate limiter. (These were
re-cut from 20/300/unlimited; Business in particular was `null`, which the
enforcement site read as "skip the meter" rather than "a high ceiling".) Rate
limits are layered on top; both must pass. Tested in both directions — under
the rate limit an exhausted plan still refuses, and under the plan limit an
exhausted rate budget still refuses.

**Status: RESOLVED**, with one honest scope note in
[Remaining risks](#remaining-risks): IP-scoped rules assume a trusted proxy.
Every operation that has a stable identity also carries an identity-scoped
rule, which is not spoofable — and that is demonstrated live, not asserted.

---

## Architecture

### Backing store: Postgres

A rate limiter is only a control if every instance shares it. The repository
has no deployment config pinning it to a single process, so it must be assumed
it can run as several (serverless, or containers behind a load balancer). That
rules out an in-memory `Map` as the authoritative limiter.

The alternatives were Redis/Upstash or Postgres. Redis would have meant adding
a vendor and a secret that **are not configured on this project** — shipping
something that only looks protected until an operator wires it up, which the
brief explicitly warns against. Postgres is already the shared, durable,
transactional store every instance talks to, and it gives the property that
actually matters here for free: single-statement atomicity.

```
rate_limit_counters (namespace, key_hash, window_start) → count, expires_at
```

`window_start` is part of the primary key, so a new window is a new row and
expiry needs no reset path. Rows are pruned opportunistically inside the
function (roughly 1 call in 100) because no scheduler is guaranteed on this
project — `pg_cron` is not enabled.

**Contention.** One hot row per key per window. Postgres serializes writers to
a row; at this product's scale that is not a bottleneck, and the alternative
(sharded counters) would trade exactness for throughput this application does
not need. Worth revisiting only if a single key ever sustains thousands of
writes a second.

### Key strategy

Layered, never IP-only. Every operation with a stable identity is keyed on that
identity as well as on the address, so neither dimension alone is a bypass:

| Operation | Keys |
|---|---|
| Login / signup / password reset | connecting address **and** hashed normalized identifier |
| AI message | authenticated user **and** authorized organization **and** address |
| AI action confirmation | authenticated user |
| Insight regeneration | authorized organization |
| Document upload, search | authenticated user |

The user and organization come from `requireOrgMembership`, which runs first —
so a forged or unrelated `organizationId` in the payload never reaches the
limiter, it redirects out before that line. Nothing is keyed on a value the
client can assert.

### Privacy

Identifiers are stored as a salted HMAC-SHA256, never in the clear. Without
that, `rate_limit_counters` would become a list of every email address that has
ever attempted to sign in and every address it came from — a materially worse
thing for a financial product to hold than a counter. HMAC rather than a plain
digest so the value is not brute-forceable from a known email list by anyone
holding a database dump. Verified by test: the stored key is 64 hex characters
and contains neither the address nor the email.

Email normalization is case and surrounding whitespace only. Gmail-style dot
and plus-tag stripping is deliberately **not** done: it differs per provider,
and getting it wrong would merge two genuinely different accounts into one
limit.

The pepper is `RATE_LIMIT_HASH_SECRET` when configured; when it is not, it is
derived from the service-role key, which is always present — so **the limiter
is fully functional with no additional configuration**. The one consequence,
documented rather than hidden: rotating the service-role key changes the pepper
and resets in-flight windows (minutes to an hour). Setting the variable
decouples the two.

### Failure mode

Chosen per category, because the cost of being wrong differs:

| Category | Mode | Why |
|---|---|---|
| Authentication | **closed** | Free: the limiter's store *is* the auth store. If Postgres is unreachable, Supabase Auth cannot verify a password either — so failing closed costs no availability while removing "take the limiter down, then brute force". |
| AI | **closed** | The point is denial-of-wallet protection against a paid provider. A control that evaporates on a store hiccup is not a control. An outage means the assistant is briefly unavailable; the alternative is an unbounded bill. |
| Upload, search | **open** | Cheap, already authenticated and tenant-scoped. Breaking the product because a counter could not be incremented is worse than the abuse it would prevent. |

Nothing is ever *silently* bypassed: a store failure always sets
`degraded` on the decision and emits a warning naming the namespace.

### Defence in depth, not a replacement

A small process-local map short-circuits a key this instance has already
refused in this window, saving a database round trip so the limiter cannot
itself become the load. It is explicitly **not** authoritative — being
per-instance, it can only ever refuse a request the shared store would also
have refused, never admit one it would not. Seen working in the e2e logs as
`(local-precheck)`.

---

## Protected operations

| Operation | Boundary | Placed after | Placed before |
|---|---|---|---|
| `signIn` | Server Action | input validation | the credential check |
| `signUp` | Server Action | input validation | account creation |
| `requestPasswordReset` | Server Action | input validation | the reset email |
| `sendAiMessage` | Server Action | authn + authz | plan check, persistence, **Anthropic** |
| `confirmAiAction` | Server Action | authn + authz | role check, claim, tool execution |
| `refreshInsights` | Server Action | authn + authz | the 2000-row read and detector passes |
| `uploadDocumentAction` | Server Action | authn + authz + role | the storage write |
| `globalSearch` | Server Action | authn + authz | the four-table fan-out |

Deliberately **not** limited: ordinary CRUD reads and writes, which are cheap,
authenticated, tenant-scoped and RLS-bounded. Limiting them would add friction
without removing an abuse case.

---

## Limits

Every value is in `src/domain/security/rate-limit-policy.ts` with its rationale
attached to the rule itself, so the number and the reason cannot drift apart.

| Rule | Limit | Window | Fail | Why this number |
|---|---:|---:|---|---|
| `auth:login:ip` | 10 | 5 min | closed | A person mistypes twice or three times. Leaves room for an office behind one NAT address while cutting spraying to ~2/min per host. |
| `auth:login:id` | 5 | 15 min | closed | The rule that survives IP rotation. 20/hour per account makes credential stuffing uneconomic no matter how many hosts an attacker has. |
| `auth:signup:ip` | 5 | 1 hour | closed | A real person creates one account. Permits retries after a validation error; makes account farming visibly slow. |
| `auth:signup:id` | 3 | 1 hour | closed | Repeat signups for one address are a retry or an attempt to spam that inbox with confirmation mail. |
| `auth:reset:ip` | 10 | 1 hour | closed | Password reset is a mail-sending primitive; bounds its use as a relay. |
| `auth:reset:id` | 3 | 1 hour | closed | Stops flooding a specific victim's inbox to bury a genuine security notification. |
| `ai:message:user` | 5 | 1 min | closed | The most expensive request the product makes — two Anthropic round-trips plus tool execution. A person reads an answer before asking again. |
| `ai:message:org` | 30 | 1 min | closed | Bounds the whole tenant, so a business plan (no daily cap) cannot become unmetered spend by driving several accounts at once. |
| `ai:message:ip` | 60 | 1 min | closed | Backstop against one host driving many accounts it holds credentials for. |
| `ai:confirm:user` | 20 | 1 min | closed | Confirming executes a real financial write; a burst is a bug or an attempt to race the confirmation gate. |
| `insights:refresh:org` | 3 | 5 min | closed | 2000-row read plus detector passes plus admin-client writes. The existing 5-minute window prevents duplicate *writes*, not the read. |
| `documents:upload:user` | 30 | 1 hour | open | 20 MB per file makes this a storage-cost surface; far above real bookkeeping use. |
| `search:query:user` | 60 | 1 min | open | The palette queries four tables per keystroke-pause. Invisible while typing; caps a scripted scan. |

**Fixed windows, not sliding.** A fixed window admits up to 2× the limit across
a boundary in the worst case. A sliding window would need a sorted set or
several rows per request, which is not worth the write amplification here.
Where the boundary effect actually matters (login, AI) two rules of different
lengths are layered, which bounds the burst far more tightly than either alone.

---

## Attack results

Every row was executed. `boundary` = the Server Action called directly, with no
UI. `live` = real HTTP against the live Supabase project. `e2e` = a real
browser through the running application.

| Attack | Boundary | Expected | Actual | Status |
|---|---|---|---|---|
| Login brute force, one account | boundary | refused after 5 | refused; Supabase Auth called exactly 5× | **BLOCKED** |
| Login brute force | e2e (real browser) | refused | `auth:login:id (limit-exceeded)` | **BLOCKED** |
| Credential stuffing, IP rotation | boundary | identifier rule holds | refused; auth called 5× | **BLOCKED** |
| Credential stuffing, IP rotation | e2e, spoofed `x-forwarded-for` per attempt | identifier rule holds | `auth:login:id (limit-exceeded)` | **BLOCKED** |
| Password spraying, identifier rotation | boundary | IP rule holds | refused; auth called 10× | **BLOCKED** |
| Case/whitespace variants of one account | boundary | one bucket | 5 spellings shared one budget | **BLOCKED** |
| Rate-limit response as an existence oracle | boundary | identical output | response sequences byte-identical for real vs unknown address | **BLOCKED** |
| Rate-limit response as an existence oracle | e2e | identical output | only the two generic strings ever returned | **BLOCKED** |
| Signup abuse (account farming) | boundary | refused after 5 | 5 accepted, 3 refused | **BLOCKED** |
| Password-reset flooding | boundary | refused after 3 | reset mail sent exactly 3× | **BLOCKED** |
| AI burst, one user | boundary | provider stops | provider called exactly 5× | **BLOCKED** |
| AI burst — message persistence | boundary | nothing persisted past limit | 5 user messages written, not 9 | **BLOCKED** |
| AI concurrent burst (12 parallel) | boundary | exactly 5 | exactly 5; provider called 5× | **BLOCKED** |
| AI burst — organization-ID manipulation | boundary | per-user rule holds | refused on a different org id | **BLOCKED** |
| AI burst — conversation-ID manipulation | boundary | per-user rule holds | refused across 5 distinct conversations | **BLOCKED** |
| AI burst — header manipulation | boundary | per-user rule holds | refused after rotating XFF, `x-real-ip`, UA | **BLOCKED** |
| AI burst — multi-tab / multi-session | boundary | per-user rule holds | refused across independent cookie sets | **BLOCKED** |
| AI abuse spread across 12 accounts in one org | boundary | org rule holds | exactly 30 admitted | **BLOCKED** |
| Direct Server Action invocation (no UI) | boundary | same limits apply | every test above is a direct call | **BLOCKED** |
| Burn a victim's login budget (counter write) | live | denied | `42501` for anon and authenticated | **BLOCKED** |
| Reset own counters (counter delete) | live | denied | `42501` for anon and authenticated | **BLOCKED** |
| Read counters (is this account under attack?) | live | denied | `42501` for anon and authenticated | **BLOCKED** |
| Call `consume_rate_limit()` directly | live | denied | `42501` for anon and authenticated | **BLOCKED** |
| 40 parallel requests vs a limit of 5 | live | exactly 5 | exactly 5 | **BLOCKED** |
| 50 parallel increments (lost update) | live | count = 50 | count = 50 | **BLOCKED** |
| Rate-limit backend failure — auth | boundary | fail closed | refused; credential check never ran | **BLOCKED** |
| Rate-limit backend failure — AI | boundary | fail closed | refused; provider never called | **BLOCKED** |
| Rate-limit backend failure — search/upload | boundary | fail open, flagged | allowed, `degraded` set, warning logged | as designed |
| Unauthorized caller consuming a victim org's budget | boundary | authz first | redirect; zero counters touched | **BLOCKED** |
| Plan entitlement bypass via rate limiter | boundary | independent | free 3/day, premium 100/day and business 500/day still refuse | **BLOCKED** |
| Error message leaking rule / identifier / org | boundary | generic only | matches `^Too many requests\.`, no ids | **BLOCKED** |

---

## Tests

| Check | Result |
|---|---|
| `npm run typecheck` | clean, 0 errors |
| `npm run lint` | clean, 0 errors, 0 warnings |
| `npm test` | **315 passed / 315** (32 files) — was 275; +40 |
| `npm run e2e` | **14 passed / 14** — was 11; +3 |
| `npm run build` | success |
| `npm audit` | 0 vulnerabilities (dev and production) |
| Live rate-limiter verification | **13 / 13 blocked or correct** |
| Remote migration state | **26 / 26 applied, in sync** |

New tests:

- `tests/rls/rate-limiting.test.ts` (13) — the store against real Postgres:
  exact counting, remaining budget, retry-after, blocked attempts still
  counting, namespace and key isolation, window rollover, burst exactness,
  rejection of nonsensical parameters, and the full client-role denial matrix.
- `tests/security/rate-limit-boundary.test.ts` (27) — the Server Actions called
  directly, which is the bypass that matters. Key derivation, grouping, failure
  modes and ordering are the real implementation; only the Postgres round trip
  is substituted.
- `tests/e2e/rate-limit.spec.ts` (3) — a real browser, over HTTP, through the
  Server Action, against live Postgres. Includes the IP-rotation
  demonstration.

No existing test was weakened. No dependency was added.

---

## Configuration

Nothing must be configured for the limiter to work. One optional variable, name
only, added to `.env.example`:

```
RATE_LIMIT_HASH_SECRET=
```

Optional pepper for identifier hashing. Unset, it is derived from
`SUPABASE_SERVICE_ROLE_KEY`. Set it (any random 16+ character string) so that
rotating the service-role key does not reset in-flight windows.

---

## Remaining risks

**1. IP-scoped rules assume a trusted proxy.** `x-forwarded-for` is only
trustworthy when a proxy the operator controls sets it. Deployed behind a
platform that terminates TLS and rewrites the header (Vercel, Fly, Cloudflare,
an ALB) the leftmost entry is the real client. **Exposed directly to the
internet, a client can send any value and the IP rules become decorative.**

This is demonstrated rather than asserted: `tests/e2e/rate-limit.spec.ts`
rotates a spoofed `x-forwarded-for` per attempt and the IP rule is duly evaded —
while the per-identifier rule still fires. That is why every auth operation
carries both, and why the identifier rule is the load-bearing one. **Operator
action: ensure the deployment sits behind a proxy that overwrites
`x-forwarded-for`.**

**2. Fixed windows admit a 2× boundary burst.** Bounded in practice by layering
two windows on the operations where it matters. Accepted, documented, not
hidden.

**3. This is application-level protection, not edge protection.** A volumetric
flood still reaches the Next.js process and costs a database round trip per
request (softened, not removed, by the process-local pre-filter). Layer-3/4
and volumetric defence remains an infrastructure concern — a WAF or the
platform's own DDoS protection. That was always outside what application code
can do, and it does not block launch the way the *absence* of application-level
limiting did.

**4. Unlimited organization creation** (informational finding I-3 from the
original audit) still lets one account hold many organizations. The per-user AI
rule binds regardless, so this is no longer an AI-cost path — but it remains
worth capping.

**5. Not limited:** `signInWithGoogle` (the provider is disabled on this
project and the action only builds a redirect URL) and `resetPassword` (the
password *change*, which already requires a valid recovery session). Both are
low-value surfaces; noted rather than silently omitted.

---

## Verdict

**RATE LIMITING: RESOLVED.**

It is implemented, distributed, atomic, enforced server-side ahead of every
expensive operation, verified against the real Supabase project under genuine
concurrency, and it requires no unconfigured external service to function.

The one qualification is scope, not readiness: IP-scoped rules need a trusted
proxy in front of the application to be meaningful, and identity-scoped rules
hold either way. That is a deployment topology note for the operator, not a
missing dependency.
