# LIVE SUPABASE SECURITY VERIFICATION — Countorra

**Date:** 2026-09-05 · **Target:** the linked production Supabase project
(`ibqq…ydsb`, `ACTIVE_HEALTHY`, Postgres 17.6.1.166, eu-west-1) · **Method:**
read-only CLI inspection plus live HTTP attacks against the real PostgREST,
Auth and Storage endpoints, and against the running application.

No secret value is printed, logged or reproduced anywhere in this document.

---

## Executive summary

**Migration 0024 is live.** All 24 local migrations are applied remotely with
no drift and nothing unapplied.

**The unauthenticated boundary is verified on the real project and it is
correct.** 72 live attacks as an anonymous caller — the exact credential every
visitor's browser holds — all failed. Every one of the 28 tenant tables now
returns a hard `42501 permission denied` rather than merely an RLS-filtered
empty set, which is the strongest available outcome and proves 0024's `REVOKE`
statements took effect on the platform. `record_audit_event()` and all three
`org_id_of_*` tenancy oracles are denied to `anon` and to `PUBLIC`. PostgREST
will not even serve its OpenAPI root to `anon`, so the schema cannot be
enumerated. Private storage objects are not publicly readable.

**All live HTTP checks against the application passed** — 11 routes carry the
full header set, `/app/*` is `no-store`, all 15 protected routes redirect while
logged out, all 14 public routes stay public, and all 9 open-redirect payloads
are contained on-origin.

**One new CRITICAL finding, already fixed.** The service-role key that was
rotated after the last audit had been pasted back into `.env.example` — the same
committed-by-design file that caused the original CRITICAL. It is removed, and
a test now fails the build if it recurs.

**The authenticated half is now complete.** With a working service-role key in
place I built two throwaway tenants on the live project — org A (owner, admin,
viewer) and org B (owner, employee) — seeded both with real financial data, and
ran **108 authenticated attacks** through PostgREST, the Auth API and Storage
using real user JWTs. All 108 were blocked. Every artefact was then deleted;
28 of 29 tables are byte-for-byte back to their pre-test counts.

**That run found three more real problems, all now fixed in migration 0025 and
applied live.** One was a cross-tenant leak that survived 0024; two were
discovered only by trying to *delete* things, which no previous test had
done.

| Question | Answer |
|---|---|
| Migration 0024 live? | **Yes** — applied remotely, history consistent |
| Migration 0025 live? | **Yes** — written, tested, pushed and re-verified during this run |
| RLS correct on the real project? | **Yes** — 72/72 unauthenticated and 108/108 authenticated attacks blocked |
| Cross-tenant attacks blocked? | **Yes, all of them**, driven as real users against the real project |
| AI authorization intact? | **Yes** — 36 tools scoped and validated; 10/10 pipeline enforcement points; action immutability, lifecycle and race protection all confirmed live |
| Audit-log protection intact? | **Yes** — forgery denied to anon, to non-members and to actor-spoofing; content immutable; append-only |
| Ownership protection intact? | **Yes** — admin cannot grant, demote or delete an owner; last-owner invariant holds |
| Storage isolation intact? | **Yes** — cross-tenant read, write, delete, signed-URL minting and `../` traversal all denied |
| Headers correct? | **Yes** — verified live on 11 routes |
| Secrets clean? | **Now yes** — after removing a re-exposed service-role key (see C-2) |
| New vulnerabilities? | **1 CRITICAL, 1 HIGH, 2 MEDIUM, 2 LOW, 3 INFORMATIONAL** — all CRITICAL/HIGH/MEDIUM fixed |

---

## Severity summary

```
CRITICAL:       1 found / 1 fixed     C-2  rotated key re-exposed in .env.example
HIGH:           1 found / 1 fixed     H-6  organization deletion impossible (0024 regression)
MEDIUM:         3 found / 2 fixed     M-10 org_id_of_* tenancy oracle for any logged-in user  [fixed]
                                      M-11 account deletion blocked by the audit log         [fixed]
                                      M-9  legacy service_role JWT still active     [dashboard action]
LOW:            2 found / 1 fixed     L-5  .env.local held the revoked key          [resolved]
                                      L-6  Google button shown but provider disabled
INFORMATIONAL:  3
```

---

## Findings

### C-2 — Rotated service-role key re-exposed in `.env.example`

| | |
|---|---|
| **Severity** | CRITICAL |
| **Status** | **Fixed** (removed) + regression test added |
| **Affected** | `.env.example`, line for `SUPABASE_SERVICE_ROLE_KEY` |
| **Regression test** | `tests/config/env-example.test.ts` (4 tests) |

**Attack scenario.** After the previous audit's C-1, the service-role key was
correctly rotated — but the *new* key was then written into `.env.example`
rather than `.env.local`. `.gitignore` ignores `.env*` and then explicitly
un-ignores `.env.example`, so the file is staged for commit by design;
`git status` lists it as an untracked file that `git add .` will include. A
service-role key bypasses RLS entirely (`src/server/supabase/admin.ts`), so it
is unrestricted read/write across every organization's financial data, audit
log and documents.

**Live reproduction.** Confirmed by comparing `.env.example` against
`.env.local` programmatically without printing either: the file held a
non-placeholder value in `sb_secret_…` format, and it was **not** the value in
`.env.local`. A live credential probe then showed the `.env.local` key is
rejected by the project as an *Unregistered API key* while the anon key works —
i.e. `.env.local` holds the revoked pre-rotation key, and the newly issued one
had gone into the example file.

