import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { listTransactions } from "@/server/db/repositories/transactions";
import { listMerchants } from "@/server/db/repositories/merchants";
import { detectRecurringPatterns, type RecurringPattern } from "@/domain/insights/recurring-detection";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";

type Client = SupabaseClient<Database>;

function monthsAgoISO(months: number, from = new Date()): string {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/**
 * The one place transaction history is fetched and fed through
 * src/domain/insights/recurring-detection — used by the AI tool registry
 * (getRecurringExpenses/getSubscriptions/forecastCashFlow/detectAnomalies),
 * the dashboard, and the insights page, so all three agree on what
 * "recurring" means without re-implementing the fetch each time.
 */
export async function getRecurringPatterns(client: Client, organizationId: string, monthsOfHistory = 12): Promise<RecurringPattern[]> {
  const merchants = await listMerchants(client, organizationId);
  const nameById = new Map(merchants.map((m) => [m.id, m.name]));
  const detailed = await listTransactions(client, {
    organizationId,
    dateFrom: monthsAgoISO(monthsOfHistory),
    dateTo: new Date().toISOString().slice(0, 10),
    pageSize: 1000,
  });
  const forRecurrence = detailed.transactions
    .filter((t) => isSupportedCurrency(t.currency))
    .map((t) => ({
      merchantId: t.merchantId,
      merchantName: t.merchantId ? (nameById.get(t.merchantId) ?? "Unknown") : "Unknown",
      categoryId: t.categoryId,
      amountMinor: t.amountMinor,
      currency: t.currency as CurrencyCode,
      occurredOn: t.occurredOn,
    }));
  return detectRecurringPatterns(forRecurrence);
}
