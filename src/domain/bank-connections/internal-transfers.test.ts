import { describe, expect, it } from "vitest";
import { matchInternalTransfer, withinRetroCorrectionWindow, RETRO_CORRECTION_LOOKBACK_DAYS, type TransferSide } from "./internal-transfers";

/**
 * The internal-transfer matcher.
 *
 * Every case is about money being counted once. The failure this guards
 * against is not a crash — it is a $500 movement quietly becoming $500 of
 * income and $500 of spending, or a card payment adding a second expense on
 * top of the purchases it settles.
 *
 * The bias is stated in the module and asserted here: a missed match leaves
 * the figures as they are, a false match rewrites somebody's income. So the
 * "does NOT match" cases outnumber the matching ones, deliberately.
 */

const ORG = "org-1";

const side = (over: Partial<TransferSide> = {}): TransferSide => ({
  id: "ext-debit",
  organizationId: ORG,
  linkedAccountId: "link-checking",
  accountId: "acct-checking",
  accountKind: "bank",
  direction: "DEBIT",
  amountMinor: 50_000,
  currency: "USD",
  transactionDate: "2026-09-10",
  status: "POSTED",
  categoryHint: "TRANSFER_OUT",
  reconciliationState: "UNRECONCILED",
  ledgerTransactionId: null,
  transferCounterpartId: null,
  importable: true,
  ...over,
});

/** The savings leg of a plain bank-to-bank transfer. */
const credit = (over: Partial<TransferSide> = {}): TransferSide =>
  side({
    id: "ext-credit",
    linkedAccountId: "link-savings",
    accountId: "acct-savings",
    accountKind: "bank",
    direction: "CREDIT",
    categoryHint: "TRANSFER_IN",
    ...over,
  });

const reject = (result: ReturnType<typeof matchInternalTransfer>) => (result.kind === "NONE" ? result.reason : `PAIRED:${result.corroboration}`);

describe("a transfer between two of the person's own accounts", () => {
  it("pairs a bank-to-bank transfer into one movement", () => {
    const result = matchInternalTransfer(side(), [credit()]);
    expect(result.kind).toBe("PAIR");
    if (result.kind !== "PAIR") return;
    // The DEBIT leg owns the single ledger row: it is the account the money
    // left, which is what the balance engine debits.
    expect(result.source.id).toBe("ext-debit");
    expect(result.counterpart.id).toBe("ext-credit");
    expect(result.corroboration).toBe("PROVIDER_CATEGORY");
    expect(result.retroCorrection).toBe(false);
  });

  it("pairs the same transfer when the CREDIT leg is reconciled first", () => {
    // Whichever leg the sync reaches first claims the pair. Without this the
    // credit leg would import as income and then need deleting.
    const result = matchInternalTransfer(credit(), [side()]);
    expect(result.kind).toBe("PAIR");
    if (result.kind !== "PAIR") return;
    expect(result.source.id).toBe("ext-debit");
    expect(result.counterpart.id).toBe("ext-credit");
  });

  it("pairs a reverse transfer — savings back to checking", () => {
    const out = side({ id: "ext-out", linkedAccountId: "link-savings", accountId: "acct-savings" });
    const into = credit({ id: "ext-in", linkedAccountId: "link-checking", accountId: "acct-checking" });
    const result = matchInternalTransfer(out, [into]);
    expect(result.kind).toBe("PAIR");
    if (result.kind === "PAIR") expect([result.source.id, result.counterpart.id]).toEqual(["ext-out", "ext-in"]);
  });
});

describe("credit-card payments", () => {
  it("pairs money leaving a bank account and arriving at a card, on structure alone", () => {
    // No provider category at all: the account kinds are the evidence.
    const payment = side({ categoryHint: null });
    const card = credit({ accountId: "acct-card", linkedAccountId: "link-card", accountKind: "credit_card", categoryHint: null });
    const result = matchInternalTransfer(payment, [card]);
    expect(result.kind).toBe("PAIR");
    if (result.kind === "PAIR") expect(result.corroboration).toBe("CARD_PAYMENT");
  });

  it("does not treat a card-to-card movement as a card payment without a category", () => {
    const from = side({ accountKind: "credit_card", categoryHint: null });
    const to = credit({ accountKind: "credit_card", categoryHint: null });
    expect(reject(matchInternalTransfer(from, [to]))).toBe("NO_CORROBORATION");
  });

  it("still pairs a card payment the provider labelled a loan payment", () => {
    const payment = side({ categoryHint: "LOAN_PAYMENTS" });
    const card = credit({ accountKind: "bank", categoryHint: null });
    expect(reject(matchInternalTransfer(payment, [card]))).toBe("PAIRED:PROVIDER_CATEGORY");
  });
});

