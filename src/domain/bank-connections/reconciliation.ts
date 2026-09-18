import type { Direction, ExternalTransactionStatus, ImportMode, ReconciliationState, ReviewReason } from "./types";

/**
 * FROM A BANK'S TRANSACTION TO THE LEDGER. Pure.
 *
 * `decideReconciliation` looks at one external transaction and everything
 * around it, and says what should happen. The database function
 * `bank_reconcile_transaction` (migration 0047) then applies that decision in
 * one transaction, re-checking every precondition under a row lock and against
 * the revision this decision was made on — so a decision made on a stale read
 * is refused, not applied.
 *
 * THE RULES
 *
 *   Pending transactions never enter the ledger. The ledger is the books; a
 *   pending card authorisation can still change amount or vanish, and posting
 *   it would mean deleting ledger rows later. A pending transaction waits, and
 *   the posted transaction that replaces it — same provider id or a new one —
 *   is what gets reconciled. So pending → posted can never create two ledger
 *   rows: the pending one never created any.
 *
 *   A posted transaction whose account is not linked, or is ignored, stays
 *   out of the ledger. Linking is a person's decision.
 *
 *   A posted transaction is first matched against transactions a person
 *   already entered by hand: same Countorra account, same kind, same amount,
 *   same currency, dated within MATCH_DATE_WINDOW_DAYS, and not already linked
 *   to another bank transaction. Exactly one candidate: linked, and the
 *   hand-entered row is left exactly as it is. More than one: a person
 *   chooses. None: a new ledger transaction is created, attributed to no one,
 *   with source `bank_sync`.
 *
 *   A person's edit always wins. The values a sync last wrote (or a person last
 *   acknowledged) are kept as a snapshot. If the bank later changes the
 *   transaction and the ledger row still equals that snapshot, the ledger row
 *   follows the bank. If a person has edited it, nothing is overwritten — the
 *   transaction is flagged for review.
 *
 *   Nothing is deleted from the ledger automatically. A posted transaction the
 *   bank removes is flagged for review. A ledger transaction a person deletes
 *   is not imported again.
 *
 *   Currencies are never converted. A transaction in a currency other than its
 *   linked account's, or in one Countorra cannot hold, is recorded and kept out
 *   of the ledger with a state that says why.
 */

export const MATCH_DATE_WINDOW_DAYS = 3;

export type LedgerKind = "income" | "expense";

/** The ledger fields a sync controls. Category, memo, review flag and
 *  everything else on a transaction belong to the person. */
export interface LedgerFields {
  accountId: string;
  kind: LedgerKind;
  amountMinor: number;
  currency: string;
  occurredOn: string;
  description: string | null;
}

export interface ExternalForReconciliation {
  id: string;
  revision: number;
  status: ExternalTransactionStatus;
  direction: Direction;
  amountMinor: number | null;
  currency: string;
  transactionDate: string;
  merchantName: string | null;
  description: string | null;
  reconciliationState: ReconciliationState;
  reviewReason: ReviewReason | null;
  /** The revision a person last resolved a review on, if any. */
  reviewResolvedRevision: number | null;
  ledgerTransactionId: string | null;
  ledgerLinkKind: "IMPORTED" | "MATCHED" | null;
  ledgerLinkedAt: string | null;
  /** Provider values last applied to, or acknowledged against, the ledger. */
  written: LedgerFields | null;
}

export interface LinkedAccountForReconciliation {
  importMode: ImportMode;
  accountId: string | null;
  currency: string | null;
  detached: boolean;
}

export interface CountorraAccountForReconciliation {
  id: string;
  currency: string;
}

/** A ledger row as it is now. A person may have turned an import into a
 *  transfer; that is simply no longer equal to what a sync wrote. */
export interface LedgerRowForReconciliation extends Omit<LedgerFields, "kind"> {
  id: string;
  kind: LedgerKind | "transfer";
  source: "manual" | "import" | "bank_sync" | "ai";
}

export interface ManualCandidate {
  id: string;
  accountId: string;
  kind: "income" | "expense" | "transfer";
  amountMinor: number;
  currency: string;
  occurredOn: string;
  source: "manual" | "import" | "bank_sync" | "ai";
}

export interface CandidateQuery {
  accountId: string;
  kind: LedgerKind;
  amountMinor: number;
  currency: string;
  dateFrom: string;
  dateTo: string;
}

export type ReconciliationDecision =
  | { kind: "SET_STATE"; state: ReconciliationState; reviewReason: ReviewReason | null }
  /** Load candidates with this query and decide again. */
  | { kind: "NEEDS_CANDIDATES"; query: CandidateQuery }
  | { kind: "IMPORT"; ledger: LedgerFields }
  | { kind: "MATCH"; ledgerTransactionId: string; acknowledged: LedgerFields }
  | { kind: "UPDATE_LEDGER"; ledger: LedgerFields };

