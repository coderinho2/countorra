import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import { createAdminClient } from "@/server/supabase/admin";
import { listRecentTransactionsForAnalysis } from "@/server/db/repositories/transactions";
import { listMerchants } from "@/server/db/repositories/merchants";
import { listInvoices } from "@/server/db/repositories/invoices";
import { detectRecurringPatterns, type TransactionForRecurrence } from "@/domain/insights/recurring-detection";
import { detectAnomalies, type TransactionForAnomalyDetection } from "@/domain/insights/anomaly-detection";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";
import { format, money } from "@/domain/money/money";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/domain/audit/audit-log";
import { createNotifications } from "@/server/db/repositories/notifications";

type Client = SupabaseClient<Database>;

/**
 * The "proactive AI" foundation (product spec §46): runs the deterministic
 * detectors (src/domain/insights/*) against an organization's real data
 * and persists the results as `ai_insights` + `notifications` rows.
 *
 * This is triggered on-demand (a Server Action the dashboard calls when
 * insights look stale) rather than by a real background cron — there is
 * no job scheduler in this environment. That's an honest architectural
 * boundary, not a simulation: every insight produced is computed from the
 * organization's actual data at call time, nothing is fabricated. A
 * future phase can call this same function from a real cron/queue trigger
 * without changing anything in here.
 *
 * Writes go through the ADMIN client (bypasses RLS) because there is no
 * INSERT policy for `authenticated` on `ai_insights`/`notifications` (see
 * supabase/migrations/0011, 0015) — by design, so a client can never write
 * its own "AI insight". `client` (the caller's authenticated session) is
 * still used for every READ, so this only ever sees what RLS already
 * allows the calling user to see.
 */