describe("what must never be matched", () => {
  it("refuses two unrelated transactions that merely share an amount and a date", () => {
    // The false positive that matters most: a $500 purchase and a $500
    // deposit on the same day, with nothing saying either is a transfer.
    const purchase = side({ categoryHint: "FOOD_AND_DRINK" });
    const deposit = credit({ categoryHint: "INCOME" });
    expect(reject(matchInternalTransfer(purchase, [deposit]))).toBe("NO_CORROBORATION");
  });

  it("refuses different amounts", () => {
    expect(reject(matchInternalTransfer(side(), [credit({ amountMinor: 49_900 })]))).toBe("NO_CANDIDATE");
  });

  it("refuses different currencies", () => {
    expect(reject(matchInternalTransfer(side(), [credit({ currency: "EUR" })]))).toBe("NO_CANDIDATE");
  });

  it("refuses a counterpart outside the date window", () => {
    expect(reject(matchInternalTransfer(side(), [credit({ transactionDate: "2026-09-20" })]))).toBe("NO_CANDIDATE");
  });

  it("accepts a counterpart at the edge of the window", () => {
    expect(reject(matchInternalTransfer(side(), [credit({ transactionDate: "2026-09-13" })]))).toBe("PAIRED:PROVIDER_CATEGORY");
  });

  it("refuses the same direction", () => {
    expect(reject(matchInternalTransfer(side(), [credit({ direction: "DEBIT" })]))).toBe("NO_CANDIDATE");
  });

  it("refuses the same account", () => {
    expect(reject(matchInternalTransfer(side(), [credit({ linkedAccountId: "link-checking", accountId: "acct-checking" })]))).toBe("NO_CANDIDATE");
  });

  it("NEVER matches across organizations, even on a perfect candidate", () => {
    // The store scopes its query by organization; this re-checks it, because
    // a matcher that trusts its input is one query bug from a cross-tenant
    // pairing.
    expect(reject(matchInternalTransfer(side(), [credit({ organizationId: "org-2" })]))).toBe("NO_CANDIDATE");
  });

  it("refuses a pending transaction on either side", () => {
    expect(reject(matchInternalTransfer(side({ status: "PENDING" }), [credit()]))).toBe("NOT_POSTED");
    expect(reject(matchInternalTransfer(side(), [credit({ status: "PENDING" })]))).toBe("NO_CANDIDATE");
  });

  it("refuses a side that cannot be imported at all", () => {
    expect(reject(matchInternalTransfer(side({ importable: false }), [credit()]))).toBe("NOT_IMPORTABLE");
    expect(reject(matchInternalTransfer(side({ accountId: null }), [credit()]))).toBe("NOT_IMPORTABLE");
  });

  it("refuses a side with no usable amount", () => {
    expect(reject(matchInternalTransfer(side({ amountMinor: null }), [credit()]))).toBe("NO_AMOUNT");
    expect(reject(matchInternalTransfer(side({ amountMinor: 0 }), [credit()]))).toBe("NO_AMOUNT");
  });
});

describe("ambiguity is left alone, never resolved by guessing", () => {
  it("refuses a three-way match: one debit, two equal credits", () => {
    const a = credit({ id: "ext-credit-a", linkedAccountId: "link-savings", accountId: "acct-savings" });
    const b = credit({ id: "ext-credit-b", linkedAccountId: "link-other", accountId: "acct-other" });
    expect(reject(matchInternalTransfer(side(), [a, b]))).toBe("AMBIGUOUS");
  });

  it("pairs when only one of several candidates is actually viable", () => {
    const viable = credit();
    const wrongAmount = credit({ id: "ext-other", linkedAccountId: "link-other", accountId: "acct-other", amountMinor: 1 });
    expect(reject(matchInternalTransfer(side(), [viable, wrongAmount]))).toBe("PAIRED:PROVIDER_CATEGORY");
  });
});

describe("idempotence and repeated runs", () => {
  it("refuses a side that already belongs to a pair", () => {
    expect(reject(matchInternalTransfer(side({ transferCounterpartId: "ext-credit" }), [credit()]))).toBe("ALREADY_PAIRED");
  });

  it("does not offer an already-paired candidate", () => {
    expect(reject(matchInternalTransfer(side(), [credit({ transferCounterpartId: "ext-something" })]))).toBe("NO_CANDIDATE");
  });

  it("ignores itself in the candidate list", () => {
    expect(reject(matchInternalTransfer(side(), [side()]))).toBe("NO_CANDIDATE");
  });
});

describe("delayed arrival and retro-correction", () => {
  it("marks a pair for retro-correction when the debit leg already imported", () => {
    const imported = side({ ledgerTransactionId: "ledger-1", reconciliationState: "IMPORTED" });
    const result = matchInternalTransfer(imported, [credit()]);
    expect(result.kind).toBe("PAIR");
    if (result.kind === "PAIR") expect(result.retroCorrection).toBe(true);
  });

  it("refuses when the CREDIT leg already produced an income row", () => {
    // Representing the pair as one row would mean deleting that income row,
    // and nothing in this system deletes a financial record on its own. The
    // sync flags it for a person instead.
    const imported = credit({ ledgerTransactionId: "ledger-2", reconciliationState: "IMPORTED" });
    expect(reject(matchInternalTransfer(side(), [imported]))).toBe("COUNTERPART_ALREADY_IMPORTED");
  });

  it("bounds how far back a correction may reach", () => {
    expect(withinRetroCorrectionWindow("2026-09-10", "2026-09-20")).toBe(true);
    expect(withinRetroCorrectionWindow("2026-09-10", `2026-10-10`)).toBe(true);
    expect(withinRetroCorrectionWindow("2026-08-01", "2026-09-20")).toBe(false);
    expect(RETRO_CORRECTION_LOOKBACK_DAYS).toBe(30);
  });
});
