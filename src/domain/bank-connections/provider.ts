import { z } from "zod";
import { EXTERNAL_ACCOUNT_TYPES, WEBHOOK_EVENT_TYPES, type SyncFailureCategory } from "./types";

/**
 * THE BANK-CONNECTION PROVIDER CONTRACT.
 *
 * Everything Countorra knows about a bank arrives through this interface. A
 * provider adapter — Plaid, when it is connected, or any other — lives in its
 * own module under src/server/bank-connections/providers/, translates the
 * vendor's API into the shapes below, and is registered in
 * `configuredBankProviders()`. No vendor type crosses this boundary, so the
 * tables, the sync engine, reconciliation and the UI do not change when a
 * provider is added or replaced.
 *
 * THIS DEPLOYMENT HAS NO PROVIDER. `configuredBankProviders()` returns an empty
 * list, and every path that needs one reports "not configured" instead of
 * pretending. The only implementation of this interface in the repository is a
 * deterministic test fixture under tests/fixtures.
 *
 * A PROVIDER IS UNTRUSTED
 *
 * Every method returns `unknown`. Nothing is believed until it has passed the
 * schemas below: bounded sizes, exact field sets (`strict`), decimal strings for
 * money (never floats), ISO dates, three-letter currency codes. A provider's own
 * error text is never propagated — it can carry account details or credentials —
 * only a SyncFailureCategory.
 */

/** Transactions accepted per provider page. */
export const MAX_PAGE_SIZE = 500;
/** Accounts accepted per connection. */
export const MAX_ACCOUNTS_PER_CONNECTION = 100;
/** A provider call that has not answered by then is abandoned. */
export const PROVIDER_CALL_TIMEOUT_MS = 25_000;

export const BANK_PROVIDER_NOT_CONFIGURED_MESSAGE =
  "No bank connection provider is configured for this deployment, so nothing is imported automatically. Accounts and transactions are recorded by hand.";

/**
 * A provider credential (an access token) in memory.
 *
 * Deliberately not a string. It cannot be logged, serialised into JSON, sent to
 * the client in a Server Action result or interpolated by accident: every one of
 * those paths prints "[provider secret]". The value is read only by `reveal()`,
 * inside a provider adapter, at the moment of a provider call.
 */
export class ProviderSecret {
  readonly #value: string;

  constructor(value: string) {
    if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new TypeError("A provider secret must be a non-empty string.");
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[provider secret]";
  }

  toString(): string {
    return "[provider secret]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[provider secret]";
  }
}

/**
 * Where provider credentials live. NOT the financial tables.
 *
 * `bank_connection_credentials` holds only a reference (for example a Supabase
 * Vault secret id); the credential itself stays in the store. Countorra's
 * deployment has no store configured, so no credential can be accepted — which
 * is correct, because there is no provider to accept one from.
 */
export interface ProviderSecretStore {
  readonly id: string;
  /** Returns a reference matching SECRET_REF_PATTERN. */
  put(input: { organizationId: string; connectionId: string; secret: ProviderSecret }): Promise<string>;
  get(reference: string): Promise<ProviderSecret | null>;
  /** Idempotent: destroying an absent secret succeeds. */
  destroy(reference: string): Promise<void>;
}

/** `<store>:<opaque id>`. Mirrored by a check constraint in migration 0047,
 *  which also refuses anything shaped like a raw provider token. */
export const SECRET_REF_PATTERN = /^[a-z][a-z0-9_-]{1,31}:[A-Za-z0-9._:-]{8,200}$/;

// ── What a provider returns ─────────────────────────────────────────────

const id = z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/, "printable ASCII only");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const currencyCode = z.string().regex(/^[A-Z]{3}$/);
/** Unsigned decimal: the direction is a separate field. At most four decimals
 *  so a sub-cent provider value is refused rather than rounded. */
const unsignedDecimal = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/);
const signedDecimal = z.string().regex(/^-?\d{1,15}(\.\d{1,4})?$/);

export const providerAccountSchema = z
  .object({
    providerAccountId: id,
    name: z.string().min(1).max(200),
    type: z.enum(EXTERNAL_ACCOUNT_TYPES),
    subtype: z.string().regex(/^[a-z][a-z0-9_ ]{0,39}$/).nullable(),
    /** Whatever the provider calls the mask. Normalization keeps at most the
     *  last four characters; a full account number is never stored. */
    mask: z.string().max(34).nullable(),
    currency: currencyCode.nullable(),
    currentBalance: signedDecimal.nullable(),
    availableBalance: signedDecimal.nullable(),
    state: z.enum(["OPEN", "CLOSED"]),
  })
  .strict();

