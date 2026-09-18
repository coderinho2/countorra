import { fromMajorUnits } from "@/domain/money/money";
import { isSupportedCurrency, minorUnitExponent } from "@/domain/money/currency";
import { sanitizeText } from "@/domain/documents/intelligence/normalization";
import type { ProviderAccount, ProviderTransaction, ProviderTransactionsPage } from "./provider";
import type { Direction, ExternalAccountType, ExternalTransactionStatus } from "./types";

/**
 * From a validated provider page to rows Countorra can store.
 *
 * MONEY
 *
 * Amounts arrive as decimal strings and become integer minor units through
 * `fromMajorUnits` — the one sanctioned conversion in src/domain/money. Two
 * refusals keep that exact:
 *
 *   * A value with more decimals than its currency has minor units ("12.345"
 *     USD) is REJECTED. `fromMajorUnits` would truncate it, which is right for
 *     a typed amount and wrong for a bank's figure: the bank said something
 *     Countorra cannot represent, and dropping a digit would be inventing.
 *   * A currency Countorra does not support keeps its decimal string and gets
 *     no minor-unit amount at all. Its exponent is not known here, and guessing
 *     one (JPY has none, KWD has three) would silently scale the amount.
 *
 * No currency is ever assumed and none is converted. A transaction with no
 * currency is rejected, never defaulted to the account's or the workspace's.
 *
 * TEXT
 *
 * Merchant names and descriptions are bank-supplied strings that will be shown
 * in the product and read by the AI. They pass through the same sanitizer as
 * document text: control and invisible characters removed, whitespace
 * collapsed, length bounded.
 */

export type AmountResult = { ok: true; amountDecimal: string; amountMinor: number | null } | { ok: false; reason: "INVALID_AMOUNT" | "PRECISION_EXCEEDS_CURRENCY" };

const UNSIGNED = /^(\d{1,15})(?:\.(\d{1,4}))?$/;
const SIGNED = /^(-?)(\d{1,15})(?:\.(\d{1,4}))?$/;

function canonical(whole: string, fraction: string | undefined): string {
  const trimmedWhole = whole.replace(/^0+(?=\d)/, "");
  const trimmedFraction = (fraction ?? "").replace(/0+$/, "");
  return trimmedFraction ? `${trimmedWhole}.${trimmedFraction}` : trimmedWhole;
}

export function normalizeAmount(decimal: string, currency: string): AmountResult {
  const match = UNSIGNED.exec(decimal);
  if (!match) return { ok: false, reason: "INVALID_AMOUNT" };
  const amountDecimal = canonical(match[1], match[2]);
  if (!isSupportedCurrency(currency)) return { ok: true, amountDecimal, amountMinor: null };

  const significantFraction = (match[2] ?? "").replace(/0+$/, "");
  if (significantFraction.length > minorUnitExponent(currency)) return { ok: false, reason: "PRECISION_EXCEEDS_CURRENCY" };
  try {
    return { ok: true, amountDecimal, amountMinor: fromMajorUnits(amountDecimal, currency).amountMinor };
  } catch {
    return { ok: false, reason: "INVALID_AMOUNT" };
  }
}

/** A signed balance in minor units, or null when it cannot be represented. */
export function normalizeBalance(decimal: string | null, currency: string | null): number | null {
  if (decimal === null || currency === null || !isSupportedCurrency(currency)) return null;
  const match = SIGNED.exec(decimal);
  if (!match) return null;
  const significantFraction = (match[3] ?? "").replace(/0+$/, "");
  if (significantFraction.length > minorUnitExponent(currency)) return null;
  try {
    return fromMajorUnits(`${match[1]}${canonical(match[2], match[3])}`, currency).amountMinor;
  } catch {
    return null;
  }
}

/** At most the last four letters or digits. A full account number passed as a
 *  "mask" is reduced to what a statement would print. */
export function normalizeMask(value: string | null): string | null {
  if (value === null) return null;
  const alphanumeric = value.replace(/[^0-9A-Za-z]/g, "");
  if (alphanumeric.length < 2) return null;
  return alphanumeric.slice(-4);
}

export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1990 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function cleanText(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  const cleaned = sanitizeText(value, maxLength);
  return cleaned.length > 0 ? cleaned : null;
}

export interface NormalizedExternalAccount {
  providerAccountId: string;
  displayName: string;
  accountType: ExternalAccountType;
  accountSubtype: string | null;
  mask: string | null;
  currency: string | null;
  currentBalanceMinor: number | null;
  availableBalanceMinor: number | null;
  providerState: "OPEN" | "CLOSED";
}