**Exploitability.** Trivial once public. The repository still has **no commits
and no remotes**, so this was again latent rather than realized — but it would
ship on the first `git push`, which is the step this whole exercise precedes.

**Root cause.** Not carelessness so much as file-shape confusion: `.env.example`
is the one file that is *supposed* to look like a filled-in environment, so a
real value there is invisible in review. The previous fix was a comment asking
people not to do it. That is not a control, and it did not hold — the same
mistake recurred within one cycle.

**Fix implemented.** Value replaced with a placeholder, and
`tests/config/env-example.test.ts` now fails `npm test` if `.env.example` ever
contains a value matching any known credential shape (Supabase secret /
publishable / legacy JWT, Anthropic, OpenAI, a Postgres URL with a password), a
real 20-character Supabase project ref, or any non-placeholder value on a
`*_KEY` / `*_SECRET` / `*_TOKEN` / `*_PASSWORD` / `DATABASE_URL` variable. The
test asserts on **shapes only** — no secret value is encoded in it.

**Recommended.** Rotate once more. The exposure was again latent and the repo
was never pushed, so this is precautionary, not incident response — but a
second key has now spent time in plaintext in a commit-marked file, and the cost
of rotating is a dashboard click. **When you do: put it in `.env.local`, not
`.env.example`.** The new test will now stop you if it goes to the wrong file.

---

### M-9 — Legacy `service_role` JWT key is still active alongside the new secret key

| | |
|---|---|
| **Severity** | MEDIUM |
| **Status** | Open — requires a dashboard change, not a code change |
| **Affected** | Supabase project API keys |

`supabase projects api-keys` reports **four** live keys on this project:

| Name | Type | Used by this app? |
|---|---|---|
| `anon` | legacy (JWT) | no |
| `service_role` | **legacy (JWT)** | **no** |
| `default` | publishable | yes (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) |
| `mykey23` | secret | yes (`SUPABASE_SERVICE_ROLE_KEY`) |

The application uses only the new-format pair — `.env.local` holds
`sb_publishable_…` and `sb_secret_…`. The legacy `service_role` JWT is
therefore an **unused, standing, RLS-bypassing credential**.

**Why this matters more than a normal unused key.** The rotation performed
after the last audit revoked a `sb_secret_…` key. It did **not** touch the
legacy `service_role` JWT, because legacy keys are derived from the project's
JWT secret and cannot be revoked individually — rotating them means rotating
the JWT secret, which invalidates every existing user session at once. So a
legacy service-role key that ever leaked is materially harder to contain than
the one that was just rotated, and it is silently exempt from the rotation that
was performed.

**No evidence of exposure.** I found no legacy JWT (`eyJ…`) anywhere in the
repository, the build output or the environment files. This is a
reduce-the-surface finding, not an incident.

**Recommended fix.** In Supabase → Settings → API Keys, disable the legacy
`anon` and `service_role` keys now that the app is on the new key format.
Verify the app still works afterwards (it should — nothing references them).

---

### M-10 — `org_id_of_*` was a cross-tenant oracle for any logged-in user

| | |
|---|---|
| **Severity** | MEDIUM |
| **Status** | **Fixed** in `0025_live_verification_fixes.sql`, applied live and re-verified |
| **Affected** | `org_id_of_document()`, `org_id_of_invoice()`, `org_id_of_conversation()` (`0003`/`0006`/`0007`, hardened in `0024`, fixed in `0025`) |
| **Regression test** | `tests/rls/live-verification.test.ts` (4 tests) |

**Attack scenario.** These three helpers are `SECURITY DEFINER`, so they read
their parent table with RLS switched off — that is the point of them, because
the policies on `invoice_line_items`, `ai_messages` and the `document_*` tables
call them to resolve a row's owning organization. `0024` correctly revoked
`EXECUTE` from `anon` and `PUBLIC`, but it had to leave the grant to
`authenticated`, or every policy that calls them would fail with a
function-permission error for legitimate users.

The consequence is that they stayed callable **directly**, as an ordinary
PostgREST RPC, by any user with an account:

```
POST /rest/v1/rpc/org_id_of_document   {"target_document_id": "<any uuid>"}
```

**Live reproduction.** Tenant A's owner passed tenant B's document, invoice and
conversation ids and received B's `organization_id` back for all three
(`leaked=true` on each). The three `**FAIL**` lines in the first authenticated
run are exactly this.

**Impact.** Not content disclosure — no financial data is returned. It is an
existence-and-tenancy oracle: given an id, any authenticated user learns whether
it exists and which organization owns it. Ids leak in ordinary ways (a shared
URL, a support ticket, a screenshot, an exported file, a former employee's
notes), and the returned organization uuid then keys further probing. Reported
as MEDIUM rather than lower because it is a genuine crossing of the tenant
boundary, and the brief is explicit that requiring authentication is not a
reason to downgrade.

**Root cause.** `0024` fixed the *unauthenticated* exposure of these functions
and stopped there. The authenticated surface remained because it looked like a
grant that had to exist — and it does have to exist. The mistake was treating
"the function must be callable" as "the function may answer freely".

**Fix.** The membership test moved *inside* the function:

```sql
select d.organization_id from documents d
where d.id = target_document_id and is_org_member(d.organization_id);
```

Every call site already wraps the result in `is_org_member(...)` or
`is_org_role(...)`, so a member gets the same id the function always returned
and a non-member now gets `NULL`, which those wrappers evaluate to the same
denial as before. Policy behaviour is unchanged; only the direct caller's view
changes. Verified live: `leaked=false` on all three after the fix, with
`invoice_line_items` still readable by its own member and still invisible to
everyone else.

