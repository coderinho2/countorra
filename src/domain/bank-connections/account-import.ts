import type { ExternalAccountType } from "./types";

/**
 * Which Plaid accounts become Countorra accounts, and as what.
 *
 * The authority is the database function `bank_import_account_kind`
 * (supabase/migrations/0054_plaid_account_import.sql), which the sync uses to
 * create accounts automatically. This is its mirror for the application — the
 * Bank connections page explains an unsupported account with it, and the
 * manual link flow refuses one with it. tests/rls/plaid-account-import.test.ts
 * asserts the two agree for every type and subtype listed here.
 *
 * Only what is certain is mapped. A loan, an investment account, a money
 * market account, a CD, an HSA or a subtype Plaid did not report is NOT
 * guessed into the nearest kind: it stays visible, unimported, with the
 * reason.
 */
export type ImportedAccountKind = "bank" | "credit_card";

export function importedAccountKind(type: ExternalAccountType, subtype: string | null): ImportedAccountKind | null {
  if (type === "DEPOSITORY" && (subtype === "checking" || subtype === "savings")) return "bank";
  // Subtypes are stored normalized (src/domain/bank-connections/normalization.ts):
  // Plaid's "credit card" arrives as "credit_card".
  if (type === "CREDIT" && subtype === "credit_card") return "credit_card";
  return null;
}

/** Why an account the bank reported is not imported — shown beside it. */
export function unsupportedAccountReason(type: ExternalAccountType, subtype: string | null): string | null {
  if (importedAccountKind(type, subtype)) return null;
  if (type === "LOAN") return "Loans aren't supported yet, so this account isn't imported.";
  if (type === "INVESTMENT") return "Investment accounts aren't supported yet, so this account isn't imported.";
  if (type === "DEPOSITORY") return "Only checking and savings accounts are imported for now.";
  if (type === "CREDIT") return "Only credit cards are imported for now.";
  return "This kind of account isn't supported yet, so it isn't imported.";
}
