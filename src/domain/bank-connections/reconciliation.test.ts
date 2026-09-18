import { describe, expect, it } from "vitest";
import {
  MATCH_DATE_WINDOW_DAYS,
  decideReconciliation,
  decideReviewResolution,
  ledgerFieldsFor,
  type ExternalForReconciliation,
  type LedgerFields,
  type ManualCandidate,
  type ReconciliationInput,
} from "./reconciliation";

const ACCOUNT = "a0000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT = "a0000000-0000-4000-8000-000000000002";

const external = (overrides: Partial<ExternalForReconciliation> = {}): ExternalForReconciliation => ({
  id: "e1",
  revision: 1,
  status: "POSTED",
  direction: "DEBIT",
  amountMinor: 4_250,
  currency: "USD",
  transactionDate: "2026-09-10",
  merchantName: "Corner Coffee",
  description: "CORNER COFFEE",
  reconciliationState: "UNRECONCILED",
  reviewReason: null,
  reviewResolvedRevision: null,
  ledgerTransactionId: null,
  ledgerLinkKind: null,
  ledgerLinkedAt: null,
  written: null,
  ...overrides,
});

const input = (overrides: Partial<ReconciliationInput> = {}): ReconciliationInput => ({
  external: external(),
  linkedAccount: { importMode: "IMPORT", accountId: ACCOUNT, currency: "USD", detached: false },
  account: { id: ACCOUNT, currency: "USD" },
  ledger: null,
  candidates: [],
  ...overrides,
});

const fields = (overrides: Partial<LedgerFields> = {}): LedgerFields => ({
  accountId: ACCOUNT,
  kind: "expense",
  amountMinor: 4_250,
  currency: "USD",
  occurredOn: "2026-09-10",
  description: "Corner Coffee",
  ...overrides,
});

const manual = (id: string, overrides: Partial<ManualCandidate> = {}): ManualCandidate => ({
  id,
  accountId: ACCOUNT,
  kind: "expense",
  amountMinor: 4_250,
  currency: "USD",
  occurredOn: "2026-09-10",
  source: "manual",
  ...overrides,
});

describe("pending and posted", () => {
  it("never puts a pending transaction in the ledger", () => {
    expect(decideReconciliation(input({ external: external({ status: "PENDING" }) }))).toEqual({ kind: "SET_STATE", state: "PENDING_SETTLEMENT", reviewReason: null });
  });

  it("closes a superseded or cancelled pending transaction without touching the ledger", () => {
    expect(decideReconciliation(input({ external: external({ status: "SUPERSEDED" }) }))).toEqual({ kind: "SET_STATE", state: "NOT_POSTED", reviewReason: null });
    expect(decideReconciliation(input({ external: external({ status: "REMOVED" }) }))).toEqual({ kind: "SET_STATE", state: "NOT_POSTED", reviewReason: null });
  });

  it("imports a posted transaction once loaded candidates show no hand-entered match", () => {
    expect(decideReconciliation(input({ candidates: null }))).toMatchObject({ kind: "NEEDS_CANDIDATES", query: { accountId: ACCOUNT, amountMinor: 4_250, dateFrom: "2026-09-07", dateTo: "2026-09-13" } });
    expect(decideReconciliation(input())).toEqual({ kind: "IMPORT", ledger: fields() });
  });

  it("maps direction to kind", () => {
    expect(ledgerFieldsFor({ ...external(), direction: "CREDIT" }, ACCOUNT)?.kind).toBe("income");
    expect(ledgerFieldsFor({ ...external(), direction: "DEBIT" }, ACCOUNT)?.kind).toBe("expense");
  });

  it("uses the merchant name, falling back to the description", () => {
    expect(ledgerFieldsFor({ ...external(), merchantName: null }, ACCOUNT)?.description).toBe("CORNER COFFEE");
  });
});

describe("accounts and currencies", () => {
  it("waits for a person to link or ignore the account", () => {
    for (const linkedAccount of [
      { importMode: "AWAITING_DECISION" as const, accountId: null, currency: "USD", detached: false },
      { importMode: "IMPORT" as const, accountId: null, currency: "USD", detached: false },
      { importMode: "IMPORT" as const, accountId: ACCOUNT, currency: "USD", detached: true },
    ]) {
      expect(decideReconciliation(input({ linkedAccount }))).toMatchObject({ state: "AWAITING_ACCOUNT_LINK" });
    }
    expect(decideReconciliation(input({ account: null }))).toMatchObject({ state: "AWAITING_ACCOUNT_LINK" });
    expect(decideReconciliation(input({ linkedAccount: { importMode: "IGNORE", accountId: ACCOUNT, currency: "USD", detached: false } }))).toMatchObject({ state: "IGNORED" });
  });

  it("never imports across currencies", () => {
    expect(decideReconciliation(input({ external: external({ currency: "EUR" }) }))).toMatchObject({ state: "CURRENCY_MISMATCH" });
    expect(decideReconciliation(input({ account: { id: ACCOUNT, currency: "GBP" } }))).toMatchObject({ state: "CURRENCY_MISMATCH" });
  });

  it("keeps an unsupported currency out of the ledger", () => {
    expect(decideReconciliation(input({ external: external({ currency: "JPY", amountMinor: null }), account: { id: ACCOUNT, currency: "JPY" } }))).toMatchObject({ state: "UNSUPPORTED_CURRENCY" });
  });
});