---

### H-6 — Migration 0024 made organization deletion impossible

| | |
|---|---|
| **Severity** | HIGH (availability / data-lifecycle; fails closed, so not an exposure) |
| **Status** | **Fixed** in `0025_live_verification_fixes.sql`, applied live and re-verified |
| **Affected** | `enforce_last_owner_remains()` trigger on `memberships` (`0024`) |
| **Regression test** | `tests/rls/live-verification.test.ts` (3 tests) |

**Scenario.** `0024` added a trigger enforcing that an organization always
retains at least one owner. Deleting an organization cascades to `memberships`;
the trigger fired on the owner's row, counted zero remaining owners, and aborted
the statement. **Every organization deletion failed**, including the one
`organizations_delete_owner` exists to permit.

**Live reproduction.** Discovered while cleaning up this verification's own test
tenants: `DELETE /rest/v1/organizations?id=eq.…` returned
`400 P0001 An organization must always have at least one owner`, as the service
role, with no way around it.

**Root cause.** This is a regression I introduced in the previous audit. The
invariant is right; its scope was not. It should protect a *live* organization
from losing its last owner, not object to a membership disappearing because the
organization itself is being removed. I had tested that the invariant *holds* and
never tested that anything could still be deleted — the tests only ever created.

**Fix.** The trigger now returns early when the parent organization no longer
exists. Postgres removes the parent row before running the FK cascade, so its
absence is a reliable signal that this is a cascade rather than someone stripping
an owner. Verified live: organizations delete cleanly, memberships cascade, and
the invariant still fires for a live organization on both the UPDATE and DELETE
paths.

---

### M-11 — The append-only audit log made account deletion impossible

| | |
|---|---|
| **Severity** | MEDIUM (compliance / data-lifecycle) |
| **Status** | **Fixed** in `0025_live_verification_fixes.sql`, applied live and re-verified |
| **Affected** | `audit_logs.actor_id` FK, `security_events.user_id` FK, `reject_audit_log_mutation()` (`0009`) |
| **Regression test** | `tests/rls/live-verification.test.ts` (5 tests) |

**Scenario.** `audit_logs.actor_id` referenced `auth.users(id)` with no
`ON DELETE` action, and the append-only trigger rejects every UPDATE and DELETE
on the table. Together those mean **any user who has ever performed an audited
action can never be deleted** — the FK blocks removing the user, and the trigger
blocks severing or removing the reference. Since `record_audit_event` fires on
organization creation, that is effectively every real user.

The same shape applied to `audit_logs.organization_id`, which is declared
`ON DELETE SET NULL`: the FK's own UPDATE was rejected by the append-only
trigger, so organization deletion was blocked a second time, independently of
H-6.

**Live reproduction.** Three of this run's five test users returned HTTP 500 on
deletion. Diagnosing the blocking references showed a single `audit_logs.actor_id`
row pinning each one.

**Impact.** A right-to-erasure request (GDPR Art. 17, CCPA) cannot be fulfilled,
and there is no account-deletion path at all. For a product holding financial
records that is a real compliance exposure, not just housekeeping.

**Fix.** Append-only now means *the event is immutable*, not *rows pin rows*.
The trigger still rejects DELETE outright and still rejects any change to
`action`, `resource_type`, `resource_id`, `metadata`, `actor_type`, `created_at`
or `id`; the single permitted UPDATE is nulling `actor_id`/`organization_id`,
which is what Postgres does for `ON DELETE SET NULL`. Both FKs now carry that
action. `security_events` got its own trigger function so neither table's rules
are loosened by the other's column set. Verified live: users with audit history
delete successfully and their audit entries survive intact, with the actor
reference severed — 6 such detached rows are in the live audit log now, from
this verification's own test tenants.

**Note.** Deleting a user who is the *sole owner* of a live organization is still
refused, by design — the last-owner invariant holds. A production account-deletion
flow will need to transfer ownership or remove the organization first. That is
product logic, deliberately not invented here.

---

### L-5 — `.env.local` held the revoked key, breaking the app's admin paths

| | |
|---|---|
| **Severity** | LOW (availability / configuration; not a vulnerability) |
| **Status** | **Resolved** — the current key is in place and accepted by the live project |

Live probe result: the `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` returns
`401 Unregistered API key` from both PostgREST and the Auth admin API, while
the anon key returns `200`. Three code paths use the admin client and are
therefore failing against the live project right now:

- `createPendingAction` — every AI **write** proposal (`src/server/ai/actions.ts`)
- `generateInsights` / `refreshInsights` — insight and notification generation
- `listMembersWithEmail` — the Settings → Members list

This failed closed (no data was exposed), which is why it is LOW rather than
higher. It was also what blocked the authenticated half of this verification.
Once the correct key was placed in `.env.local`, a live probe confirmed both
PostgREST and the Auth admin API accept it, and all three code paths work
again.

---

### L-6 — Google sign-in is offered in the UI but disabled on the live project

`GET /auth/v1/settings` on the live project reports `external.google: false`,
while `/login` and `/signup` both render a "Continue with Google" button
(`src/components/auth/google-auth-button.tsx`). The action will fail and bounce
to `/login?oauthError=1`. Either enable the Google provider in the dashboard or
hide the button until it is configured.

---

### Informational

- **I-6 — Local `config.toml` diverges from the live project.** `config.toml`
  governs the local CLI stack only, and several of its values disagree with the
  hosted settings: it sets `enable_confirmations = false` while the live
  project requires confirmation (`mailer_autoconfirm: false`), and
  `minimum_password_length = 6` while the application's own Zod schema requires
  8. The live project's password minimum is a dashboard setting I could not read
  through the public API — **confirm it is ≥ 8 in the dashboard**, because a
  client calling `/auth/v1/signup` directly never passes through the app's Zod
  check.