export function normalizeProviderAccount(account: ProviderAccount): NormalizedExternalAccount {
  return {
    providerAccountId: account.providerAccountId,
    displayName: cleanText(account.name, 120) ?? "Bank account",
    accountType: account.type,
    accountSubtype: account.subtype ? account.subtype.replace(/ /g, "_").slice(0, 40) : null,
    mask: normalizeMask(account.mask),
    currency: account.currency,
    currentBalanceMinor: normalizeBalance(account.currentBalance, account.currency),
    availableBalanceMinor: normalizeBalance(account.availableBalance, account.currency),
    providerState: account.state,
  };
}

export interface NormalizedExternalTransaction {
  providerTransactionId: string;
  providerAccountId: string;
  pendingProviderTransactionId: string | null;
  status: Extract<ExternalTransactionStatus, "PENDING" | "POSTED">;
  direction: Direction;
  amountDecimal: string;
  amountMinor: number | null;
  currency: string;
  transactionDate: string;
  postedDate: string | null;
  authorizedDate: string | null;
  merchantName: string | null;
  description: string | null;
  categoryHint: string | null;
  /** Every stored field in a fixed order. The server hashes it; an unchanged
   *  hash is what makes a repeated sync a no-op. */
  contentFingerprint: string;
}

export type TransactionRejectionReason = "CURRENCY_MISSING" | "INVALID_AMOUNT" | "PRECISION_EXCEEDS_CURRENCY" | "INVALID_DATE";

export type NormalizedTransactionResult = { ok: true; transaction: NormalizedExternalTransaction } | { ok: false; providerTransactionId: string; reason: TransactionRejectionReason };

export function normalizeProviderTransaction(transaction: ProviderTransaction): NormalizedTransactionResult {
  const reject = (reason: TransactionRejectionReason): NormalizedTransactionResult => ({ ok: false, providerTransactionId: transaction.providerTransactionId, reason });

  if (transaction.currency === null) return reject("CURRENCY_MISSING");
  const amount = normalizeAmount(transaction.amount, transaction.currency);
  if (!amount.ok) return reject(amount.reason);
  for (const date of [transaction.transactionDate, transaction.postedDate, transaction.authorizedDate]) {
    if (date !== null && !isCalendarDate(date)) return reject("INVALID_DATE");
  }

  const normalized: Omit<NormalizedExternalTransaction, "contentFingerprint"> = {
    providerTransactionId: transaction.providerTransactionId,
    providerAccountId: transaction.providerAccountId,
    // Only a posted transaction replaces a pending one.
    pendingProviderTransactionId: transaction.status === "POSTED" ? transaction.pendingProviderTransactionId : null,
    status: transaction.status,
    direction: transaction.direction,
    amountDecimal: amount.amountDecimal,
    amountMinor: amount.amountMinor,
    currency: transaction.currency,
    transactionDate: transaction.transactionDate,
    postedDate: transaction.status === "POSTED" ? transaction.postedDate : null,
    authorizedDate: transaction.authorizedDate,
    merchantName: cleanText(transaction.merchantName, 200),
    description: cleanText(transaction.description, 300),
    categoryHint: cleanText(transaction.categoryHint, 100),
  };

  const contentFingerprint = JSON.stringify([
    normalized.providerAccountId,
    normalized.pendingProviderTransactionId,
    normalized.status,
    normalized.direction,
    normalized.amountDecimal,
    normalized.currency,
    normalized.transactionDate,
    normalized.postedDate,
    normalized.authorizedDate,
    normalized.merchantName,
    normalized.description,
    normalized.categoryHint,
  ]);

  return { ok: true, transaction: { ...normalized, contentFingerprint } };
}

export interface NormalizedPage {
  accounts: NormalizedExternalAccount[];
  /** Added and modified together, pending before posted, so a page carrying
   *  both a pending transaction and the posted one replacing it applies the
   *  pending one first. */
  transactions: NormalizedExternalTransaction[];
  removedProviderTransactionIds: string[];
  rejected: { providerTransactionId: string; reason: TransactionRejectionReason }[];
  nextCursor: string;
  hasMore: boolean;
}

export function normalizeTransactionsPage(page: ProviderTransactionsPage): NormalizedPage {
  const transactions: NormalizedExternalTransaction[] = [];
  const rejected: NormalizedPage["rejected"] = [];

  for (const transaction of [...page.added, ...page.modified]) {
    const result = normalizeProviderTransaction(transaction);
    if (result.ok) transactions.push(result.transaction);
    else rejected.push({ providerTransactionId: result.providerTransactionId, reason: result.reason });
  }

  transactions.sort((a, b) => (a.status === b.status ? 0 : a.status === "PENDING" ? -1 : 1));

  return {
    accounts: page.accounts.map(normalizeProviderAccount),
    transactions,
    removedProviderTransactionIds: [...new Set(page.removed.map((removed) => removed.providerTransactionId))],
    rejected,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}