export async function generateInsights(client: Client, organizationId: string): Promise<{ insightsCreated: number; notificationsCreated: number }> {
  const admin = createAdminClient();

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
  const from = sixMonthsAgo.toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const [transactions, merchants, { invoices }] = await Promise.all([
    // `listTransactions` clamps pageSize to 200, so asking for 2000 quietly
    // analysed a tenth of the window the comment claimed. Six months of
    // recurring-pattern and anomaly detection ran on the most recent 200 rows.
    // Paged to exhaustion instead, with a hard ceiling so a large workspace
    // cannot turn insight generation into an unbounded read.
    listRecentTransactionsForAnalysis(client, organizationId, from, today),
    listMerchants(client, organizationId),
    listInvoices(client, { organizationId, overdueOnly: true, page: 1, pageSize: 100 }),
  ]);

  const merchantNameById = new Map(merchants.map((m) => [m.id, m.name]));
  const supportedTransactions = transactions.filter((t) => isSupportedCurrency(t.currency));
  const currency = (supportedTransactions[0]?.currency ?? "EUR") as CurrencyCode;

  const forRecurrence: TransactionForRecurrence[] = supportedTransactions.map((t) => ({
    merchantId: t.merchantId,
    merchantName: t.merchantId ? (merchantNameById.get(t.merchantId) ?? "Unknown merchant") : "Unknown merchant",
    categoryId: t.categoryId,
    amountMinor: t.amountMinor,
    currency: t.currency as CurrencyCode,
    occurredOn: t.occurredOn,
  }));
  const recurringPatterns = detectRecurringPatterns(forRecurrence);

  const forAnomalies: TransactionForAnomalyDetection[] = supportedTransactions.map((t) => ({
    id: t.id,
    merchantId: t.merchantId,
    merchantName: t.merchantId ? (merchantNameById.get(t.merchantId) ?? "Unknown merchant") : "Unknown merchant",
    categoryId: t.categoryId,
    amountMinor: t.amountMinor,
    currency: t.currency as CurrencyCode,
    occurredOn: t.occurredOn,
    kind: t.kind,
  }));

  // Category baselines: average monthly spend per category over the
  // 6-month window, used to judge whether the most recent 30 days spiked.
  const oneMonthAgo = new Date();
  oneMonthAgo.setUTCDate(oneMonthAgo.getUTCDate() - 30);
  const recentCutoff = oneMonthAgo.toISOString().slice(0, 10);
  const currentPeriod = forAnomalies.filter((t) => t.occurredOn >= recentCutoff);
  const priorPeriod = forAnomalies.filter((t) => t.occurredOn < recentCutoff && t.kind === "expense");

  const priorTotalsByCategory = new Map<string, number>();
  for (const t of priorPeriod) {
    if (!t.categoryId) continue;
    priorTotalsByCategory.set(t.categoryId, (priorTotalsByCategory.get(t.categoryId) ?? 0) + t.amountMinor);
  }
  const monthsInPriorWindow = 5; // 6-month window minus the most recent 30 days
  const categoryBaselines = new Map(
    [...priorTotalsByCategory.entries()].map(([categoryId, total]) => [categoryId, money(Math.round(total / monthsInPriorWindow), currency)]),
  );

  const knownMerchantIds = new Set(priorPeriod.map((t) => t.merchantId).filter((id): id is string => id !== null));

  const anomalies = detectAnomalies({
    transactions: currentPeriod,
    knownMerchantIds,
    categoryBaselines,
    recurringPatterns,
  });

  const insightRows: Array<{ kind: string; title: string; body: string; data: Record<string, Json | undefined> }> = [];

  for (const anomaly of anomalies.slice(0, 10)) {
    insightRows.push({
      kind: `anomaly.${anomaly.type}`,
      title: anomaly.title,
      body: anomaly.description,
      data: { confidence: anomaly.confidence, transactionId: anomaly.transactionId, amountMinor: anomaly.amount?.amountMinor },
    });
  }

  for (const pattern of recurringPatterns.filter((p) => p.amountChangeMinor > 0).slice(0, 5)) {
    insightRows.push({
      kind: "recurring.price_increase",
      title: `${pattern.merchantName} increased`,
      body: `Now ${format(pattern.lastAmount)} per ${pattern.interval.replace("ly", "")}, up from ${format(
        money(pattern.lastAmount.amountMinor - pattern.amountChangeMinor, currency),
      )}.`,
      data: { merchantId: pattern.merchantId, confidence: pattern.confidence },
    });
  }

  for (const invoice of invoices) {
    insightRows.push({
      kind: "invoice.overdue",
      title: `Invoice ${invoice.invoiceNumber} is overdue`,
      body: `${format(money(invoice.totalMinor, invoice.currency as CurrencyCode))} was due ${invoice.dueDate}.`,
      data: { invoiceId: invoice.id },
    });
  }

  if (insightRows.length > 0) {
    const { error } = await admin.from("ai_insights").insert(
      insightRows.map((row) => ({
        organization_id: organizationId,
        kind: row.kind,
        title: row.title,
        body: row.body,
        data: row.data,
      })),
    );
    if (error) throw error;
  }

  await createNotifications(
    admin,
    organizationId,
    [
      ...anomalies.slice(0, 5).map((a) => ({
        kind: "unusual_transaction" as const,
        title: a.title,
        body: a.description,
        resourceType: a.transactionId ? "transaction" : undefined,
        resourceId: a.transactionId,
      })),
      ...invoices.map((invoice) => ({
        kind: "overdue_invoice" as const,
        title: `Invoice ${invoice.invoiceNumber} is overdue`,
        body: `${format(money(invoice.totalMinor, invoice.currency as CurrencyCode))} was due ${invoice.dueDate}.`,
        resourceType: "invoice",
        resourceId: invoice.id,
      })),
    ],
  );

  await recordAuditEvent(client, {
    organizationId,
    action: AUDIT_ACTIONS.aiActionExecuted,
    resourceType: "insights_generation",
    metadata: { insightsCreated: insightRows.length, anomaliesFound: anomalies.length, recurringPatternsFound: recurringPatterns.length },
  });

  return { insightsCreated: insightRows.length, notificationsCreated: anomalies.length + invoices.length };
}