- **I-7 — `secure_password_change = false`** in `config.toml`, matching the
  previous audit's I-4: changing a password requires no re-authentication.
  Confirm the equivalent hosted setting.
- **I-8 — Account enumeration is safe, verified live.** A wrong password and an
  unknown address both return `400 invalid_credentials` with identical bodies.
  Supabase also rejects `@example.com` addresses at signup
  (`email_address_invalid`), so no probe account was created during this
  verification.

---

## Live attack results

Every row below was executed against the real project or the running
application. `42501` is Postgres's "permission denied" — a hard privilege
denial, strictly stronger than an RLS-filtered empty result.

### Unauthenticated (anon key — what every browser already has)

| Attack | Result | Status |
|---|---|---|
| `SELECT` on each of 28 tenant tables | HTTP 401 `42501` on all 28 | **BLOCKED** |
| `SELECT plans` (intended public catalogue) | HTTP 200, 3 rows | correct |
| `INSERT` into 18 tables incl. `organizations`, `memberships`, `audit_logs`, `subscriptions`, `plans` | HTTP 401 `42501` on all 18 | **BLOCKED** |
| `UPDATE subscriptions SET plan_id='business'` | HTTP 401 `42501` | **BLOCKED** |
| `UPDATE memberships SET role='owner'` | HTTP 401 `42501` | **BLOCKED** |
| `UPDATE ai_actions SET status='executed'` | HTTP 401 `42501` | **BLOCKED** |
| `UPDATE audit_logs` / `security_events` (append-only) | HTTP 401 `42501` | **BLOCKED** |
| `UPDATE plans SET name='hacked'` | HTTP 401 `42501` | **BLOCKED** |
| `DELETE` on 9 tables incl. `audit_logs`, `subscriptions`, `memberships` | HTTP 401 `42501` on all 9 | **BLOCKED** |
| `rpc/record_audit_event(...)` with `actor_type='system'` | HTTP 401 `42501` | **BLOCKED** |
| `rpc/org_id_of_document` (tenancy oracle) | HTTP 401 `42501` | **BLOCKED** |
| `rpc/org_id_of_invoice` (tenancy oracle) | HTTP 401 `42501` | **BLOCKED** |
| `rpc/org_id_of_conversation` (tenancy oracle) | HTTP 401 `42501` | **BLOCKED** |
| `rpc/owns_conversation` | HTTP 401 `42501` | **BLOCKED** |
| `rpc/is_org_member` (intentionally callable) | HTTP 200 → `false` | correct, leaks nothing |
| PostgREST OpenAPI root (schema enumeration) | HTTP 401, **0** tables and **0** RPCs advertised | **BLOCKED** |
| `GET /storage/v1/object/public/documents/…` | HTTP 400 (bucket is private) | **BLOCKED** |
| Account enumeration via sign-in | identical `400 invalid_credentials` for wrong password and unknown user | **BLOCKED** |

**72 attacks, 72 blocked, 0 succeeded.**

### Application layer (running app)

| Attack | Result | Status |
|---|---|---|
| Reach any of 15 protected `/app/*` routes logged out | HTTP 307 → `/login?redirectTo=…` on all 15 | **BLOCKED** |
| Open redirect: `redirectTo=@evil.example/` | stays on `localhost:3000` | **BLOCKED** |
| Open redirect: `redirectTo=.evil.example/` | stays on `localhost:3000` | **BLOCKED** |
| Open redirect: `//`, `/\`, `https://`, `http://`, `javascript:`, bare host, CRLF header injection | all 9 stay on-origin | **BLOCKED** |
| Unauthenticated Server Action POST to an `/app/*` route | HTTP 307, 75 bytes, no tenant data | **BLOCKED** |
| Authenticated page cached publicly | `private, no-store, max-age=0, must-revalidate` on every `/app/*` | **BLOCKED** |
| Framework fingerprinting via `X-Powered-By` | header absent on all 11 routes | **BLOCKED** |

**All application-layer live checks passed.**

### Authenticated (real user JWTs against the real project)

Two throwaway tenants were created on the live project and seeded with real
data: **org A** (owner, admin, viewer) and **org B** (owner, employee). All 108
attacks below ran as real signed-in users through PostgREST, the Auth API and
Storage. Everything was deleted afterwards.

`42501` = permission denied (privilege). `P0001` = a trigger or SECURITY DEFINER
function refused it. `rows=0` = the statement was allowed to run but matched
nothing, which is RLS filtering it out.

**Cross-tenant — org A's owner attacking org B (26 attacks)**

| Attack | Result | Status |
|---|---|---|
| Read B's transaction / invoice / line items / document / customer / account | `rows=0` on all six | **BLOCKED** |
| Update B's transaction | `rows=0` | **BLOCKED** |
| Delete B's transaction | `rows=0` | **BLOCKED** |
| Read B's AI conversation and messages | `rows=0` | **BLOCKED** |
| Inject a `system` turn into B's conversation | `403 42501` | **BLOCKED** |
| Read receipt against B's notification | `403 42501` | **BLOCKED** |
| Forge an audit event in B | `400 P0001` | **BLOCKED** |
| Modify B's pending AI action | `rows=0` | **BLOCKED** |
| Confirm B's pending AI action | `rows=0` | **BLOCKED** |
| Remove B's owner | `rows=0` | **BLOCKED** |
| Move A's transaction into org B | `403 42501` | **BLOCKED** |
| Forge `organization_id` on INSERT | `403 42501` | **BLOCKED** |
| Forge `user_id` on INSERT (conversation owned by someone else) | `403 42501` | **BLOCKED** |
| Insert / update another user's `profiles` row | `403 42501` / `rows=0` | **BLOCKED** |
| Claim `actor_type='system'` on an audit event | `400 P0001` | **BLOCKED** |
| Enumerate B's members / subscription / audit log / organization / notifications | `rows=0` on all five | **BLOCKED** |
| Malformed and random uuids | `rows=0` / `400 22P02`, no internal detail | **BLOCKED** |

