import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { listAccounts, listAccountBalances } from "@/server/db/repositories/accounts";
import { listTransactions, getTransactionTotals, getCategoryTotals } from "@/server/db/repositories/transactions";
import { listInvoices } from "@/server/db/repositories/invoices";
import { listInsights } from "@/server/db/repositories/insights";
import { listMerchants } from "@/server/db/repositories/merchants";
import { listCategories } from "@/server/db/repositories/categories";
import type { Organization } from "@/domain/organizations/types";
import { comparePeriodTotals, spendByCategoryFromTotals, summarizeTotals } from "@/domain/financial/calculation-engine";
import { calculateFinancialHealth, type FinancialHealthResult } from "@/domain/insights/financial-health";
import { detectRecurringPatterns } from "@/domain/insights/recurring-detection";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";
import type { Money } from "@/domain/money/money";
import { totalInBaseCurrency, type ExcludedCurrency } from "@/domain/money/aggregate";

type Client = SupabaseClient<Database>;

function isoMonthsAgo(months: number, from = new Date()): string {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}
function startOfMonth(offset: number, from = new Date()): string {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
}
function endOfMonth(offset: number, from = new Date()): string {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + offset + 1, 0)).toISOString().slice(0, 10);
}

export interface MonthlyTotal {
  label: string;
  income: Money;
  expense: Money;
}

export interface DashboardData {
  organization: Organization;
  currency: CurrencyCode;
  totalBalance: Money;
  accountCount: number;
  /** Accounts and transactions held in a currency other than the base one.
   *  Never converted into `totalBalance` (FIN-03) — reported so the figure's
   *  scope is visible instead of implied. */
  excludedCurrencies: ExcludedCurrency[];
  thisMonth: { income: Money; expense: Money; profit: Money };
  comparisonVsLastMonth: { incomePercentChange: number | null; expensePercentChange: number | null };
  monthlyTotals: MonthlyTotal[];
  topCategories: { categoryId: string | null; categoryName: string; total: Money }[];
  recentTransactions: Awaited<ReturnType<typeof listTransactions>>["transactions"];
  overdueInvoices: Awaited<ReturnType<typeof listInvoices>>["invoices"];
  insights: Awaited<ReturnType<typeof listInsights>>;
  financialHealth: FinancialHealthResult;
}

