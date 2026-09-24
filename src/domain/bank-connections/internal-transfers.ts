import { MATCH_DATE_WINDOW_DAYS, daysBetween } from "./reconciliation";
import type { ExternalTransactionStatus, ReconciliationState } from "./types";

/**
 * INTERNAL TRANSFERS — money that moved between two accounts the same person
 * owns, and the reason the totals were wrong without it.
 *
 * THE BUG THIS EXISTS FOR
 *
 * A provider reports one movement twice: a DEBIT on the account it left and a
 * CREDIT on the account it reached. `kindForDirection` turns those into an
 * expense and an income, so $500 moved from checking to savings became $500
 * of spending AND $500 of earnings. Net cash flow stayed right and every
 * component figure was wrong. A credit-card payment was worse: the purchases
 * on the card were already expenses, so the payment added a second one.
 *
 * WHAT A TRANSFER LOOKS LIKE IN THE LEDGER, AND WHY ONE ROW
 *
 * The ledger has modelled transfers since migration 0016: ONE row, carrying
 * `account_id` (where it left) and `transfer_account_id` (where it arrived).
 * The balance engine reads exactly that — `account_id` is debited,
 * `transfer_account_id` is credited — so a single row moves money correctly
 * in both directions, and `calculation-engine.ts` excludes transfers from
 * every income and expense aggregate.
 *
 * That is why this pairs two external transactions into ONE ledger row rather
 * than marking both as transfers. Two transfer rows would debit BOTH accounts
 * and the money would never arrive anywhere.
 *
 * CONSERVATISM IS THE WHOLE DESIGN
 *
 * A false positive here silently rewrites somebody's income. A missed match
 * leaves the figures exactly as they are today. Those are not comparable, so
 * every rule below is a REQUIREMENT and the answer to any doubt is `NONE`:
 *
 *   - identical amount AND identical currency, never "close enough"
 *   - opposite directions, both POSTED, never pending
 *   - two DIFFERENT accounts, both belonging to this workspace
 *   - within the same date window the rest of reconciliation already uses
 *   - EXACTLY ONE candidate. Two possible counterparts is ambiguity, and
 *     ambiguity is left alone rather than resolved by picking the nearest.
 *   - and a CORROBORATING SIGNAL. Matching amounts and dates alone is not
 *     evidence: two unrelated $500 charges, payroll against a $2,000
 *     transfer, or rent against a same-sized movement would all qualify.
 *
 * WHAT COUNTS AS CORROBORATION
 *
 * Either the provider says so — `categoryHint` is Plaid's
 * `personal_finance_category.primary`, whose taxonomy has TRANSFER_IN,
 * TRANSFER_OUT and LOAN_PAYMENTS — or the structure says so, which is the
 * credit-card case: money leaving a bank account and arriving at a CARD
 * account is a card payment, and no metadata is needed to know it.
 *
 * Nothing here is invented: both signals are already stored (migration 0047's
 * `category_hint`, and `accounts.kind` from 0004).
 */

/** Plaid's personal-finance-category primaries that describe a movement
 *  between accounts rather than a purchase. LOAN_PAYMENTS covers a card
 *  payment, which is the case this matters most for. */
const TRANSFER_CATEGORY_HINTS: readonly string[] = ["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"];

/**
 * Whether this transaction is worth LOOKING for a counterpart for.
 *
 * A cheap gate in front of the candidate query, and the reason it exists is
 * cost rather than correctness: without it every purchase in every sync pays
 * for a database round trip that will find nothing, which was measurably slow
 * enough to push a multi-page backlog past its time budget.
 *
 * Gating on the provider's own label is safe because BOTH legs are evaluated
 * as the sync reaches them: a pair is found as long as EITHER side carries the
 * label. The case it does give up is a card payment where neither side is
 * labelled at all — a miss, never a false pairing, which is the direction this
 * whole feature errs in.
 */
export function worthSearchingForCounterpart(categoryHint: string | null): boolean {
  return categoryHint !== null && TRANSFER_CATEGORY_HINTS.includes(categoryHint.toUpperCase());
}

export type AccountKind = "cash" | "bank" | "credit_card" | "wallet" | "other";

/** One side of a possible transfer, as the store reads it. */
export interface TransferSide {
  id: string;
  organizationId: string;
  linkedAccountId: string;
  /** The Countorra account this external imports into, when it has one. */
  accountId: string | null;
  accountKind: AccountKind | null;
  direction: "DEBIT" | "CREDIT";
  amountMinor: number | null;
  currency: string;
  transactionDate: string;
  status: ExternalTransactionStatus;
  categoryHint: string | null;
  reconciliationState: ReconciliationState;
  /** The ledger row this external already produced, if any. */
  ledgerTransactionId: string | null;
  /** Set once this external belongs to a pair. */
  transferCounterpartId: string | null;
  /** False when the link is detached, not in IMPORT mode, or has no account. */
  importable: boolean;
}

export type TransferCorroboration =
  /** The provider categorised at least one side as a transfer or a loan payment. */
  | "PROVIDER_CATEGORY"
  /** Money left a non-card account and arrived at a credit card. */
  | "CARD_PAYMENT";