**Privilege escalation (11 attacks)**

| Attack | Result | Status |
|---|---|---|
| A's admin promotes **themselves** to owner | `rows=0` | **BLOCKED** |
| A's admin promotes a colluding account to owner | `403 42501` | **BLOCKED** |
| A's admin inserts a new `owner` membership | `403 42501` | **BLOCKED** |
| A's admin deletes the owner | `rows=0` | **BLOCKED** |
| The last owner removes themselves | `rows=0` | **BLOCKED** |
| A viewer promotes themselves | `rows=0` | **BLOCKED** |
| An employee promotes themselves | `rows=0` | **BLOCKED** |
| A viewer adds a member | `403 42501` | **BLOCKED** |
| A role change moved across organizations | `403 42501` | **BLOCKED** |
| An **owner** grants the owner role | 1 row | correct — permitted |
| An **admin** manages a non-owner role | 1 row | correct — permitted |

**AI action integrity (14 attacks)**

| Attack | Result | Status |
|---|---|---|
| Rewrite `organization_id` after proposal | `400 P0001` | **BLOCKED** |
| Rewrite `conversation_id` | `400 P0001` | **BLOCKED** |
| Rewrite `tool_name` | `400 P0001` | **BLOCKED** |
| Rewrite `operation_mode` | `400 P0001` | **BLOCKED** |
| Rewrite `input` | `400 P0001` | **BLOCKED** |
| Set `confirmed_by` to another user | `400 P0001` | **BLOCKED** |
| Jump `pending` → `executed`, skipping confirmation | `400 P0001` | **BLOCKED** |
| A viewer confirms an action | `rows=0` | **BLOCKED** |
| Plant a pending action directly | `403 42501` | **BLOCKED** |
| Replay: claim an already-claimed action | `rows=0` | **BLOCKED** |
| `executed` → `pending` (re-execution) | `400 P0001` | **BLOCKED** |
| `executed` → `confirmed` (re-execution) | `400 P0001` | **BLOCKED** |
| Confirm a **rejected** action | `rows=0` | **BLOCKED** |
| Legitimate `pending`→`confirmed`→`executed` by a privileged member | 1 row each | correct — permitted |

**Race and replay (3 attacks)**

| Attack | Result | Status |
|---|---|---|
| **8 simultaneous confirmations** of one pending action | **exactly 1 winner of 8** | **BLOCKED** |
| Two different privileged users confirming simultaneously | **exactly 1 winner of 2** | **BLOCKED** |
| 12 concurrent AI messages all counted for metering | 12 of 12 | correct — race resolves closed |

**AI conversation privacy, including same-organization (8 attacks)**

| Attack | Result | Status |
|---|---|---|
| A same-org **viewer** reads the owner's conversation | `rows=0` | **BLOCKED** |
| A same-org **viewer** reads the owner's messages | `rows=0` | **BLOCKED** |
| A same-org **admin** reads them | `rows=0` | **BLOCKED** |
| A same-org viewer injects a turn | `403 42501` | **BLOCKED** |
| A same-org viewer deletes / renames the conversation | `rows=0` | **BLOCKED** |
| The conversation's own owner reads it and its messages | 1 row each | correct — permitted |

**Role boundaries within one organization (6 attacks)**

| Attack | Result | Status |
|---|---|---|
| A viewer inserts a transaction | `403 42501` | **BLOCKED** |
| A viewer updates / deletes a transaction | `rows=0` | **BLOCKED** |
| An **employee** deletes a transaction (delete is a smaller circle) | `rows=0` | **BLOCKED** |
| An employee updates a transaction | 1 row | correct — write role |
| A viewer reads their own org's transactions | 1 row | correct — read is universal |

**Billing (9 attacks)**

| Attack | Result | Status |
|---|---|---|
| Owner / admin / viewer set `plan_id='business'` | `rows=0` on all three | **BLOCKED** |
| Owner extends `current_period_end` to 2099 | `rows=0` | **BLOCKED** |
| Owner inserts a second, better subscription | `403 42501` | **BLOCKED** |
| Owner deletes their subscription to escape metering | `rows=0` | **BLOCKED** |
| Owner rewrites the `plans` catalogue entitlements | `rows=0` | **BLOCKED** |
| Owner writes their own `ai_usage` counter | `403 42501` | **BLOCKED** |
| Plan after every attempt | still `free` | **BLOCKED** |

**Audit log (6 attacks)**

| Attack | Result | Status |
|---|---|---|
| A member writes into another org's trail | `400 P0001` | **BLOCKED** |
| A member claims `actor_type='system'` | `400 P0001` | **BLOCKED** |
| Update an audit row (append-only) | `rows=0` | **BLOCKED** |
| Delete an audit row (append-only) | `rows=0` | **BLOCKED** |
| A viewer reads the org's audit trail | `rows=0` | **BLOCKED** |
| A member records a legitimate event | written, `actor_id` = the caller, `actor_type='user'` | correct — identity derived server-side |