describe("matching hand-entered transactions", () => {
  it("links to exactly one candidate and leaves it unchanged", () => {
    expect(decideReconciliation(input({ candidates: [manual("m1", { occurredOn: "2026-09-12" })] }))).toEqual({ kind: "MATCH", ledgerTransactionId: "m1", acknowledged: fields() });
  });

  it("asks a person when more than one candidate fits", () => {
    expect(decideReconciliation(input({ candidates: [manual("m1"), manual("m2")] }))).toEqual({ kind: "SET_STATE", state: "NEEDS_REVIEW", reviewReason: "AMBIGUOUS_MANUAL_MATCH" });
  });

  it("ignores near misses: amount, kind, account, currency, date window and bank rows", () => {
    const misses = [
      manual("amount", { amountMinor: 4_251 }),
      manual("kind", { kind: "income" }),
      manual("account", { accountId: OTHER_ACCOUNT }),
      manual("currency", { currency: "EUR" }),
      manual("date", { occurredOn: "2026-09-14" }),
      manual("bank", { source: "bank_sync" }),
    ];
    expect(decideReconciliation(input({ candidates: misses }))).toEqual({ kind: "IMPORT", ledger: fields() });
    expect(MATCH_DATE_WINDOW_DAYS).toBe(3);
  });

  it("keeps waiting on a person once flagged, instead of importing on the next sync", () => {
    const flagged = external({ reconciliationState: "NEEDS_REVIEW", reviewReason: "AMBIGUOUS_MANUAL_MATCH" });
    expect(decideReconciliation(input({ external: flagged, candidates: [] }))).toEqual({ kind: "SET_STATE", state: "NEEDS_REVIEW", reviewReason: "AMBIGUOUS_MANUAL_MATCH" });
  });
});

describe("changes after import", () => {
  const imported = (overrides: Partial<ExternalForReconciliation> = {}) =>
    external({ reconciliationState: "IMPORTED", ledgerTransactionId: "l1", ledgerLinkKind: "IMPORTED", ledgerLinkedAt: "2026-09-11T00:00:00Z", written: fields(), ...overrides });
  const ledgerRow = (overrides: Partial<LedgerFields> = {}) => ({ id: "l1", source: "bank_sync" as const, ...fields(overrides) });

  it("does nothing when neither side changed", () => {
    expect(decideReconciliation(input({ external: imported(), ledger: ledgerRow() }))).toMatchObject({ state: "IMPORTED" });
  });

  it("follows the bank when the ledger row is untouched", () => {
    expect(decideReconciliation(input({ external: imported({ amountMinor: 4_500, revision: 2 }), ledger: ledgerRow() }))).toEqual({ kind: "UPDATE_LEDGER", ledger: fields({ amountMinor: 4_500 }) });
    expect(decideReconciliation(input({ external: imported({ merchantName: "Corner Coffee Co", revision: 2 }), ledger: ledgerRow() }))).toEqual({ kind: "UPDATE_LEDGER", ledger: fields({ description: "Corner Coffee Co" }) });
    expect(decideReconciliation(input({ external: imported({ transactionDate: "2026-09-09", revision: 2 }), ledger: ledgerRow() }))).toEqual({ kind: "UPDATE_LEDGER", ledger: fields({ occurredOn: "2026-09-09" }) });
  });

  it("keeps a person's edit and flags the bank's change instead of overwriting", () => {
    const decision = decideReconciliation(input({ external: imported({ amountMinor: 4_500, revision: 2 }), ledger: ledgerRow({ description: "Team coffee" }) }));
    expect(decision).toEqual({ kind: "SET_STATE", state: "NEEDS_REVIEW", reviewReason: "PROVIDER_CHANGED_AFTER_EDIT" });
  });

  it("keeps a person's edit when the bank did not change anything", () => {
    expect(decideReconciliation(input({ external: imported(), ledger: ledgerRow({ amountMinor: 1 }) }))).toMatchObject({ state: "IMPORTED" });
  });

  it("flags a removed posted transaction instead of deleting it from the books", () => {
    expect(decideReconciliation(input({ external: imported({ status: "REMOVED", revision: 2 }), ledger: ledgerRow() }))).toEqual({ kind: "SET_STATE", state: "NEEDS_REVIEW", reviewReason: "REMOVED_BY_PROVIDER" });
  });

  it("does not re-import a transaction a person deleted from the ledger", () => {
    expect(decideReconciliation(input({ external: imported({ ledgerTransactionId: null }), ledger: null }))).toMatchObject({ state: "REMOVED_FROM_BOOKS" });
    expect(decideReconciliation(input({ external: imported({ ledgerTransactionId: null, amountMinor: 9_999, revision: 3 }), ledger: null }))).toMatchObject({ state: "REMOVED_FROM_BOOKS" });
  });

  it("never modifies a matched hand-entered transaction", () => {
    const matched = external({ reconciliationState: "MATCHED", ledgerTransactionId: "m1", ledgerLinkKind: "MATCHED", ledgerLinkedAt: "2026-09-11T00:00:00Z", written: fields() });
    const row = { id: "m1", source: "manual" as const, ...fields({ description: "Coffee with Sam" }) };
    expect(decideReconciliation(input({ external: { ...matched, merchantName: "Renamed", revision: 2 }, ledger: row }))).toMatchObject({ kind: "SET_STATE", state: "MATCHED" });
    expect(decideReconciliation(input({ external: { ...matched, amountMinor: 5_000, revision: 2 }, ledger: row }))).toEqual({ kind: "SET_STATE", state: "NEEDS_REVIEW", reviewReason: "PROVIDER_CHANGED_MATCHED" });
  });

  it("respects a resolved review until the bank reports something new", () => {
    const resolved = imported({ reconciliationState: "IMPORTED", amountMinor: 4_500, revision: 2, reviewResolvedRevision: 2 });
    expect(decideReconciliation(input({ external: resolved, ledger: ledgerRow({ description: "Team coffee" }) }))).toMatchObject({ state: "IMPORTED" });
  });
});

