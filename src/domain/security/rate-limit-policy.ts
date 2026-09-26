/**
 * The rate-limit policy: what is protected, how hard, and what happens when
 * the limiter itself is unavailable.
 *
 * Kept as pure data in the domain layer, separate from the enforcement
 * mechanism (src/server/security/rate-limit.ts), so the numbers can be
 * reviewed and tested in one place instead of being scattered as literals
 * across a dozen call sites — the same reason
 * src/domain/organizations/permissions.ts exists.
 *
 * Rate limiting is defence in depth. It never replaces authentication,
 * authorization, RLS, the AI confirmation gate, or plan entitlements; every
 * limiter below sits alongside those, not instead of them.
 */

/**
 * What to do when the backing store cannot be reached.
 *
 * The choice is deliberately per-category rather than global, because the
 * cost of being wrong is not the same in each direction.
 *
 * - `closed` for authentication: refusing logins during a limiter outage
 *   costs nothing, because the limiter's store IS the auth store — if
 *   Postgres is unreachable, Supabase Auth cannot verify a password either,
 *   so the request was going to fail regardless. Failing closed here removes
 *   an obvious attack ("take the limiter down, then brute force") at zero
 *   practical availability cost.
 *
 * - `closed` for AI: the entire point of the AI limiter is denial-of-wallet
 *   protection against a paid third-party provider. A control that evaporates
 *   the moment the store hiccups is not a control. An outage means the
 *   assistant is briefly unavailable; the alternative is an unbounded bill.
 *
 * - `open` for ordinary application traffic: search and uploads are cheap and
 *   already require authentication and authorization. Making the product
 *   unusable because a counter could not be incremented is a worse outcome
 *   than the abuse it would prevent. These failures are surfaced to the
 *   caller so they are visible rather than silent.
 *
 * Nothing is ever *silently* bypassed: a failure is always reported through
 * `RateLimitDecision.degraded`.
 */
export type FailureMode = "closed" | "open";

export interface RateLimitRule {
  /** Namespace stored alongside the hashed key. Also the observability label. */
  readonly namespace: string;
  /** Maximum permitted units per window. */
  readonly limit: number;
  /** Window length in seconds. */
  readonly windowSeconds: number;
  readonly failureMode: FailureMode;
  /** Why this number — read at review time, not decoration. */
  readonly rationale: string;
}

/**
 * Fixed windows, not a sliding log. A fixed window admits up to 2x the limit
 * across a boundary in the worst case; a sliding window would need either a
 * sorted set per key or several rows per request, and neither is worth the
 * write amplification here. Where the boundary effect actually matters
 * (login, AI) two rules of different lengths are layered, which bounds the
 * burst far more tightly than either alone.
 */