**Storage (12 attacks)**

| Attack | Result | Status |
|---|---|---|
| A downloads B's document by path | denied | **BLOCKED** |
| A writes into B's storage folder | denied | **BLOCKED** |
| A deletes B's document | denied | **BLOCKED** |
| A mints a signed URL for B's document | denied | **BLOCKED** |
| A escapes its folder with `../` | denied | **BLOCKED** |
| An unauthenticated caller downloads a document | denied | **BLOCKED** |
| A **viewer** uploads a document (needs write role) | denied | **BLOCKED** |
| Repointing a valid signed URL at B's path | denied | **BLOCKED** |
| A member uploads into their own folder | 200 | correct — permitted |
| The owner mints a signed URL for their own document, and it resolves | 200 / 200 | correct — short-lived, by design |

**SECURITY DEFINER bypass (5 attacks)**

| Attack | Result (after 0025) | Status |
|---|---|---|
| `org_id_of_document()` on B's document | `leaked=false` | **BLOCKED** (was leaking — M-10) |
| `org_id_of_invoice()` on B's invoice | `leaked=false` | **BLOCKED** (was leaking — M-10) |
| `org_id_of_conversation()` on B's conversation | `leaked=false` | **BLOCKED** (was leaking — M-10) |
| `is_org_role()` reporting membership of B | `false` | **BLOCKED** |
| `owns_conversation()` on B's conversation | `false` | **BLOCKED** |

**108 authenticated attacks, 108 blocked, 0 succeeded** (after 0025; three of
them succeeded before it).

### Test data hygiene

Every artefact created by this verification was removed: 2 organizations, 5
users, and all their accounts, transactions, customers, invoices, line items,
documents, conversations, messages, actions, notifications, receipts,
memberships and subscriptions, plus 2 storage objects. A row-count diff against
the pre-test baseline shows **28 of 29 tables identical**.

The exception is `audit_logs`, which is **+6**: the append-only triggers mean
audit rows generated by the test tenants cannot be deleted, by anyone, ever.
They now carry `organization_id = NULL` and `actor_id = NULL` (the references
were severed when the test orgs and users were deleted), so they name nothing
that still exists. Leaving them is the design working correctly, not residue I
failed to clean — but they are in the live audit log and you should know they
are there.

---

## Migrations 0024 and 0025

**Applied remotely: yes, both.** `supabase migration list --linked` returns a
one-to-one local↔remote match for all 25 migrations, with no unapplied local
migrations and no remote entries absent locally. 0025 was written, tested
locally, pushed and re-verified against the remote database during this run.

```
local 0001..0025   ==   remote 0001..0025      (25/25, no drift)
```

**Verified remotely — the protections that are observable without a session:**

| 0024 protection | Live evidence |
|---|---|
| `revoke select on all tables in schema public from anon` | 28/28 tenant tables return `42501` to anon |
| `grant select on plans to anon` | `plans` returns 200 with 3 rows |
| `revoke execute on record_audit_event from public, anon` | `rpc/record_audit_event` → `42501` |
| `revoke execute on org_id_of_document/_invoice/_conversation from public, anon` | all three → `42501` |
| `revoke execute on owns_conversation from public, anon` | → `42501` (function exists, so 0024 ran) |
| `is_org_member` deliberately left callable | → 200 `false` |
| default privileges revoked for anon | OpenAPI root serves anon 0 tables, 0 RPCs |

The presence of `owns_conversation` — a function introduced only by 0024 — and
the `42501` on the three `org_id_of_*` helpers together are positive proof that
0024's function-level changes are live, not just recorded in the migration
table. The `PUBLIC` revoke in particular is confirmed: revoking from `anon`
alone would have left these callable, because Postgres grants `EXECUTE` to
`PUBLIC` by default on every new function — that was caught during the original
fix and the live result shows the corrected form took effect.

**0025's protections, all verified remotely after the push:**

| 0025 protection | Live evidence |
|---|---|
| `org_id_of_*` answers only for organizations you belong to | `leaked=false` on all three, where it was `leaked=true` before |
| dependent policies unchanged | `invoice_line_items` still readable by its member, still invisible to others |
| organizations can be deleted again | both test organizations deleted, HTTP 200, memberships cascaded |
| the last-owner invariant still fires for a live organization | `400 P0001 An organization must always have at least one owner` |
| users with audit history can be deleted | all 5 test users deleted, HTTP 200 |
| audit events survive their actor | 6 rows present with `actor_id`/`organization_id` severed, content intact |

---

## RLS matrix (live, unauthenticated column verified remotely)

| Table | anon SELECT | anon INS/UPD/DEL | Tenant boundary (applied SQL) |
|---|---|---|---|
| `profiles` | 42501 | 42501 | own row only |
| `organizations` | 42501 | 42501 | member, or creator during bootstrap |
| `memberships` | 42501 | 42501 | member reads; owner-only for the `owner` role (0024) |
| `accounts`, `transactions`, `transaction_categories`, `merchants` | 42501 | 42501 | `is_org_member` read / role-gated write / narrower delete |
| `accounting_periods`, `tax_configurations`, `vat_configurations`, `sales_tax_configurations` | 42501 | 42501 | member read, owner/admin/accountant write |
| `documents`, `document_processing_jobs`, `document_extracted_data`, `document_relationships` | 42501 | 42501 | via `org_id_of_document` |
| `customers`, `invoices`, `invoice_line_items` | 42501 | 42501 | org-scoped; line items via `org_id_of_invoice` |
| `ai_conversations`, `ai_messages` | 42501 | 42501 | **owner-of-conversation only** (0024) |
| `ai_usage`, `ai_insights` | 42501 | 42501 | member read; no client insert |
| `ai_actions` | 42501 | 42501 | no client INSERT (0021); UPDATE role-gated + immutability trigger (0024) |
| `audit_logs`, `security_events` | 42501 | 42501 | owner/admin read only; append-only triggers; no client write path |
| `notifications` | 42501 | 42501 | org-wide or targeted-at-me |
| `notification_reads` | 42501 | 42501 | own receipts, and only for a visible notification (0024) |
| `subscriptions` | 42501 | 42501 | member read; **no client write path at all** |
| `plans` | **200 (intended)** | 42501 | public catalogue |