describe("resolving a review", () => {
  it("keeps the books and acknowledges the bank's values", () => {
    const flagged = external({ reconciliationState: "NEEDS_REVIEW", reviewReason: "PROVIDER_CHANGED_AFTER_EDIT", ledgerTransactionId: "l1", ledgerLinkKind: "IMPORTED", ledgerLinkedAt: "x", amountMinor: 4_500, written: fields() });
    const result = decideReviewResolution(input({ external: flagged, ledger: { id: "l1", source: "bank_sync", ...fields({ description: "Team coffee" }) } }), { kind: "KEEP_BOOKS" });
    expect(result).toEqual({ ok: true, decision: { kind: "SET_STATE", state: "IMPORTED", reviewReason: null }, acknowledged: fields({ amountMinor: 4_500 }) });
  });

  it("imports as new, matches a real candidate, or leaves out an ambiguous match", () => {
    const ambiguous = input({ external: external({ reconciliationState: "NEEDS_REVIEW", reviewReason: "AMBIGUOUS_MANUAL_MATCH" }), candidates: [manual("m1"), manual("m2")] });
    expect(decideReviewResolution(ambiguous, { kind: "IMPORT_AS_NEW" })).toMatchObject({ ok: true, decision: { kind: "IMPORT" } });
    expect(decideReviewResolution(ambiguous, { kind: "MATCH_TO", ledgerTransactionId: "m2" })).toMatchObject({ ok: true, decision: { kind: "MATCH", ledgerTransactionId: "m2" } });
    expect(decideReviewResolution(ambiguous, { kind: "MATCH_TO", ledgerTransactionId: "not-a-candidate" })).toEqual({ ok: false, reason: "NOT_A_CANDIDATE" });
    expect(decideReviewResolution(ambiguous, { kind: "DO_NOT_IMPORT" })).toMatchObject({ ok: true, decision: { state: "IGNORED" } });
  });

  it("refuses to resolve something that is not under review", () => {
    expect(decideReviewResolution(input(), { kind: "KEEP_BOOKS" })).toEqual({ ok: false, reason: "NOT_UNDER_REVIEW" });
  });
});

describe("performance", () => {
  it("decides 5,000 transactions against candidate lists quickly", () => {
    const candidates = Array.from({ length: 50 }, (_, i) => manual(`m${i}`, { amountMinor: 10_000 + i }));
    const started = performance.now();
    let imports = 0;
    let matches = 0;
    for (let i = 0; i < 5000; i++) {
      const decision = decideReconciliation(input({ external: external({ id: `e${i}`, amountMinor: 10_000 + (i % 100) }), candidates }));
      if (decision.kind === "IMPORT") imports++;
      if (decision.kind === "MATCH") matches++;
    }
    expect(matches).toBe(2500);
    expect(imports).toBe(2500);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
