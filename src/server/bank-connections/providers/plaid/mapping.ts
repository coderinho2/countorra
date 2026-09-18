import { z } from "zod";
import type { ProviderAccount, ProviderTransaction, ProviderWebhookEvent } from "@/domain/bank-connections/provider";
import type { ExternalAccountType, WebhookEventType } from "@/domain/bank-connections/types";
import { itemErrorToConnectionEvent } from "./errors";

/**
 * PLAID → THE PROVIDER CONTRACT. Pure functions, no SDK, no network.
 *
 * Everything Plaid sends is parsed leniently (unknown fields ignored, because
 * Plaid adds them) and then mapped onto the exact shapes
 * src/domain/bank-connections/provider.ts defines — which are validated again,
 * strictly, by `runBankProviderCall`. Two layers on purpose: this one knows
 * Plaid's vocabulary, that one knows Countorra's, and neither trusts the wire.
 *
 * THE THREE TRANSLATIONS THAT CARRY REAL RISK
 *
 * 1. MONEY. Plaid sends JSON numbers — doubles. Countorra never does
 *    arithmetic on those: they are rendered to a decimal STRING here, at four
 *    decimal places, and everything afterwards works from that string through
 *    src/domain/money. A value that cannot be represented exactly as a decimal
 *    string (infinite, NaN, absurdly large) yields no currency, which makes
 *    the transaction unimportable rather than imported wrongly.
 *
 * 2. SIGN. Plaid's amounts are positive when money LEAVES the account. That
 *    becomes a DEBIT, which becomes an expense — and a negative amount becomes
 *    a CREDIT, an income. The magnitude is always stored unsigned, matching
 *    the ledger's own convention (`transactions.amount_minor >= 0`).
 *
 * 3. BALANCES. For credit cards and loans Plaid reports the amount OWED as a
 *    positive number, the opposite of Countorra's convention, where money owed
 *    is negative. Those two are reconciled here, once, with the sign flipped
 *    for CREDIT and LOAN accounts only. The figure is displayed as "reported by
 *    bank" and never feeds a balance: Countorra's balances come from the ledger.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const plaidBalancesSchema = z
  .object({
    current: z.number().nullish(),
    available: z.number().nullish(),
    iso_currency_code: z.string().nullish(),
    unofficial_currency_code: z.string().nullish(),
  })
  .loose();

export const plaidAccountSchema = z
  .object({
    account_id: z.string().min(1).max(200),
    name: z.string().nullish(),
    official_name: z.string().nullish(),
    mask: z.string().nullish(),
    type: z.string().nullish(),
    subtype: z.string().nullish(),
    balances: plaidBalancesSchema.nullish(),
  })
  .loose();

export const plaidTransactionSchema = z
  .object({
    transaction_id: z.string().min(1).max(200),
    account_id: z.string().min(1).max(200),
    pending_transaction_id: z.string().max(200).nullish(),
    pending: z.boolean().nullish(),
    amount: z.number(),
    iso_currency_code: z.string().nullish(),
    unofficial_currency_code: z.string().nullish(),
    date: isoDate,
    authorized_date: isoDate.nullish(),
    name: z.string().nullish(),
    merchant_name: z.string().nullish(),
    personal_finance_category: z.object({ primary: z.string().nullish() }).loose().nullish(),
    category: z.array(z.string()).nullish(),
  })
  .loose();

export const plaidAccountsResponseSchema = z.object({ accounts: z.array(plaidAccountSchema).max(200) }).loose();

export const plaidSyncResponseSchema = z
  .object({
    added: z.array(plaidTransactionSchema).max(1000),
    modified: z.array(plaidTransactionSchema).max(1000),
    removed: z.array(z.object({ transaction_id: z.string().min(1).max(200) }).loose()).max(1000),
    next_cursor: z.string().min(1).max(1024),
    has_more: z.boolean(),
  })
  .loose();

export const plaidLinkTokenResponseSchema = z.object({ link_token: z.string().min(1).max(2048), expiration: z.string().min(1) }).loose();

export const plaidExchangeResponseSchema = z.object({ access_token: z.string().min(1).max(4096), item_id: z.string().min(1).max(200) }).loose();

export const plaidItemResponseSchema = z
  .object({
    item: z
      .object({
        item_id: z.string().min(1).max(200),
        institution_id: z.string().max(200).nullish(),
        error: z.object({ error_code: z.string().nullish(), error_type: z.string().nullish() }).loose().nullish(),
        consent_expiration_time: z.string().nullish(),
      })
      .loose(),
  })
  .loose();

export const plaidInstitutionResponseSchema = z.object({ institution: z.object({ institution_id: z.string().max(200), name: z.string().min(1) }).loose() }).loose();

export const plaidWebhookBodySchema = z
  .object({
    webhook_type: z.string().min(1).max(64),
    webhook_code: z.string().min(1).max(64),
    item_id: z.string().max(200).nullish(),
    error: z.object({ error_code: z.string().nullish() }).loose().nullish(),
    environment: z.string().max(32).nullish(),
  })
  .loose();

export type PlaidAccount = z.infer<typeof plaidAccountSchema>;
export type PlaidTransaction = z.infer<typeof plaidTransactionSchema>;
export type PlaidWebhookBody = z.infer<typeof plaidWebhookBodySchema>;

// ── Money ───────────────────────────────────────────────────────────────

/** Plaid never sends more than four decimals for any currency it supports;
 *  anything beyond that is refused downstream rather than rounded into the
 *  books. */