export interface ReconciliationInput {
  external: ExternalForReconciliation;
  linkedAccount: LinkedAccountForReconciliation;
  /** The linked Countorra account, if it exists. */
  account: CountorraAccountForReconciliation | null;
  /** The ledger row the external transaction is linked to, if it still exists. */
  ledger: LedgerRowForReconciliation | null;
  /** `null` means "not loaded yet". */
  candidates: readonly ManualCandidate[] | null;
}

const setState = (state: ReconciliationState, reviewReason: ReviewReason | null = null): ReconciliationDecision => ({ kind: "SET_STATE", state, reviewReason });

export function kindForDirection(direction: Direction): LedgerKind {
  return direction === "CREDIT" ? "income" : "expense";
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round(Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000);
}

/** The ledger fields this external transaction would carry in `accountId`. */
export function ledgerFieldsFor(external: Pick<ExternalForReconciliation, "direction" | "amountMinor" | "currency" | "transactionDate" | "merchantName" | "description">, accountId: string): LedgerFields | null {
  if (external.amountMinor === null) return null;
  return {
    accountId,
    kind: kindForDirection(external.direction),
    amountMinor: external.amountMinor,
    currency: external.currency,
    // The day the transaction happened, as a person entering it would date
    // it — not the day it cleared.
    occurredOn: external.transactionDate,
    description: external.merchantName ?? external.description,
  };
}

type ComparableLedgerFields = Omit<LedgerFields, "kind"> & { kind: string };

export function sameLedgerFields(a: ComparableLedgerFields, b: ComparableLedgerFields): boolean {
  return (
    a.accountId === b.accountId &&
    a.kind === b.kind &&
    a.amountMinor === b.amountMinor &&
    a.currency === b.currency &&
    a.occurredOn === b.occurredOn &&
    (a.description ?? null) === (b.description ?? null)
  );
}

/** Whether a hand-entered transaction is the same money movement. Description
 *  is deliberately not compared: people and banks name things differently. */
export function isMatchCandidate(candidate: ManualCandidate, fields: LedgerFields): boolean {
  return (
    candidate.source !== "bank_sync" &&
    candidate.accountId === fields.accountId &&
    candidate.kind === fields.kind &&
    candidate.amountMinor === fields.amountMinor &&
    candidate.currency === fields.currency &&
    daysBetween(candidate.occurredOn, fields.occurredOn) <= MATCH_DATE_WINDOW_DAYS
  );
}

export function candidateQueryFor(fields: LedgerFields): CandidateQuery {
  return {
    accountId: fields.accountId,
    kind: fields.kind,
    amountMinor: fields.amountMinor,
    currency: fields.currency,
    dateFrom: addDays(fields.occurredOn, -MATCH_DATE_WINDOW_DAYS),
    dateTo: addDays(fields.occurredOn, MATCH_DATE_WINDOW_DAYS),
  };
}