export const RATE_LIMITS = {
  // ── Authentication ────────────────────────────────────────────────────
  // Two independent buckets per operation: one keyed on the client address,
  // one on the submitted identifier. Either can block. The identifier bucket
  // is what stops credential stuffing from a botnet (many addresses, one
  // account); the address bucket is what stops one host spraying many
  // accounts. Neither reveals whether the account exists — the counter is
  // incremented and the same generic response returned either way.
  loginPerIp: {
    namespace: "auth:login:ip",
    limit: 10,
    windowSeconds: 300,
    failureMode: "closed",
    rationale:
      "A person signing in mistypes a password two or three times. 10 per 5 minutes leaves generous room for that, and for a small office behind one NAT address, while cutting a spray attack to ~2 attempts/minute from a given host.",
  },
  loginPerIdentifier: {
    namespace: "auth:login:id",
    limit: 5,
    windowSeconds: 900,
    failureMode: "closed",
    rationale:
      "The control that survives IP rotation: 5 attempts per account per 15 minutes makes credential stuffing against a known address uneconomic (20/hour) no matter how many hosts the attacker has, while a real user who has forgotten which password they used still gets five tries before waiting.",
  },
  signupPerIp: {
    namespace: "auth:signup:ip",
    limit: 5,
    windowSeconds: 3600,
    failureMode: "closed",
    rationale:
      "A real person creates one account. 5 per hour permits a shared address and genuine retries after a validation error, while making automated account farming visibly slow.",
  },
  signupPerIdentifier: {
    namespace: "auth:signup:id",
    limit: 3,
    windowSeconds: 3600,
    failureMode: "closed",
    rationale:
      "Repeated signups for one address are either a retry or an attempt to spam that address with confirmation mail. Three per hour covers the former and stops the latter.",
  },
  passwordResetPerIp: {
    namespace: "auth:reset:ip",
    limit: 10,
    windowSeconds: 3600,
    failureMode: "closed",
    rationale: "Password-reset requests are a mail-sending primitive. 10/hour per address bounds its use as a spam relay.",
  },
  passwordResetPerIdentifier: {
    namespace: "auth:reset:id",
    limit: 3,
    windowSeconds: 3600,
    failureMode: "closed",
    rationale:
      "Three reset mails per address per hour is more than any real recovery needs, and stops an attacker from flooding a specific victim's inbox to bury a genuine security notification.",
  },

  // ── AI ────────────────────────────────────────────────────────────────
  // These sit ON TOP OF the plan entitlement in
  // src/domain/billing/entitlements.ts (free 3/day, premium 100/day,
  // business 500/day), which remains the authoritative product limit and is
  // enforced separately. Entitlement answers "how much has this organization
  // paid for"; these answer "is this traffic shaped like a human". Both must
  // pass, and neither is a substitute for the other — the burst limiter would
  // still allow far more than a daily allowance over a full day.
  aiMessagePerUser: {
    namespace: "ai:message:user",
    limit: 5,
    windowSeconds: 60,
    failureMode: "closed",
    rationale:
      "Each message can trigger two Anthropic round-trips plus tool execution, so this is the most expensive request the product makes. A person reads an answer before asking again; five a minute is faster than anyone types and still cuts a scripted loop by orders of magnitude.",
  },
  aiMessagePerOrg: {
    namespace: "ai:message:org",
    limit: 30,
    windowSeconds: 60,
    failureMode: "closed",
    rationale:
      "Bounds the whole tenant, not just one account, so a business plan (which has no daily cap) cannot be turned into unmetered provider spend by driving several accounts at once. 30/minute supports a genuinely busy team of six.",
  },
  aiMessagePerIp: {
    namespace: "ai:message:ip",
    limit: 60,
    windowSeconds: 60,
    failureMode: "closed",
    rationale:
      "A backstop against one host driving many accounts it has credentials for. Set well above legitimate shared-office use so it only bites on automation.",
  },
  aiConfirmPerUser: {
    namespace: "ai:confirm:user",
    limit: 20,
    windowSeconds: 60,
    failureMode: "closed",
    rationale:
      "Confirming executes a real financial write. Cheap per call, but a burst is either a bug or an attempt to race the confirmation gate, and the atomic claim should not be the only thing absorbing that.",
  },

  // ── Expensive authenticated operations ────────────────────────────────
  insightsRefreshPerOrg: {
    namespace: "insights:refresh:org",
    limit: 3,
    windowSeconds: 300,
    failureMode: "closed",
    rationale:
      "Reads up to 2000 transactions, runs every detector over them, and writes through the admin client. Already throttled by a 5-minute regeneration window; this bounds the read cost too, which that window does not.",
  },
  documentUploadPerUser: {
    namespace: "documents:upload:user",
    limit: 30,
    windowSeconds: 3600,
    failureMode: "open",
    rationale:
      "20 MB per file makes this a storage-cost surface. 30/hour is far above real bookkeeping use. Fails open because a blocked upload during a limiter outage loses the user's work for no security gain — the file is already authorized and tenant-scoped.",
  },
  documentProcessingPerUser: {
    namespace: "documents:process:user",
    limit: 20,
    windowSeconds: 3600,
    failureMode: "closed",
    rationale:
      "Reading a document parses up to 20 MB server-side, and a future OCR provider bills per page. Twenty reads an hour is far above reviewing a year's tax documents one at a time, and a repeated-processing loop is exactly what it caps. Fails closed: a refused read loses no work — the document stays stored and can be read later — while an unbounded loop costs compute and, with a paid provider, money.",
  },
  // ── Bank connections ──────────────────────────────────────────────────
  // All fail closed. Every one of these either calls a paid, throttled
  // provider or changes what enters the books, and a refused request loses no
  // data: nothing was connected yet, or the next sync fetches everything since
  // the cursor. These sit on top of the database's one-active-job-per-connection
  // index and the five-minute manual refresh window, not instead of them.
  bankLinkSessionPerUser: {
    namespace: "bank:link:user",
    limit: 10,
    windowSeconds: 3600,
    failureMode: "closed",
    rationale:
      "Starting or completing a bank link creates a session at a provider that bills and throttles per call. Ten an hour covers a person whose bank rejected their sign-in several times; more is a script.",
  },
  bankSyncPerUser: {
    namespace: "bank:sync:user",
    limit: 20,
    windowSeconds: 3600,
    failureMode: "closed",
    rationale:
      "A refresh fetches every page of new transactions from the provider. Twenty an hour per person is far above checking a few accounts through a working day, and caps a refresh button driven by a script.",
  },
  bankSyncPerConnection: {
    namespace: "bank:sync:connection",
    limit: 12,
    windowSeconds: 3600,
    failureMode: "closed",
    rationale:
      "Bounds one connection however many members press refresh — several people in one workspace must not turn one bank into a sync storm. Layered with the per-user rule so neither can be rotated around.",
  },
  bankDisconnectPerUser: {
    namespace: "bank:disconnect:user",
    limit: 10,
    windowSeconds: 3600,
    failureMode: "closed",
    rationale:
      "Disconnecting revokes and destroys a provider credential. There is no legitimate reason for ten in an hour; a burst is a bug or a compromised session, and availability is not worth more than that boundary.",
  },
  bankWorkerPerIp: {
    namespace: "bank:worker:ip",
    limit: 120,
    windowSeconds: 3600,
    failureMode: "closed",
    rationale:
      "The background sync endpoint is guarded by a deployment secret, not a session, so the only attack on it is guessing that secret. A scheduler calling every five minutes needs 12 an hour; 120 leaves room for a second cron and manual runs while making guessing pointless.",
  },
  documentRetentionPerIp: {
    namespace: "documents:retention:ip",
    limit: 120,
    windowSeconds: 3600,
    failureMode: "closed",
    rationale:
      "The retention sweep is guarded by a deployment secret rather than a session, so the only attack on it is guessing that secret. A daily cron needs one an hour; 120 leaves room for manual runs and for paging through a backlog while making guessing pointless. It deletes only files already past their retention window, so the worst a successful call does is bring that deletion forward.",
  },
  bankAccountLinkPerUser: {
    namespace: "bank:account-link:user",
    limit: 60,
    windowSeconds: 3600,
    failureMode: "closed",
    rationale:
      "Linking a bank account to a Countorra account decides what enters the ledger and reconciles every waiting transaction at once. Sixty an hour covers setting up many accounts; each call can write ledger rows, so it is bounded.",
  },
  // ── Authenticated record mutation ─────────────────────────────────────
  recordMutationPerUser: {
    namespace: "records:mutate:user",
    limit: 120,
    windowSeconds: 60,
    failureMode: "open",
    rationale:
      "Creating and deleting transactions, invoices, accounts, customers and categories was bounded only by authorization — a member could insert records as fast as the network allowed, which is a storage-cost and audit-noise surface even though it is tenant-scoped. 120/minute is far above any human bookkeeping rate (bulk categorisation is one request, not one per row) and still caps a script. Fails open: these are authenticated, authorized, tenant-scoped writes, and losing someone's typed transaction during a limiter outage costs more than it protects.",
  },
  privilegedMutationPerUser: {
    namespace: "records:privileged:user",
    limit: 10,
    windowSeconds: 300,
    failureMode: "closed",
    rationale:
      "Role changes and ownership transfer alter who controls a workspace. There is no legitimate reason to issue ten of them in five minutes, and a burst is either a bug or an escalation attempt being retried. Fails closed for the same reason authentication does — availability is not worth more than the boundary here.",
  },
  searchPerUser: {
    namespace: "search:query:user",
    limit: 60,
    windowSeconds: 60,
    failureMode: "open",
    rationale:
      "The command palette issues a query per keystroke-pause across four tables. 60/minute is invisible to a person typing and still caps a scripted scan. Fails open: search is authenticated, tenant-scoped and cheap enough that availability wins.",
  },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

/** Every rule an operation must satisfy. All of them are consumed; a request
 *  is refused if any one is exhausted. */
export const RATE_LIMIT_GROUPS = {
  login: ["loginPerIp", "loginPerIdentifier"],
  signup: ["signupPerIp", "signupPerIdentifier"],
  passwordReset: ["passwordResetPerIp", "passwordResetPerIdentifier"],
  aiMessage: ["aiMessagePerUser", "aiMessagePerOrg", "aiMessagePerIp"],
  aiConfirm: ["aiConfirmPerUser"],
  insightsRefresh: ["insightsRefreshPerOrg"],
  documentUpload: ["documentUploadPerUser"],
  documentProcessing: ["documentProcessingPerUser"],
  bankLinkSession: ["bankLinkSessionPerUser"],
  bankSync: ["bankSyncPerUser", "bankSyncPerConnection"],
  bankDisconnect: ["bankDisconnectPerUser"],
  bankAccountLink: ["bankAccountLinkPerUser"],
  bankWorker: ["bankWorkerPerIp"],
  documentRetention: ["documentRetentionPerIp"],
  recordMutation: ["recordMutationPerUser"],
  privilegedMutation: ["privilegedMutationPerUser"],
  search: ["searchPerUser"],
} as const satisfies Record<string, readonly RateLimitName[]>;

export type RateLimitGroup = keyof typeof RATE_LIMIT_GROUPS;

/**
 * The message shown when a limit is hit.
 *
 * Deliberately uniform and vague about *which* limit fired. Telling an
 * attacker "the per-account limit for this address stopped you" is telling
 * them the address exists, and telling them which bucket to rotate. The user
 * gets the one thing they need — roughly how long to wait.
 */
export function rateLimitMessage(retryAfterSeconds: number): string {
  const minutes = Math.ceil(Math.max(retryAfterSeconds, 1) / 60);
  if (minutes <= 1) return "Too many requests. Please wait a moment and try again.";
  return `Too many requests. Please try again in about ${minutes} minutes.`;
}