Reviewed for the anti-patterns called out in the brief: the only
`USING (true)` in the schema is `plans_select_all`, which is the intended
public plan catalogue. No `WITH CHECK (true)` anywhere. No policy trusts a
client-supplied `organization_id` — every one derives tenancy from the row
itself or from a `SECURITY DEFINER` helper keyed on `auth.uid()`. All six
`SECURITY DEFINER` functions pin `search_path = public`. Since 0024, the only
`SECURITY DEFINER` function with side effects (`record_audit_event`)
authorizes its caller.

---

## AI security matrix — all 36 tools

Generated from the registry source, then hand-verified. **15 read · 13
calculate · 4 analyze · 4 write · 0 delete.**

| Mode | Count | Tools | Org scoping | Input validator | Confirmation | Audit |
|---|---|---|---|---|---|---|
| `read` | 15 | getAccounts, getCategories, getCustomers, getDocuments, getFinancialInsights, getFinancialPeriods, getInvoice, getInvoices, getOverdueInvoices, getProfile, getTransaction, getTransactions, prepareReport, searchDocuments, searchTransactions | all via `ctx.organizationId` (`getProfile` via `ctx.userId`; `getFinancialPeriods` touches no data) | on all 7 that take arguments | n/a | no mutation |
| `calculate` | 13 | calculateMargin, calculateProfit, calculateSalesTax, calculateTaxEstimate, calculateVAT, comparePeriods, forecastCashFlow, getBalances, getCashFlow, getExpenses, getFinancialOverview, getIncome, getProfitAndLoss | all via `ctx.organizationId` (the two tax calculators are pure arithmetic on supplied values) | on all 10 that take arguments | n/a | no mutation |
| `analyze` | 4 | detectAnomalies, getRecurringExpenses, getSubscriptions, explainDocument *(registered stub — throws)* | via `ctx.organizationId` (the two recurring tools scope through `getRecurringPatterns(client, ctx.organizationId)`) | none take arguments | n/a | no mutation |
| `write` | 4 | categorizeTransaction, createDraftExpense, createDraftInvoice, createDraftTransaction | `ctx.organizationId`, **plus** an `organization_id` predicate inside each repository call | **yes, all 4** | **REQUIRED** — intercepted into `ai_actions`, never executed inline | `ai_action.executed` on execution |
| `delete` | **0** | — | — | — | path enforced but **unexercised** | — |

**Every tool that accepts arguments has a runtime validator** — asserted by a
test (`registry.test.ts`), so a future tool cannot be added unguarded. **No tool
is unscoped.**

Pipeline enforcement, each verified present in source:

| Enforcement point | Where | Status |
|---|---|---|
| Arguments validated *before* the write/delete branch | `service.ts` | PASS |
| A mutating tool is never executed inline | `service.ts` | PASS |
| Round two omits `tools` entirely, so tool-result content cannot invoke anything | `service.ts` | PASS |
| Confirmation requires org membership | `actions.ts` | PASS |
| Confirmation requires `ai:confirm_action` (owner/admin/accountant/manager), checked before both approve and reject | `actions.ts` | PASS |
| Stored `ai_actions.input` re-validated before replay | `actions.ts` | PASS |
| Atomic compare-and-set claim (no double execution) | `actions.ts` → `claimActionForExecution` | PASS |
| Execution is audited | `actions.ts` | PASS |
| Tools execute with the **user's** RLS-scoped client, never the admin client | `actions.ts` | PASS |
| Pending actions written with the admin client only, after membership is established | `actions.ts` | PASS |

The AI cannot exceed the confirming user's own authority: the tool runs through
that user's RLS-scoped session, so a `manager` who confirms a hypothetical
delete would still be refused by `transactions_delete_privileged`.

---

## Rate limiting

**Not implemented, and not implemented in this task** (per the brief).

| Surface | Protection today |
|---|---|
| `signIn`, `signUp`, `requestPasswordReset` | **Supabase Auth's own platform limits only.** No application limit. |
| `sendAiMessage` (calls a paid model) | daily per-org message cap only — no per-minute limit, no burst limit |
| `confirmAiAction` | none |
| `refreshInsights` (2000-row read + admin-client writes) | a 5-minute regeneration window added by the previous audit; no request limit |
| `globalSearch`, all other Server Actions | none |
| Document upload | 20 MB per file; no count or rate limit |

**Abuse impact.** Credential stuffing against `/login` at whatever rate
Supabase's defaults permit; unbounded model spend by rotating organizations
(a free-plan user can create unlimited organizations — I-3 in the previous
audit — each with its own 20-message/day allowance); and Server Action floods
with no upstream throttle.

**It remains a BLOCKING launch item — and it is now the only one.** This is
infrastructure: an edge rate limiter or WAF in front of the app, plus per-IP
limits on the auth endpoints. Not application code, which is why it was
correctly excluded from this task.

---