export function decideReconciliation(input: ReconciliationInput): ReconciliationDecision {
  const { external, linkedAccount, account, ledger } = input;
  const everLinked = external.ledgerLinkedAt !== null;
  const linked = external.ledgerTransactionId !== null;

  // A person already resolved this exact revision: their answer stands until
  // the bank reports something new.
  if (external.reviewResolvedRevision === external.revision && external.reconciliationState !== "NEEDS_REVIEW" && external.reconciliationState !== "UNRECONCILED") {
    return setState(external.reconciliationState, null);
  }

  // Waiting on a person already. A new sync does not answer for them.
  if (external.reconciliationState === "NEEDS_REVIEW" && external.status !== "REMOVED") {
    return setState("NEEDS_REVIEW", external.reviewReason);
  }

  if (external.status === "SUPERSEDED") return linked ? setState("NEEDS_REVIEW", "REMOVED_BY_PROVIDER") : setState("NOT_POSTED");

  if (external.status === "REMOVED") {
    if (linked) return setState("NEEDS_REVIEW", "REMOVED_BY_PROVIDER");
    return everLinked ? setState("REMOVED_FROM_BOOKS") : setState("NOT_POSTED");
  }

  if (external.status === "PENDING") return setState("PENDING_SETTLEMENT");

  // ── POSTED ──────────────────────────────────────────────────────────

  if (everLinked && (!linked || ledger === null)) return setState("REMOVED_FROM_BOOKS");

  if (linked && ledger) {
    const desired = ledgerFieldsFor(external, ledger.accountId);
    if (!desired) return setState("UNSUPPORTED_CURRENCY");

    if (external.ledgerLinkKind === "MATCHED") {
      if (external.written && sameLedgerFields(external.written, desired)) return setState("MATCHED");
      const stillMatches = ledger.kind === desired.kind && ledger.amountMinor === desired.amountMinor && ledger.currency === desired.currency && daysBetween(ledger.occurredOn, desired.occurredOn) <= MATCH_DATE_WINDOW_DAYS;
      return stillMatches ? setState("MATCHED") : setState("NEEDS_REVIEW", "PROVIDER_CHANGED_MATCHED");
    }

    const baseline = external.written;
    const providerChanged = baseline === null || !sameLedgerFields(baseline, desired);
    if (!providerChanged) return setState("IMPORTED");
    const personEdited = baseline === null || !sameLedgerFields(baseline, ledger);
    if (personEdited) return setState("NEEDS_REVIEW", "PROVIDER_CHANGED_AFTER_EDIT");
    return { kind: "UPDATE_LEDGER", ledger: desired };
  }

  // ── POSTED, never in the ledger ──────────────────────────────────────

  if (linkedAccount.importMode === "IGNORE") return setState("IGNORED");
  if (linkedAccount.importMode !== "IMPORT" || linkedAccount.detached || linkedAccount.accountId === null || account === null || account.id !== linkedAccount.accountId) {
    return setState("AWAITING_ACCOUNT_LINK");
  }
  if (external.amountMinor === null) return setState("UNSUPPORTED_CURRENCY");
  if (external.currency !== account.currency || (linkedAccount.currency !== null && linkedAccount.currency !== external.currency)) {
    return setState("CURRENCY_MISMATCH");
  }

  const fields = ledgerFieldsFor(external, account.id)!;
  if (input.candidates === null) return { kind: "NEEDS_CANDIDATES", query: candidateQueryFor(fields) };

  const matches = input.candidates.filter((candidate) => isMatchCandidate(candidate, fields));
  if (matches.length === 1) return { kind: "MATCH", ledgerTransactionId: matches[0].id, acknowledged: fields };
  if (matches.length > 1) return setState("NEEDS_REVIEW", "AMBIGUOUS_MANUAL_MATCH");
  return { kind: "IMPORT", ledger: fields };
}

// ── A person resolving a review ─────────────────────────────────────────

export type ReviewResolution =
  /** Leave the ledger exactly as it is and accept the bank's current values as
   *  the new baseline. For a linked transaction. */
  | { kind: "KEEP_BOOKS" }
  /** Create a new ledger transaction. For an ambiguous match. */
  | { kind: "IMPORT_AS_NEW" }
  /** Link to the hand-entered transaction the person chose. */
  | { kind: "MATCH_TO"; ledgerTransactionId: string }
  /** Keep it out of the ledger. For an ambiguous match. */
  | { kind: "DO_NOT_IMPORT" };

export type ResolutionDecision =
  | { ok: true; decision: ReconciliationDecision; acknowledged: LedgerFields | null }
  | { ok: false; reason: "NOT_UNDER_REVIEW" | "NOT_APPLICABLE" | "UNSUPPORTED_CURRENCY" | "NOT_A_CANDIDATE" };

export function decideReviewResolution(input: ReconciliationInput, resolution: ReviewResolution): ResolutionDecision {
  const { external, ledger, account } = input;
  if (external.reconciliationState !== "NEEDS_REVIEW") return { ok: false, reason: "NOT_UNDER_REVIEW" };
  const linked = external.ledgerTransactionId !== null && ledger !== null;

  if (resolution.kind === "KEEP_BOOKS") {
    if (!linked) return { ok: false, reason: "NOT_APPLICABLE" };
    const desired = ledgerFieldsFor(external, ledger.accountId);
    return { ok: true, decision: setState(external.ledgerLinkKind === "MATCHED" ? "MATCHED" : "IMPORTED"), acknowledged: desired };
  }

  if (external.reviewReason !== "AMBIGUOUS_MANUAL_MATCH" || linked || account === null) return { ok: false, reason: "NOT_APPLICABLE" };
  const fields = ledgerFieldsFor(external, account.id);
  if (!fields) return { ok: false, reason: "UNSUPPORTED_CURRENCY" };

  switch (resolution.kind) {
    case "DO_NOT_IMPORT":
      return { ok: true, decision: setState("IGNORED"), acknowledged: null };
    case "IMPORT_AS_NEW":
      return { ok: true, decision: { kind: "IMPORT", ledger: fields }, acknowledged: fields };
    case "MATCH_TO": {
      const candidate = (input.candidates ?? []).find((c) => c.id === resolution.ledgerTransactionId);
      if (!candidate || !isMatchCandidate(candidate, fields)) return { ok: false, reason: "NOT_A_CANDIDATE" };
      return { ok: true, decision: { kind: "MATCH", ledgerTransactionId: candidate.id, acknowledged: fields }, acknowledged: fields };
    }
  }
}