export type TransferRejection =
  | "NOT_POSTED"
  | "ALREADY_PAIRED"
  | "NO_AMOUNT"
  | "SAME_ACCOUNT"
  | "NOT_IMPORTABLE"
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "SAME_DIRECTION"
  | "DATE_OUT_OF_WINDOW"
  | "DIFFERENT_ORGANIZATION"
  | "NO_CORROBORATION"
  | "AMBIGUOUS"
  | "NO_CANDIDATE"
  /** The credit side already produced an income row. Representing the pair as
   *  one row would mean deleting it, and this system never deletes a
   *  financial record automatically — a person is asked instead. */
  | "COUNTERPART_ALREADY_IMPORTED";

export type TransferMatch =
  | {
      kind: "PAIR";
      /** The DEBIT leg. It owns the single ledger row. */
      source: TransferSide;
      /** The CREDIT leg. It produces no ledger row. */
      counterpart: TransferSide;
      corroboration: TransferCorroboration;
      /** True when the source already imported as an expense and the row has
       *  to be corrected in place rather than created. */
      retroCorrection: boolean;
    }
  | { kind: "NONE"; reason: TransferRejection };

const none = (reason: TransferRejection): TransferMatch => ({ kind: "NONE", reason });

/** Whether this side can take part in a pair at all, before any comparison. */
export function eligible(side: TransferSide): TransferRejection | null {
  if (side.status !== "POSTED") return "NOT_POSTED";
  if (side.transferCounterpartId !== null) return "ALREADY_PAIRED";
  if (side.amountMinor === null || side.amountMinor <= 0) return "NO_AMOUNT";
  if (!side.importable || side.accountId === null) return "NOT_IMPORTABLE";
  return null;
}

function corroborationFor(debit: TransferSide, credit: TransferSide): TransferCorroboration | null {
  // Structure first: it needs no provider metadata and cannot be wrong about
  // what a card payment is.
  if (credit.accountKind === "credit_card" && debit.accountKind !== "credit_card") return "CARD_PAYMENT";
  const hint = (side: TransferSide) => (side.categoryHint ? TRANSFER_CATEGORY_HINTS.includes(side.categoryHint.toUpperCase()) : false);
  if (hint(debit) || hint(credit)) return "PROVIDER_CATEGORY";
  return null;
}

/** Why a specific candidate cannot be this side's counterpart. */
function rejectPair(a: TransferSide, b: TransferSide): TransferRejection | null {
  if (a.organizationId !== b.organizationId) return "DIFFERENT_ORGANIZATION";
  const blocked = eligible(b);
  if (blocked) return blocked;
  if (a.direction === b.direction) return "SAME_DIRECTION";
  if (a.linkedAccountId === b.linkedAccountId || a.accountId === b.accountId) return "SAME_ACCOUNT";
  if (a.currency !== b.currency) return "CURRENCY_MISMATCH";
  if (a.amountMinor !== b.amountMinor) return "AMOUNT_MISMATCH";
  if (daysBetween(a.transactionDate, b.transactionDate) > MATCH_DATE_WINDOW_DAYS) return "DATE_OUT_OF_WINDOW";
  return null;
}

/**
 * The one counterpart for this external, or nothing.
 *
 * `candidates` is whatever the store found in the same organization and date
 * window; this function does not trust it to be filtered and re-checks every
 * rule, including the organization, because a matcher that assumes its input
 * was scoped correctly is one query bug away from pairing across tenants.
 *
 * Called with EITHER leg. Whichever of the two is reconciled first claims the
 * pair, which is what keeps the common case free of a phantom row: the credit
 * leg is marked as belonging to the pair before it is ever imported.
 */
export function matchInternalTransfer(side: TransferSide, candidates: readonly TransferSide[]): TransferMatch {
  const blocked = eligible(side);
  if (blocked) return none(blocked);

  const viable = candidates.filter((candidate) => candidate.id !== side.id && rejectPair(side, candidate) === null);
  if (viable.length === 0) return none("NO_CANDIDATE");
  // Three-way ambiguity: one debit and two equal credits. Choosing either
  // would be a guess about somebody's money.
  if (viable.length > 1) return none("AMBIGUOUS");

  const [other] = viable;
  const debit = side.direction === "DEBIT" ? side : other;
  const credit = side.direction === "DEBIT" ? other : side;

  const corroboration = corroborationFor(debit, credit);
  if (!corroboration) return none("NO_CORROBORATION");

  // The credit leg must not already own a ledger row: that row is the phantom
  // income, and removing it is a deletion this system does not do on its own.
  // Flagged for a person instead (see the sync integration).
  if (credit.ledgerTransactionId !== null) return none("COUNTERPART_ALREADY_IMPORTED");

  return {
    kind: "PAIR",
    source: debit,
    counterpart: credit,
    corroboration,
    // The debit leg may already have imported as an expense while its
    // counterpart had not yet arrived. Correcting that row in place is the
    // delayed-arrival case; nothing is deleted either way.
    retroCorrection: debit.ledgerTransactionId !== null,
  };
}

/** How far back a delayed counterpart may still correct an imported row. */
export const RETRO_CORRECTION_LOOKBACK_DAYS = 30;

/**
 * Whether an already-imported debit row is still young enough to correct.
 *
 * A bound exists so that a transfer discovered months later cannot silently
 * restate a period somebody has already reviewed, exported, or used to
 * prepare a tax figure.
 */
export function withinRetroCorrectionWindow(transactionDate: string, today: string): boolean {
  return daysBetween(transactionDate, today) <= RETRO_CORRECTION_LOOKBACK_DAYS;
}