export const providerTransactionSchema = z
  .object({
    providerTransactionId: id,
    providerAccountId: id,
    /** Set on a POSTED transaction that replaces a pending one with a
     *  different id. */
    pendingProviderTransactionId: id.nullable(),
    status: z.enum(["PENDING", "POSTED"]),
    direction: z.enum(["DEBIT", "CREDIT"]),
    amount: unsignedDecimal,
    currency: currencyCode.nullable(),
    transactionDate: isoDate,
    postedDate: isoDate.nullable(),
    authorizedDate: isoDate.nullable(),
    merchantName: z.string().max(500).nullable(),
    description: z.string().max(1000).nullable(),
    categoryHint: z.string().max(200).nullable(),
  })
  .strict();

export const providerTransactionsPageSchema = z
  .object({
    /** Account details, when the provider includes them with the page. */
    accounts: z.array(providerAccountSchema).max(MAX_ACCOUNTS_PER_CONNECTION),
    added: z.array(providerTransactionSchema).max(MAX_PAGE_SIZE),
    modified: z.array(providerTransactionSchema).max(MAX_PAGE_SIZE),
    removed: z.array(z.object({ providerTransactionId: id }).strict()).max(MAX_PAGE_SIZE),
    nextCursor: z.string().min(1).max(1024),
    hasMore: z.boolean(),
  })
  .strict()
  .superRefine((page, context) => {
    if (page.added.length + page.modified.length > MAX_PAGE_SIZE) context.addIssue({ code: "custom", message: "page exceeds the transaction limit" });
    const ids = [...page.added, ...page.modified].map((transaction) => transaction.providerTransactionId);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "a transaction appears twice in one page" });
    const accountIds = page.accounts.map((account) => account.providerAccountId);
    if (new Set(accountIds).size !== accountIds.length) context.addIssue({ code: "custom", message: "an account appears twice in one page" });
  });

export const providerAccountsSchema = z
  .object({ accounts: z.array(providerAccountSchema).max(MAX_ACCOUNTS_PER_CONNECTION) })
  .strict();