const MAX_PLAID_AMOUNT = 1e12;

export function plaidAmountToDecimal(amount: number): string | null {
  if (!Number.isFinite(amount)) return null;
  const magnitude = Math.abs(amount);
  if (magnitude > MAX_PLAID_AMOUNT) return null;
  const trimmed = magnitude.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return trimmed.length === 0 ? "0" : trimmed;
}

/** A signed balance, with the sign flipped for the account kinds where Plaid
 *  reports what is owed as a positive number. */
export function plaidBalanceToDecimal(value: number | null | undefined, negate: boolean): string | null {
  if (value === null || value === undefined) return null;
  const magnitude = plaidAmountToDecimal(value);
  if (magnitude === null || magnitude === "0") return magnitude;
  const negative = negate ? value >= 0 : value < 0;
  return negative ? `-${magnitude}` : magnitude;
}

const CURRENCY = /^[A-Z]{3}$/;

/** Plaid's own code, or none. A currency Countorra cannot recognise is left
 *  null, which keeps the transaction out of the ledger with a stated reason
 *  instead of being posted in the wrong currency. */
export function pickCurrency(iso: string | null | undefined, unofficial: string | null | undefined): string | null {
  const candidate = (iso ?? unofficial ?? "").toUpperCase();
  return CURRENCY.test(candidate) ? candidate : null;
}

// ── Accounts ────────────────────────────────────────────────────────────

const ACCOUNT_TYPE: Record<string, ExternalAccountType> = {
  depository: "DEPOSITORY",
  credit: "CREDIT",
  loan: "LOAN",
  investment: "INVESTMENT",
  brokerage: "INVESTMENT",
  other: "OTHER",
};

