import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { CategoryTotalRow, TransactionTotalRow } from "@/domain/financial/calculation-engine";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";

/**
 * Escapes LIKE wildcards so a user's search string is matched literally.
 *
 * Exported and shared rather than inlined, because two queries now depend on
 * producing the *same* pattern: the paginated list and the totals aggregate
 * that gets displayed beside it (FIN-02). If those two escaped differently,
 * the page would show a total for one set of rows and list another — the exact
 * class of disagreement that fix exists to remove.
 *
 * Backslash itself is deliberately not escaped, preserving the behaviour
 * 0019_transaction_search_text.sql shipped and tests/rls/transaction-search
 * covers.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[%_]/g, (c) => `\\${c}`);
}

type Client = SupabaseClient<Database>;
type TransactionRow = Database["public"]["Tables"]["transactions"]["Row"];

export interface Transaction {
  id: string;
  organizationId: string;
  accountId: string;
  categoryId: string | null;
  merchantId: string | null;
  kind: TransactionRow["kind"];
  amountMinor: number;
  currency: string;
  occurredOn: string;
  description: string | null;
  memo: string | null;
  isReconciled: boolean;
  isReviewed: boolean;
  source: TransactionRow["source"];
  categorizedBy: TransactionRow["categorized_by"];
  categoryConfidence: number | null;
  transferAccountId: string | null;
  createdAt: string;
}

function toTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    organizationId: row.organization_id,
    accountId: row.account_id,
    categoryId: row.category_id,
    merchantId: row.merchant_id,
    kind: row.kind,
    amountMinor: row.amount_minor,
    currency: row.currency,
    occurredOn: row.occurred_on,
    description: row.description,
    memo: row.memo,
    isReconciled: row.is_reconciled,
    isReviewed: row.is_reviewed,
    source: row.source,
    categorizedBy: row.categorized_by,
    categoryConfidence: row.category_confidence,
    transferAccountId: row.transfer_account_id,
    createdAt: row.created_at,
  };
}

/**
 * Authoritative money totals for a filtered set of transactions (FIN-01).
 *
 * This replaces the old `listTransactionsForPeriod`, which selected every
 * matching row through PostgREST and summed them in Node. PostgREST caps a
 * response at `max_rows` (1000) and truncates SILENTLY — no error, no flag —
 * so past a thousand transactions the P&L, the dashboard, the cash-flow chart,
 * spend by category, period comparison, forecasting and every AI answer built
 * on them were all quietly computing over a partial set.
 *
 * The summation now happens in `transaction_totals`
 * (supabase/migrations/0027_financial_aggregates.sql). It returns one row per
 * (currency, kind), so the row cap can never apply no matter how large the
 * period is, and Postgres sums `bigint` exactly — the same integer-minor-unit
 * discipline src/domain/money enforces one layer up.
 *
 * Grouping by currency rather than collapsing to one number is deliberate:
 * deciding what to do about an organization holding several currencies is a
 * product rule, and it lives in src/domain/money/aggregate.ts so the UI and
 * the AI cannot answer it differently (FIN-03).
 *
 * `security invoker`, so RLS scopes this exactly as it scoped the select it
 * replaced. `organizationId` narrows the scan; it does not authorize it.
 */
export type TransactionTotalsFilters = Omit<TransactionFilters, "page" | "pageSize">;

export async function getTransactionTotals(client: Client, filters: TransactionTotalsFilters): Promise<TransactionTotalRow[]> {
  const { data, error } = await client.rpc("transaction_totals", {
    p_organization_id: filters.organizationId,
    p_kind: filters.kind ?? null,
    p_account_id: filters.accountId ?? null,
    p_category_id: filters.categoryId ?? null,
    p_merchant_id: filters.merchantId ?? null,
    p_date_from: filters.dateFrom ?? null,
    p_date_to: filters.dateTo ?? null,
    p_amount_min_minor: filters.amountMinMinor ?? null,
    p_amount_max_minor: filters.amountMaxMinor ?? null,
    p_is_reviewed: filters.isReviewed ?? null,
    p_categorized_by: filters.categorizedBy ?? null,
    // Same escaping as the list query above, from the same function, so the
    // totals always describe exactly the rows the list shows.
    p_search: filters.search ? escapeLikePattern(filters.search) : null,
  });
  if (error) throw error;

  return (data ?? [])
    // A row in a currency this build doesn't know how to format is dropped
    // rather than coerced. It cannot be silently folded into another
    // currency's total, and throwing would take down a whole page over one
    // bad row; src/domain/money/aggregate.ts reports what was left out.
    .filter((row) => isSupportedCurrency(row.currency))
    .map((row) => ({
      currency: row.currency as CurrencyCode,
      kind: row.kind,
      totalMinor: Number(row.total_minor),
      transactionCount: Number(row.transaction_count),
      unreviewedCount: Number(row.unreviewed_count),
    }));
}