export async function getDashboardData(client: Client, organization: Organization): Promise<DashboardData> {
  const currency: CurrencyCode = isSupportedCurrency(organization.baseCurrency) ? organization.baseCurrency : "EUR";
  const today = new Date().toISOString().slice(0, 10);

  const [accounts, categories, merchants, recentTransactionsPage, overdue, insights] = await Promise.all([
    listAccounts(client, organization.id),
    listCategories(client, organization.id),
    listMerchants(client, organization.id),
    listTransactions(client, { organizationId: organization.id, page: 1, pageSize: 8 }),
    listInvoices(client, { organizationId: organization.id, overdueOnly: true, pageSize: 20 }),
    listInsights(client, organization.id),
  ]);

  // One aggregate call for every account, replacing two unbounded selects per
  // account. Foreign-currency accounts are excluded from the total rather than
  // added at 1:1 — the rule the accounts page already applied (FIN-03).
  const balances = await listAccountBalances(client, organization.id);
  const balanceTotal = totalInBaseCurrency(
    balances
      .filter((b) => isSupportedCurrency(b.currency))
      .map((b) => ({ amountMinor: b.balanceMinor, currency: b.currency as CurrencyCode })),
    currency,
  );
  const totalBalance = balanceTotal.total;

  // Every period figure below is a SQL aggregate over the whole period, not a
  // sum of the first 1000 rows PostgREST was willing to return (FIN-01). They
  // are one row each, so all eight run in parallel cheaply — the six-month
  // chart used to be six sequential unbounded reads.
  const monthWindows = [5, 4, 3, 2, 1, 0].map((i) => ({ from: startOfMonth(-i), to: endOfMonth(-i) }));

  const [thisMonthTotals, lastMonthTotals, threeMonthTotals, categoryTotals, ...monthlyTotalRows] = await Promise.all([
    getTransactionTotals(client, { organizationId: organization.id, dateFrom: startOfMonth(0), dateTo: today }),
    getTransactionTotals(client, { organizationId: organization.id, dateFrom: startOfMonth(-1), dateTo: endOfMonth(-1) }),
    getTransactionTotals(client, { organizationId: organization.id, dateFrom: isoMonthsAgo(3), dateTo: today }),
    getCategoryTotals(client, { organizationId: organization.id, from: startOfMonth(0), to: today }),
    ...monthWindows.map((w) => getTransactionTotals(client, { organizationId: organization.id, dateFrom: w.from, dateTo: w.to })),
  ]);

  const thisMonth = summarizeTotals(thisMonthTotals, currency);
  const threeMonth = summarizeTotals(threeMonthTotals, currency);
  const comparison = comparePeriodTotals(thisMonthTotals, lastMonthTotals, currency);

  const monthlyTotals: MonthlyTotal[] = monthWindows.map((window, index) => {
    const summary = summarizeTotals(monthlyTotalRows[index], currency);
    return {
      label: new Date(window.from).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
      income: summary.income,
      expense: summary.expense,
    };
  });

  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const topCategories = spendByCategoryFromTotals(categoryTotals, currency)
    .slice(0, 5)
    .map((c) => ({ categoryId: c.categoryId, categoryName: c.categoryId ? (categoryNameById.get(c.categoryId) ?? "Uncategorized") : "Uncategorized", total: c.total }));

  // Financial health inputs
  const avgMonthlyExpense = Math.round(threeMonth.expense.amountMinor / 3);
  const avgMonthlyIncome = Math.round(threeMonth.income.amountMinor / 3);

  const sixMonthDetailed = await listTransactions(client, { organizationId: organization.id, dateFrom: isoMonthsAgo(6), dateTo: today, pageSize: 1000 });
  const nameById = new Map(merchants.map((m) => [m.id, m.name]));
  const forRecurrence = sixMonthDetailed.transactions
    .filter((t) => isSupportedCurrency(t.currency))
    .map((t) => ({ merchantId: t.merchantId, merchantName: t.merchantId ? (nameById.get(t.merchantId) ?? "Unknown") : "Unknown", categoryId: t.categoryId, amountMinor: t.amountMinor, currency: t.currency as CurrencyCode, occurredOn: t.occurredOn }));
  const recurringPatterns = detectRecurringPatterns(forRecurrence);
  const recurringAnnualCost = totalInBaseCurrency(
    recurringPatterns.map((p) => ({ amountMinor: p.annualizedCost.amountMinor, currency: p.annualizedCost.currency })),
    currency,
  ).total.amountMinor;

  const { invoices: allInvoices } = await listInvoices(client, { organizationId: organization.id, pageSize: 200 });
  const outstandingInvoices = allInvoices.filter((i) => i.status === "sent" || i.status === "overdue");
  // Invoices carry their own currency; stamping the base currency on each one
  // and adding them was the same fabrication as the balance total (FIN-03).
  const receivableAmounts = (invoices: typeof allInvoices) =>
    invoices
      .filter((i) => isSupportedCurrency(i.currency))
      .map((i) => ({ amountMinor: i.totalMinor, currency: i.currency as CurrencyCode }));
  const totalReceivables = totalInBaseCurrency(receivableAmounts(outstandingInvoices), currency).total.amountMinor;
  const overdueTotal = totalInBaseCurrency(receivableAmounts(overdue.invoices), currency);
  const overdueReceivables = overdueTotal.total.amountMinor;

  const financialHealth = calculateFinancialHealth({
    currency,
    cashBalanceMinor: totalBalance.amountMinor,
    averageMonthlyExpenseMinor: avgMonthlyExpense,
    averageMonthlyIncomeMinor: avgMonthlyIncome,
    monthlyExpenseTotalsMinor: monthlyTotals.map((m) => m.expense.amountMinor),
    recurringAnnualCostMinor: recurringAnnualCost,
    overdueReceivablesMinor: overdueReceivables,
    totalReceivablesMinor: totalReceivables,
  });

  return {
    organization,
    currency,
    totalBalance,
    accountCount: accounts.length,
    excludedCurrencies: mergeExclusions(balanceTotal.excluded, thisMonth.excluded, overdueTotal.excluded),
    thisMonth: { income: thisMonth.income, expense: thisMonth.expense, profit: thisMonth.profit },
    comparisonVsLastMonth: { incomePercentChange: comparison.incomePercentChange, expensePercentChange: comparison.expensePercentChange },
    monthlyTotals,
    topCategories,
    recentTransactions: recentTransactionsPage.transactions,
    overdueInvoices: overdue.invoices,
    insights: insights.slice(0, 4),
    financialHealth,
  };
}

/** One de-duplicated list of what the dashboard's figures left out, so the UI
 *  states the scope once rather than three times. */
function mergeExclusions(...lists: ExcludedCurrency[][]): ExcludedCurrency[] {
  const counts = new Map<CurrencyCode, number>();
  for (const list of lists) {
    for (const entry of list) counts.set(entry.currency, (counts.get(entry.currency) ?? 0) + entry.count);
  }
  return [...counts.entries()]
    .map(([currency, count]) => ({ currency, count }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
