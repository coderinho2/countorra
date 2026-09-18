import { notFound } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { getOrganization } from "@/server/db/repositories/organizations";
import { getTransactionTotals, listTransactions } from "@/server/db/repositories/transactions";
import { listCategories } from "@/server/db/repositories/categories";
import { listAccounts } from "@/server/db/repositories/accounts";
import { listMerchants } from "@/server/db/repositories/merchants";
import { TransactionFilters } from "@/components/transactions/transaction-filters";
import { TransactionsTable } from "@/components/transactions/transactions-table";
import { NewTransactionDialog } from "@/components/transactions/new-transaction-dialog";
import { PageHeader, PageMeta, PageMetaItem, PageShell } from "@/components/ui/page-header";
import { Amount } from "@/components/amount";
import { subtract } from "@/domain/money/money";
import { summarizeTotals } from "@/domain/financial/calculation-engine";
import { describeExclusions } from "@/domain/money/aggregate";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";

/**
 * The ledger.
 *
 * The page previously opened with an 18px heading and a button, then a bare
 * row of filter controls floating on the page background, then a bare table.
 * Nothing framed the table, and — more importantly — nothing said what the
 * filtered set actually *was*. Filtering to "expenses over 500 in August" and
 * being shown a list with no total is the one thing a ledger must not do, so
 * the header carries the count and the money in, out and net.
 *
 * FIN-02: those figures used to be reduced from the 50 rows of the current
 * page, and then rendered in the same strip as `result.total`, the count
 * across the entire filtered set. So a filter matching 4,231 transactions
 * displayed "Matching 4,231" beside an "Out" figure computed from fifty of
 * them, with nothing marking the two as different scopes. Both numbers were
 * individually correct and the pair was badly misleading.
 *
 * They now come from `getTransactionTotals` — the same SQL aggregate the
 * dashboard and reports use, given the same filter object the list query
 * gets, so the strip and the table can never describe different sets. It is
 * one extra round trip returning at most a handful of grouped rows, not a
 * second fetch of the underlying transactions: the browser never receives
 * more than the page it renders.
 */
export default async function TransactionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { orgId } = await params;
  const search = await searchParams;
  const page = search.page ? Math.max(1, Number(search.page)) : 1;
  const pageSize = 50;

  const client = await createClient();
  const organization = await getOrganization(client, orgId);
  if (!organization) notFound();

  // One filter object, used for both the page of rows and the totals, so the
  // two can never drift apart.
  const filters = {
    organizationId: orgId,
    kind: (search.kind as "income" | "expense" | "transfer" | undefined) ?? undefined,
    categoryId: search.categoryId,
    isReviewed: search.reviewed === "true" ? true : search.reviewed === "false" ? false : undefined,
    search: search.search,
  };

  const [result, periodTotals, categories, accounts, merchants] = await Promise.all([
    listTransactions(client, { ...filters, page, pageSize }),
    getTransactionTotals(client, filters),
    listCategories(client, orgId),
    listAccounts(client, orgId),
    listMerchants(client, orgId),
  ]);

  const currency: CurrencyCode = isSupportedCurrency(organization.baseCurrency) ? organization.baseCurrency : "USD";

  // Rows in a foreign currency are excluded from the strip rather than
  // silently added at 1:1 — a wrong total is worse than a missing one — and
  // the exclusion is stated rather than assumed (FIN-03).
  const summary = summarizeTotals(periodTotals, currency);
  const income = summary.income;
  const expense = summary.expense;
  const net = subtract(income, expense);
  const exclusionNote = describeExclusions(summary.excluded, currency);

  const filtered = Boolean(search.kind || search.categoryId || search.reviewed || search.search);
  const unreviewed = summary.unreviewedCount;

  return (
    <PageShell className="gap-6">
      <PageHeader
        eyebrow="Records"
        title="Transactions"
        description={exclusionNote ? `Every movement of money in and out of this workspace, newest first. ${exclusionNote}` : "Every movement of money in and out of this workspace, newest first."}
        actions={<NewTransactionDialog organizationId={orgId} accounts={accounts} categories={categories} currency={organization.baseCurrency} />}
        meta={
          <PageMeta>
            <PageMetaItem label={filtered ? "Matching" : "Total"} value={result.total.toLocaleString("en-US")} />
            <PageMetaItem label="In" value={<Amount value={income} size="small" tone="positive" sign="positive" />} />
            <PageMetaItem label="Out" value={<Amount value={expense} size="small" tone="negative" sign="negative" />} />
            <PageMetaItem
              label="Net"
              value={<Amount value={net} size="small" tone={net.amountMinor < 0 ? "negative" : "neutral"} sign="auto" />}
              tone={net.amountMinor < 0 ? "negative" : "neutral"}
            />
            {unreviewed > 0 && <PageMetaItem label="Unreviewed" value={unreviewed} tone="warning" />}
          </PageMeta>
        }
      />

      <TransactionsTable
        organizationId={orgId}
        transactions={result.transactions}
        categories={categories}
        merchants={merchants}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        filters={<TransactionFilters categories={categories} />}
      />
    </PageShell>
  );
}