export const providerLinkSessionSchema = z
  .object({
    /** Opaque: handed to the provider's own browser component, never stored. */
    linkToken: z.string().min(1).max(2048),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const providerCompletedLinkSchema = z
  .object({
    providerConnectionId: id,
    institutionId: z.string().min(1).max(100).nullable(),
    institutionName: z.string().min(1).max(200).nullable(),
    /** Which of the provider's environments this connection belongs to
     *  (Plaid: sandbox or production). Recorded so a sandbox connection can
     *  never be mistaken for a real one. */
    providerEnvironment: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{1,31}$/)
      .nullable(),
    secret: z.instanceof(ProviderSecret),
  })
  .strict();

/** What a provider says about a connection right now, independent of what
 *  Countorra last recorded. Read after a re-authentication, and whenever the
 *  provider's own view is the authority. */
export const providerConnectionStateSchema = z
  .object({
    health: z.enum(["HEALTHY", "REQUIRES_REAUTH", "REVOKED", "ERROR"]),
    /** The provider's own code, bounded. Never shown to a person. */
    errorCode: z.string().max(64).nullable(),
    institutionId: z.string().max(200).nullable(),
  })
  .strict();

export const providerWebhookEventSchema = z
  .object({
    providerEventId: id,
    providerEventType: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
    type: z.enum(WEBHOOK_EVENT_TYPES),
    providerConnectionId: id.nullable(),
    occurredAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export type ProviderAccount = z.infer<typeof providerAccountSchema>;
export type ProviderTransaction = z.infer<typeof providerTransactionSchema>;
export type ProviderTransactionsPage = z.infer<typeof providerTransactionsPageSchema>;
export type ProviderLinkSession = z.infer<typeof providerLinkSessionSchema>;
export type ProviderCompletedLink = z.infer<typeof providerCompletedLinkSchema>;
export type ProviderWebhookEvent = z.infer<typeof providerWebhookEventSchema>;
export type ProviderConnectionState = z.infer<typeof providerConnectionStateSchema>;

export interface BankConnectionProvider {
  /** Stored on every connection. Lowercase, e.g. "plaid". */
  readonly id: string;
  readonly version: string;
  /** Shown to people. The provider's name, never a bank's. */
  readonly displayName: string;
  /** Which of the provider's environments this deployment is pointed at
   *  (Plaid: sandbox | production), when the provider has more than one. */
  readonly environment?: string;
  readonly capabilities: { readonly webhooks: boolean; readonly pendingTransactions: boolean; readonly balances: boolean };

  /**
   * A short-lived token for the provider's own browser component.
   *
   * `reauthSecret` re-opens an EXISTING connection so the person can sign in
   * again (Plaid calls it update mode). The connection and its credential are
   * kept; only the bank's consent is renewed.
   */
  createLinkSession(input: { organizationId: string; userId: string; reauthSecret?: ProviderSecret; signal: AbortSignal }): Promise<unknown>;
  /** Exchanges what the provider's browser component returned for a durable
   *  connection and its credential. */
  completeLink(input: { publicToken: string; signal: AbortSignal }): Promise<unknown>;
  /** The provider's current view of a connection — validated against
   *  `providerConnectionStateSchema`. */
  inspectConnection(input: { secret: ProviderSecret; signal: AbortSignal }): Promise<unknown>;
  fetchAccounts(input: { secret: ProviderSecret; signal: AbortSignal }): Promise<unknown>;
  /** Cursor-based and incremental: `null` starts from the beginning. */
  fetchTransactions(input: { secret: ProviderSecret; cursor: string | null; pageSize: number; signal: AbortSignal }): Promise<unknown>;
  revoke(input: { secret: ProviderSecret; signal: AbortSignal }): Promise<unknown>;
  /**
   * Verifies a webhook against the provider's signature scheme, using the raw
   * body. Throws (or returns something that fails the schema) for anything not
   * signed by the provider. The caller never parses an unverified body.
   */
  verifyWebhook(input: { rawBody: string; headers: Readonly<Record<string, string>>; receivedAt: Date }): Promise<unknown>;
}

/** Thrown by an adapter to report a failure it understands. Only the category
 *  crosses the boundary. */
export class BankProviderError extends Error {
  readonly category: SyncFailureCategory;
  constructor(category: SyncFailureCategory) {
    super(`Bank provider call failed: ${category}`);
    this.name = "BankProviderError";
    this.category = category;
  }
}

export type ProviderCallOutcome<T> = { ok: true; value: T; durationMs: number } | { ok: false; category: SyncFailureCategory; durationMs: number };

/**
 * Runs one provider call with a deadline and validates what came back.
 *
 * A thrown BankProviderError keeps its category. Anything else thrown becomes
 * PROVIDER_UNAVAILABLE, and its message is discarded unread.
 */
export async function runBankProviderCall<T>(
  call: (signal: AbortSignal) => Promise<unknown>,
  schema: z.ZodType<T>,
  timeoutMs = PROVIDER_CALL_TIMEOUT_MS,
): Promise<ProviderCallOutcome<T>> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });

  try {
    const raced = await Promise.race([call(controller.signal).then((value) => ({ value })), timeout]);
    if (raced === "timeout") return { ok: false, category: "PROVIDER_TIMEOUT", durationMs: Date.now() - started };
    const parsed = schema.safeParse(raced.value);
    if (!parsed.success) return { ok: false, category: "MALFORMED_PROVIDER_RESPONSE", durationMs: Date.now() - started };
    return { ok: true, value: parsed.data, durationMs: Date.now() - started };
  } catch (error) {
    if (error instanceof BankProviderError) return { ok: false, category: error.category, durationMs: Date.now() - started };
    if (controller.signal.aborted) return { ok: false, category: "PROVIDER_TIMEOUT", durationMs: Date.now() - started };
    return { ok: false, category: "PROVIDER_UNAVAILABLE", durationMs: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type BankProviderAvailability =
  | { available: true; provider: BankConnectionProvider }
  | { available: false; reason: "NOT_CONFIGURED"; message: string };

/**
 * The provider for a connection, or for a new one. With no provider configured
 * the answer is always "not configured" — never a stand-in.
 */
export function resolveBankProvider(providers: readonly BankConnectionProvider[], providerId?: string): BankProviderAvailability {
  const provider = providerId ? providers.find((candidate) => candidate.id === providerId) : providers[0];
  if (!provider) return { available: false, reason: "NOT_CONFIGURED", message: BANK_PROVIDER_NOT_CONFIGURED_MESSAGE };
  return { available: true, provider };
}
