/**
 * Plaid-first ledger: what a person may still enter by hand.
 *
 * Bank, credit card and other accounts — and every transaction in them — come
 * from a bank connection (Plaid → institution → account → transactions). A
 * person can add only cash and wallet accounts, and enter transactions by hand
 * only into those, and only while no bank connection imports into them.
 *
 * The database enforces exactly this for browser sessions
 * (supabase/migrations/0053_plaid_first_ledger_and_operations.sql); this
 * module is the same rule for the application, so a refusal arrives as a clear
 * sentence rather than as a database error, and the UI only offers what will
 * be accepted. Existing accounts and transactions of every kind are untouched.
 */

/** Account kinds a person may create by hand. */
export const MANUAL_ACCOUNT_KINDS = ["cash", "wallet"] as const;
export type ManualAccountKind = (typeof MANUAL_ACCOUNT_KINDS)[number];

export const MANUAL_ACCOUNT_REFUSAL = "Bank and credit card accounts come from connecting your bank. You can add cash and wallet accounts by hand.";
export const MANUAL_ENTRY_REFUSAL =
  "Transactions for bank and credit card accounts come from your bank connection. You can enter cash and wallet transactions by hand.";

export function isManualAccountKind(kind: string): kind is ManualAccountKind {
  return (MANUAL_ACCOUNT_KINDS as readonly string[]).includes(kind);
}

/**
 * Whether a person may enter a transaction by hand into this account.
 * `connectedAccountIds` are the accounts an active bank link imports into.
 */
export function acceptsManualEntry(account: { id: string; kind: string }, connectedAccountIds: ReadonlySet<string>): boolean {
  return isManualAccountKind(account.kind) && !connectedAccountIds.has(account.id);
}