/** Spend by category over a period, aggregated in SQL for the same reason as
 *  `getTransactionTotals`. Expenses only; the null category is a real bucket
 *  (uncategorised spend) and is preserved. */
export async function getCategoryTotals(
  client: Client,
  params: { organizationId: string; from?: string; to?: string },
): Promise<CategoryTotalRow[]> {
  const { data, error } = await client.rpc("transaction_category_totals", {
    p_organization_id: params.organizationId,
    p_date_from: params.from ?? null,
    p_date_to: params.to ?? null,
  });
  if (error) throw error;

  return (data ?? [])
    .filter((row) => isSupportedCurrency(row.currency))
    .map((row) => ({
      categoryId: row.category_id,
      currency: row.currency as CurrencyCode,
      totalMinor: Number(row.total_minor),
    }));
}

export interface TransactionFilters {
  organizationId: string;
  kind?: "income" | "expense" | "transfer";
  accountId?: string;
  categoryId?: string;
  merchantId?: string;
  dateFrom?: string;
  dateTo?: string;
  amountMinMinor?: number;
  amountMaxMinor?: number;
  isReviewed?: boolean;
  categorizedBy?: TransactionRow["categorized_by"];
  /** Matches against description/memo. Uses `ilike`, never string-built
   *  SQL — see src/domain/search for why that matters. */
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface TransactionPage {
  transactions: Transaction[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listTransactions(client: Client, filters: TransactionFilters): Promise<TransactionPage> {
  const page = filters.page ?? 1;
  const pageSize = Math.min(filters.pageSize ?? 50, 200);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = client
    .from("transactions")
    .select("*", { count: "exact" })
    .eq("organization_id", filters.organizationId);

  if (filters.kind) query = query.eq("kind", filters.kind);
  if (filters.accountId) query = query.eq("account_id", filters.accountId);
  if (filters.categoryId) query = query.eq("category_id", filters.categoryId);
  if (filters.merchantId) query = query.eq("merchant_id", filters.merchantId);
  if (filters.dateFrom) query = query.gte("occurred_on", filters.dateFrom);
  if (filters.dateTo) query = query.lte("occurred_on", filters.dateTo);
  if (filters.amountMinMinor !== undefined) query = query.gte("amount_minor", filters.amountMinMinor);
  if (filters.amountMaxMinor !== undefined) query = query.lte("amount_minor", filters.amountMaxMinor);
  if (filters.isReviewed !== undefined) query = query.eq("is_reviewed", filters.isReviewed);
  if (filters.categorizedBy) query = query.eq("categorized_by", filters.categorizedBy);
  if (filters.search) {
    // A single safe .ilike() against the generated `search_text` column
    // (description || ' ' || memo) — not `.or()`. `.or()`'s filter value
    // is parsed by PostgREST's own mini-DSL (`,` `.` `(` `)` `"` are
    // syntax there), which is a second, easy-to-get-wrong escaping layer
    // on top of SQL's `%`/`_` wildcard escaping; see
    // 0019_transaction_search_text.sql for the full reasoning.
    query = query.ilike("search_text", `%${escapeLikePattern(filters.search)}%`);
  }

  const { data, error, count } = await query.order("occurred_on", { ascending: false }).range(from, to);
  if (error) throw error;

  return { transactions: data.map(toTransaction), total: count ?? 0, page, pageSize };
}

/** Scoped by organization as well as id: an id alone is a bearer token for
 *  a row, and "the caller asked about an object in another tenant" should
 *  be a miss here, not something only RLS notices. */
export async function getTransaction(client: Client, transactionId: string, organizationId: string): Promise<Transaction | null> {
  const { data, error } = await client
    .from("transactions")
    .select("*")
    .eq("id", transactionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return data ? toTransaction(data) : null;
}

export interface CreateTransactionInput {
  organizationId: string;
  accountId: string;
  categoryId?: string | null;
  merchantId?: string | null;
  kind: TransactionRow["kind"];
  amountMinor: number;
  currency: string;
  occurredOn: string;
  description?: string | null;
  memo?: string | null;
  transferAccountId?: string | null;
  source?: TransactionRow["source"];
  createdBy: string;
}

export async function createTransaction(client: Client, input: CreateTransactionInput): Promise<Transaction> {
  const { data, error } = await client
    .from("transactions")
    .insert({
      organization_id: input.organizationId,
      account_id: input.accountId,
      category_id: input.categoryId ?? null,
      merchant_id: input.merchantId ?? null,
      kind: input.kind,
      amount_minor: input.amountMinor,
      currency: input.currency,
      occurred_on: input.occurredOn,
      description: input.description ?? null,
      memo: input.memo ?? null,
      transfer_account_id: input.transferAccountId ?? null,
      source: input.source ?? "manual",
      created_by: input.createdBy,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toTransaction(data);
}

export async function categorizeTransaction(
  client: Client,
  input: { organizationId: string; transactionId: string; categoryId: string | null; categorizedBy: TransactionRow["categorized_by"]; confidence?: number | null },
): Promise<Transaction> {
  const { data, error } = await client
    .from("transactions")
    .update({
      category_id: input.categoryId,
      categorized_by: input.categorizedBy,
      category_confidence: input.confidence ?? null,
    })
    .eq("id", input.transactionId)
    .eq("organization_id", input.organizationId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Transaction not found, or you don't have permission to change it.");
  return toTransaction(data);
}

/** Bulk categorization is deliberately a single UPDATE ... IN (...) rather
 *  than N calls to categorizeTransaction — one round trip, and one RLS
 *  evaluation per row still applies per-row (Postgres doesn't skip RLS for
 *  multi-row statements), so tenant isolation holds exactly as it does for
 *  a single update. */
export async function bulkCategorizeTransactions(
  client: Client,
  input: { organizationId: string; transactionIds: string[]; categoryId: string | null; categorizedBy: TransactionRow["categorized_by"] },
): Promise<number> {
  const { error, count } = await client
    .from("transactions")
    .update(
      { category_id: input.categoryId, categorized_by: input.categorizedBy, category_confidence: null },
      { count: "exact" },
    )
    .in("id", input.transactionIds)
    .eq("organization_id", input.organizationId);
  if (error) throw error;
  return count ?? 0;
}

export async function markReviewed(client: Client, organizationId: string, transactionIds: string[]): Promise<number> {
  const { error, count } = await client
    .from("transactions")
    .update({ is_reviewed: true }, { count: "exact" })
    .in("id", transactionIds)
    .eq("organization_id", organizationId);
  if (error) throw error;
  return count ?? 0;
}

/** Returns whether a row was actually deleted. RLS makes an unauthorized
 *  delete match zero rows rather than error, so without this the caller
 *  reported success — and wrote a `transaction.deleted` audit entry — for a
 *  deletion that never happened. */
export async function deleteTransaction(client: Client, transactionId: string, organizationId: string): Promise<boolean> {
  const { data, error } = await client
    .from("transactions")
    .delete()
    .eq("id", transactionId)
    .eq("organization_id", organizationId)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** Hard ceiling on how many rows the insight detectors will ever consider.
 *  High enough for six months of ordinary bookkeeping, low enough that a
 *  large workspace cannot turn insight generation into an unbounded read. */
export const ANALYSIS_ROW_CEILING = 5_000;

/**
 * Pages a period out to exhaustion for the pattern detectors.
 *
 * `listTransactions` clamps `pageSize` to 200 — a sensible cap for a UI page
 * and a silent trap for a caller that asked for 2000 and believed it got it.
 * `generateInsights` did exactly that, so six months of recurring-payment and
 * anomaly detection actually ran on the most recent 200 transactions.
 *
 * This walks the pages instead, stopping at `ANALYSIS_ROW_CEILING` or when the
 * source is exhausted. Detectors need rows rather than aggregates, so the SQL
 * aggregates that fixed FIN-01 do not apply here; bounding the read is the
 * available protection.
 */
export async function listRecentTransactionsForAnalysis(
  client: Client,
  organizationId: string,
  from: string,
  to: string,
  ceiling = ANALYSIS_ROW_CEILING,
): Promise<Transaction[]> {
  const pageSize = 200;
  const collected: Transaction[] = [];

  for (let page = 1; collected.length < ceiling; page++) {
    const { transactions } = await listTransactions(client, { organizationId, dateFrom: from, dateTo: to, page, pageSize });
    collected.push(...transactions);
    if (transactions.length < pageSize) break;
  }

  return collected.slice(0, ceiling);
}
