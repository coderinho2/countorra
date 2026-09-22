import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "@phosphor-icons/react/dist/ssr/ArrowLeft";
import { createClient } from "@/server/supabase/server";
import { getTransaction } from "@/server/db/repositories/transactions";
import { listCategories } from "@/server/db/repositories/categories";
import { listAccounts } from "@/server/db/repositories/accounts";
import { listMerchants } from "@/server/db/repositories/merchants";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { Badge } from "@/components/ui/badge";
import { Amount } from "@/components/amount";
import { DeleteTransactionButton } from "@/components/transactions/delete-transaction-button";
import { money, zero } from "@/domain/money/money";
import { isSupportedCurrency } from "@/domain/money/currency";
import { TRANSACTION_SOURCE_LABELS } from "@/domain/bank-connections/presentation";

function safeMoney(amountMinor: number, currency: string) {
  return isSupportedCurrency(currency) ? money(amountMinor, currency) : zero("USD");
}

/**
 * A single movement of money.
 *
 * The amount is the heading here — it is set at the H1 numeric scale and the
 * description sits beneath it as a caption, rather than the other way round.
 * Deletion moves out of the page flow and into a bottom section that names
 * what it does and warns before it does it: DESIGN.md §18 wants destructive
 * actions visually distinct but not dramatic, which means a rule and a
 * sentence, not a red panel.
 */
export default async function TransactionDetailPage({ params }: { params: Promise<{ orgId: string; transactionId: string }> }) {
  const { orgId, transactionId } = await params;
  const client = await createClient();

  const [transaction, categories, accounts, merchants] = await Promise.all([
    getTransaction(client, transactionId, orgId),
    listCategories(client, orgId),
    listAccounts(client, orgId),
    listMerchants(client, orgId),
  ]);
  if (!transaction || transaction.organizationId !== orgId) notFound();

  const category = categories.find((c) => c.id === transaction.categoryId);
  const account = accounts.find((a) => a.id === transaction.accountId);
  const merchant = merchants.find((m) => m.id === transaction.merchantId);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 lg:px-8 lg:py-8">
      <Link
        href={`/app/${orgId}/transactions`}
        className="flex w-fit items-center gap-1.5 rounded-sm text-[13px] text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <ArrowLeft size={14} />
        Transactions
      </Link>

      <header className="flex flex-col gap-2 border-b border-border-subtle pb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Amount
            value={safeMoney(transaction.amountMinor, transaction.currency)}
            size="hero"
            sign={transaction.kind === "income" ? "positive" : transaction.kind === "expense" ? "negative" : "none"}
            tone={transaction.kind === "income" ? "positive" : "ink"}
          />
          {!transaction.isReviewed && <Badge variant="warning">Unreviewed</Badge>}
        </div>
        <p className="text-[17px] leading-[26px] text-text-secondary">{transaction.description ?? "No description"}</p>
        <p className="text-[13px] text-text-tertiary">
          <span className="font-numeric">{transaction.occurredOn}</span>
          {merchant && ` · ${merchant.name}`}
        </p>
      </header>

      <Panel>
        <PanelHeader title="Details" />
        <DetailList>
          <DetailRow label="Date">
            <span className="font-numeric">{transaction.occurredOn}</span>
          </DetailRow>
          <DetailRow label="Account">{account?.name ?? "—"}</DetailRow>
          <DetailRow label="Category">{category?.name ?? "Uncategorized"}</DetailRow>
          <DetailRow label="Merchant">{merchant?.name ?? "—"}</DetailRow>
          <DetailRow label="Type">
            <span className="capitalize">{transaction.kind}</span>
          </DetailRow>
          {/* Where the transaction came from, in words — "bank_sync" is a
              column value, not something a person should have to decode. */}
          <DetailRow label="Source">{TRANSACTION_SOURCE_LABELS[transaction.source]}</DetailRow>
          {transaction.categorizedBy && (
            <DetailRow label="Categorized by">
              <span className="capitalize">{transaction.categorizedBy}</span>
              {transaction.categoryConfidence !== null && (
                <span className="text-text-tertiary"> · {Math.round(transaction.categoryConfidence * 100)}% confidence</span>
              )}
            </DetailRow>
          )}
          {transaction.memo && <DetailRow label="Memo">{transaction.memo}</DetailRow>}
        </DetailList>
      </Panel>

      {transaction.source === "bank_sync" ? (
        // Provider data versus Countorra enrichment (0054): the amount, date,
        // direction and account are your bank's, and follow it — a correction
        // or removal at the bank reaches this record on the next sync. What
        // Countorra adds (category, merchant, memo) stays yours to change.
        <section className="flex flex-col gap-0.5 border-t border-border-subtle pt-5">
          <h2 className="text-[13px] font-medium text-text-primary">From your bank</h2>
          <p className="max-w-[70ch] text-[13px] text-text-secondary">
            The amount, date and account come from your bank and can&apos;t be edited or deleted here — if the bank corrects or removes
            this transaction, the change arrives on the next sync. The category and merchant are Countorra&apos;s, and you can change them.
          </p>
        </section>
      ) : (
        <section className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-5">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-[13px] font-medium text-text-primary">Delete this transaction</h2>
            <p className="text-[13px] text-text-secondary">It will be removed from every balance, report and total. This cannot be undone.</p>
          </div>
          <DeleteTransactionButton organizationId={orgId} transactionId={transactionId} />
        </section>
      )}
    </div>
  );
}