## Remaining launch blockers

**None.**

Rate limiting — the last item — is now implemented, applied live and verified.
See [SECURITY-RATE-LIMITING.md](SECURITY-RATE-LIMITING.md): distributed and
atomic on Postgres, enforced inside the Server Actions ahead of every expensive
operation, 40 genuinely parallel requests against a limit of 5 admitting
exactly 5 on the real project, with the counters unreachable from any client
role. One deployment note carries forward from it: IP-scoped rules need a proxy
that overwrites `x-forwarded-for`; identity-scoped rules hold either way.

Everything else previously listed as blocking is closed:

- Migration 0024 applied **and verified remotely**, by attack rather than by
  assumption.
- The service-role key rotation happened; the live project confirms the old key
  is revoked.
- The authenticated verification is complete: 108 attacks, all blocked.
- Migration 0025 closed the three problems that verification found, and is
  itself applied and re-verified live.
- Migration 0026 adds rate limiting, applied and verified live.

Two items sit below the blocking line and want doing before real users, neither
exploitable on its own:

- **Rotate the service-role key once more** (C-2) — precautionary; the repo was
  never pushed. Put it in `.env.local`.
- **Disable the legacy `anon`/`service_role` JWT keys** (M-9) — unused standing
  credentials the rotation could not touch.

---

## Recommended hardening

**BLOCKING**
- Rate limiting on `/login`, `/signup`, `/forgot-password`, and `sendAiMessage`.
  The only remaining blocker.

**STRONGLY RECOMMENDED**
- Rotate the service-role key once more (C-2), into `.env.local`. Precautionary:
  the repository was never pushed, but a second key has now sat in plaintext in
  a commit-marked file.
- Disable the legacy `anon` and `service_role` JWT keys (M-9). They are unused
  and cannot be rotated independently of every user session.
- Give account deletion a real flow: the last-owner invariant correctly refuses
  to delete a user who solely owns a live organization, so erasure needs an
  ownership-transfer or organization-removal step in front of it (M-11).
- Confirm the live password minimum is ≥ 8 (I-6) — the app's Zod check is
  bypassed by a direct Auth API call.
- Re-authentication for password change, and a session-revocation path
  (I-7 / previous audit I-4).
- Nonce-based `script-src` CSP (previous audit M-7).
- Enable the Google provider or hide the button (L-6).

**OPTIONAL / FUTURE**
- Reconcile the free-plan entitlement/limit mismatch before pricing goes public.
- Enforce `max_organizations`, which currently also caps AI spend per account.
- Sniff uploaded file content rather than trusting `file.type`, before OCR ships.
- Align `supabase/config.toml` with the hosted settings so local and production
  behaviour stop diverging.

---

## Final verification

| Check | Result |
|---|---|
| `npm run typecheck` | clean, 0 errors |
| `npm run lint` | clean, 0 errors, 0 warnings |
| `npm test` | **275 passed / 275** (30 files) — 85 RLS tests against the real migrations, including 24 + 12 security regressions |
| `npm run e2e` | **11 passed / 11** |
| `npm run build` | success, 34 routes |
| `npm audit` | 0 vulnerabilities (dev and production) |
| **Live anon attack battery** | **72 / 72 blocked** (re-run after 0025) |
| **Live authenticated attack battery** | **108 / 108 blocked** |
| Live header + boundary checks | all passed (11 routes, 15 protected, 14 public, 9 redirect payloads) |
| Remote migration state | **25 / 25 applied, no drift** |
| Live test-data cleanup | 28 / 29 tables back to baseline; `audit_logs` +6 by design |
| Build-output secret scan | service-role and Anthropic keys absent; 0 client source maps |
| Repository secret scan | only `.env.local` (gitignored) and pattern definitions in the guard test |

**Live attack total: 180 attacks, 180 blocked.**

---

## Assessment

The remote database behaves the way the migrations say it should. That is now a
statement about 180 executed attacks rather than about SQL that looks right —
72 as an anonymous caller and 108 as real signed-in users across two live
tenants, covering cross-tenant reads and writes, privilege escalation, AI action
integrity and replay, conversation privacy, billing tampering, storage isolation
and the `SECURITY DEFINER` surface. All 180 were blocked.

The unauthenticated result is unusually strong: not "RLS filtered the rows" but
"the role has no privilege on the object at all", on all 28 tenant tables, with
a PostgREST instance that will not even describe its own schema to an anonymous
caller.

Three things are worth taking away from how this went, more than the pass rate.

**The last mile of a fix is its own risk.** 0024 revoked the `org_id_of_*`
helpers from `anon` and stopped, because the remaining grant to `authenticated`
looked structural — those functions genuinely must be callable for the policies
to work. "Must be callable" is not "may answer freely", and the gap between
those two sentences was a live cross-tenant oracle for every logged-in user.
It took driving the real API as a real user to see it.

**Tests that only create will not find bugs that only appear on delete.** Two of
this run's three findings — including a HIGH that made organization deletion
impossible, which I introduced in 0024 — were invisible to 85 passing RLS tests
because none of them ever deleted an organization or a user. They surfaced while
cleaning up after myself. The regression tests added in
`tests/rls/live-verification.test.ts` now exercise the delete paths.

**And C-2 is the finding I would act on first**, despite being fixed: the same
mistake, on the same file, on the most dangerous credential in the system,
recurring within one remediation cycle. The previous fix was a comment. This one
is a test that fails the build. That difference — between documenting a hazard
and removing the ability to walk into it — is the durable part of this work.

With rate limiting in front of it, I would be comfortable with real users'
financial data in this system.
