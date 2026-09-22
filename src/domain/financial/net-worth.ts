import { money, type Money } from "@/domain/money/money";
import type { CurrencyCode } from "@/domain/money/currency";

/**
 * Personal net worth from the accounts Countorra holds — assets minus
 * liabilities, calculated here and never by the model.
 *
 * Classification follows what each balance IS, not just the account's label:
 *
 *   credit card, balance owed (negative)   → liability
 *   any other account, positive balance    → asset
 *   any other account, negative balance    → liability (an overdraft is money owed)
 *   credit card in credit (positive)       → asset
 *
 * Archived accounts and accounts in another currency are left out and
 * COUNTED in the result, so a partial figure says it is partial. What
 * Countorra holds no record of — a home, a car, a mortgage or loan that has
 * not been added as an account — cannot be in the figure, and `coverage`
 * says so.
 */

export interface NetWorthAccount {
  id: string;
  name: string;
  kind: string;
  currency: string;
  balanceMinor: number;
  isArchived: boolean;
}

export interface NetWorthLine {
  accountId: string;
  name: string;
  kind: string;
  amount: Money;
}

export interface NetWorthResult {
  netWorth: Money;
  totalAssets: Money;
  totalLiabilities: Money;
  assets: NetWorthLine[];
  liabilities: NetWorthLine[];
  excluded: { archivedAccounts: number; otherCurrencyAccounts: number };
  coverage: string;
}

const COVERAGE =
  "Covers the accounts in Countorra only. Property, vehicles, investments and loans that have not been added as accounts are not included.";

export function calculateNetWorth(accounts: readonly NetWorthAccount[], baseCurrency: CurrencyCode): NetWorthResult {
  const assets: NetWorthLine[] = [];
  const liabilities: NetWorthLine[] = [];
  let archivedAccounts = 0;
  let otherCurrencyAccounts = 0;

  for (const account of accounts) {
    if (account.isArchived) {
      archivedAccounts += 1;
      continue;
    }
    if (account.currency !== baseCurrency) {
      otherCurrencyAccounts += 1;
      continue;
    }
    if (account.balanceMinor >= 0) {
      assets.push({ accountId: account.id, name: account.name, kind: account.kind, amount: money(account.balanceMinor, baseCurrency) });
    } else {
      liabilities.push({ accountId: account.id, name: account.name, kind: account.kind, amount: money(-account.balanceMinor, baseCurrency) });
    }
  }

  const totalAssets = assets.reduce((sum, line) => sum + line.amount.amountMinor, 0);
  const totalLiabilities = liabilities.reduce((sum, line) => sum + line.amount.amountMinor, 0);

  return {
    netWorth: money(totalAssets - totalLiabilities, baseCurrency),
    totalAssets: money(totalAssets, baseCurrency),
    totalLiabilities: money(totalLiabilities, baseCurrency),
    assets,
    liabilities,
    excluded: { archivedAccounts, otherCurrencyAccounts },
    coverage: COVERAGE,
  };
}