function normalizeSubtype(subtype: string | null | undefined): string | null {
  if (!subtype) return null;
  const cleaned = subtype
    .toLowerCase()
    .replace(/[^a-z0-9 _]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return /^[a-z]/.test(cleaned) ? cleaned : null;
}

export function toProviderAccount(raw: PlaidAccount): ProviderAccount {
  const type = ACCOUNT_TYPE[(raw.type ?? "other").toLowerCase()] ?? "OTHER";
  const owed = type === "CREDIT" || type === "LOAN";
  return {
    providerAccountId: raw.account_id,
    name: (raw.name ?? raw.official_name ?? "Bank account").slice(0, 200),
    type,
    subtype: normalizeSubtype(raw.subtype),
    // Whatever Plaid calls a mask; normalization keeps at most four characters,
    // so a full account number can never be stored even if one arrived here.
    mask: raw.mask ?? null,
    currency: pickCurrency(raw.balances?.iso_currency_code, raw.balances?.unofficial_currency_code),
    currentBalance: plaidBalanceToDecimal(raw.balances?.current, owed),
    availableBalance: plaidBalanceToDecimal(raw.balances?.available, owed),
    // Plaid returns only open accounts; a closed one stops being listed, which
    // the sync sees as an account it no longer reports.
    state: "OPEN",
  };
}

// ── Transactions ────────────────────────────────────────────────────────

export function toProviderTransaction(raw: PlaidTransaction): ProviderTransaction {
  const pending = raw.pending === true;
  const amount = plaidAmountToDecimal(raw.amount);
  return {
    providerTransactionId: raw.transaction_id,
    providerAccountId: raw.account_id,
    // Plaid gives a posted transaction the id of the pending one it replaces.
    pendingProviderTransactionId: raw.pending_transaction_id ?? null,
    status: pending ? "PENDING" : "POSTED",
    // Positive means money left the account.
    direction: raw.amount >= 0 ? "DEBIT" : "CREDIT",
    // An amount that cannot be represented exactly carries no currency, so
    // reconciliation refuses it instead of importing a wrong figure.
    amount: amount ?? "0",
    currency: amount === null ? null : pickCurrency(raw.iso_currency_code, raw.unofficial_currency_code),
    // When it happened, as a person would date it — not when it cleared.
    transactionDate: raw.authorized_date ?? raw.date,
    postedDate: pending ? null : raw.date,
    authorizedDate: raw.authorized_date ?? null,
    merchantName: raw.merchant_name ?? null,
    description: raw.name ?? null,
    categoryHint: raw.personal_finance_category?.primary ?? raw.category?.[0] ?? null,
  };
}

// ── Webhooks ────────────────────────────────────────────────────────────

/**
 * Which Plaid webhooks Countorra acts on. Everything else is acknowledged and
 * recorded as UNSUPPORTED — Plaid requires a 2xx, and inventing a meaning for
 * an event this product does not handle is how state gets corrupted.
 */
const WEBHOOK_EVENTS: Record<string, WebhookEventType> = {
  // New, changed or removed transactions: fetch them with the stored
  // credential. The webhook body is never treated as transaction data.
  "TRANSACTIONS:SYNC_UPDATES_AVAILABLE": "TRANSACTIONS_UPDATED",
  "TRANSACTIONS:DEFAULT_UPDATE": "TRANSACTIONS_UPDATED",
  "TRANSACTIONS:INITIAL_UPDATE": "TRANSACTIONS_UPDATED",
  "TRANSACTIONS:HISTORICAL_UPDATE": "TRANSACTIONS_UPDATED",
  "TRANSACTIONS:TRANSACTIONS_REMOVED": "TRANSACTIONS_UPDATED",
  // An account was added or removed at the bank. A sync re-reads the account
  // list, which is exactly the right response.
  "ITEM:NEW_ACCOUNTS_AVAILABLE": "TRANSACTIONS_UPDATED",
  "ITEM:PENDING_EXPIRATION": "CONSENT_EXPIRING",
  "ITEM:PENDING_DISCONNECT": "CONNECTION_REQUIRES_REAUTH",
  "ITEM:USER_PERMISSION_REVOKED": "CONNECTION_REVOKED",
  "ITEM:USER_ACCOUNT_REVOKED": "CONNECTION_REVOKED",
  "ITEM:LOGIN_REPAIRED": "CONNECTION_RECOVERED",
};

/**
 * `ITEM:ERROR` carries the actual problem in its error code, so the event type
 * comes from that: a login the customer must repair is not the same as a
 * revoked consent, and neither is a generic failure.
 */
function itemErrorEventType(errorCode: string | null): WebhookEventType {
  const event = itemErrorToConnectionEvent(errorCode);
  if (event?.kind === "PROVIDER_REAUTH_REQUIRED") return "CONNECTION_REQUIRES_REAUTH";
  if (event?.kind === "PROVIDER_REVOKED") return "CONNECTION_REVOKED";
  return "CONNECTION_ERROR";
}

export function classifyPlaidWebhook(body: PlaidWebhookBody, context: { providerEventId: string; occurredAt: string | null }): ProviderWebhookEvent {
  const providerEventType = `${body.webhook_type}:${body.webhook_code}`.slice(0, 100);
  const type = providerEventType === "ITEM:ERROR" ? itemErrorEventType(body.error?.error_code ?? null) : (WEBHOOK_EVENTS[providerEventType] ?? "UNSUPPORTED");
  return {
    providerEventId: context.providerEventId,
    providerEventType,
    type,
    providerConnectionId: body.item_id ?? null,
    occurredAt: context.occurredAt,
  };
}
