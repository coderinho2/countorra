import { notFound } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { getOrganization } from "@/server/db/repositories/organizations";
import { getCategoryTotals, getTransactionTotals } from "@/server/db/repositories/transactions";
import { listCategories } from "@/server/db/repositories/categories";
import { listInvoices } from "@/server/db/repositories/invoices";
import { DateRangePicker } from "@/components/date-range-picker";
import { presetRange } from "@/lib/date-range";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Panel, PanelFooter, PanelHeader, SectionHeading } from "@/components/ui/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Amount } from "@/components/amount";
import { marginFromTotals, spendByCategoryFromTotals, summarizeTotals } from "@/domain/financial/calculation-engine";
import { describeExclusions } from "@/domain/money/aggregate";
import { money } from "@/domain/money/money";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";
import { cn } from "@/lib/utils";

/**
 * Deterministic reports (product spec §17) — every figure here comes from the
 * same `src/domain/financial` calculation engine the dashboard and the AI
 * tools use, applied to whatever date range is selected. Nothing on this page
 * is estimated, modelled, or rounded for presentation.
 *
 * Composed as a statement rather than as a dashboard: a masthead naming the
 * entity and the exact period, a summary strip, then a ruled profit-and-loss
 * table where expenses break down by category with each line's share of the
 * total. A finance professional reads down a column of figures; putting those
 * figures in separate cards makes that impossible, which is why the previous
 * "two charts in two cards" arrangement was the wrong shape for this page
 * even though each card was individually fine.
 */
export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { orgId } = await params;
  const search = await searchParams;
  const preset = search.preset ?? "this-month";
  const range = search.from && search.to ? { from: search.from, to: search.to } : presetRange(preset);

  const client = await createClient();
  const organization = await getOrganization(client, orgId);
  if (!organization) notFound();

  const currency: CurrencyCode = isSupportedCurrency(organization.baseCurrency) ? organization.baseCurrency : "USD";

  // Aggregated in SQL over the whole period (FIN-01). This page previously
  // summed rows fetched through PostgREST, which silently stopped at 1000 —
  // so a P&L for a busy quarter reported a partial one with no warning.
  const [periodTotals, categoryTotals, categories, invoicesResult] = await Promise.all([
    getTransactionTotals(client, { organizationId: orgId, dateFrom: range.from, dateTo: range.to }),
    getCategoryTotals(client, { organizationId: orgId, from: range.from, to: range.to }),
    listCategories(client, orgId),
    listInvoices(client, { organizationId: orgId, pageSize: 200 }),
  ]);
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const summary = summarizeTotals(periodTotals, currency);
  const income = summary.income;
  const expense = summary.expense;
  const profit = summary.profit;
  const margin = marginFromTotals(periodTotals, currency);
  const byCategory = spendByCategoryFromTotals(categoryTotals, currency).map((c) => ({
    categoryId: c.categoryId,
    categoryName: c.categoryId ? (categoryName.get(c.categoryId) ?? "Uncategorized") : "Uncategorized",
    total: c.total,
  }));

  // Stated in the statement footer rather than silently dropped: a P&L that
  // covers only part of a multi-currency period must say so (FIN-03).
  const exclusionNote = describeExclusions(summary.excluded, currency);

  const invoicesInRange = invoicesResult.invoices.filter((i) => i.issueDate >= range.from && i.issueDate <= range.to);
  const expenseTotal = expense.amountMinor || 1;

  return (
    <PageShell className="gap-8">
      <PageHeader
        eyebrow="Analysis"
        title="Reports"
        description={`${organization.name} — profit and loss for the selected period.`}
        actions={<DateRangePicker activePreset={preset} />}
      />

      {/* ── Statement header ─────────────────────────────────────────────
          A report has to say, unambiguously, which period it covers and in
          which currency, before it shows a single figure. */}
      <section className="flex flex-col gap-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <p className="text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">Profit and loss</p>
          <p className="font-numeric text-[13px] text-text-secondary">
            {range.from} — {range.to} · {currency}
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-border-subtle py-5 sm:grid-cols-4 sm:gap-x-0 sm:divide-x sm:divide-border-subtle">
          <div className="flex flex-col gap-1 sm:pr-8">
            <dt className="text-[13px] text-text-secondary">Income</dt>
            <dd>
              <Amount value={income} size="prominent" tone="ink" />
            </dd>
          </div>
          <div className="flex flex-col gap-1 sm:px-8">
            <dt className="text-[13px] text-text-secondary">Expenses</dt>
            <dd>
              <Amount value={expense} size="prominent" tone="ink" />
            </dd>
          </div>
          <div className="flex flex-col gap-1 sm:px-8">
            <dt className="text-[13px] text-text-secondary">Profit</dt>
            <dd>
              <Amount value={profit} size="prominent" tone={profit.amountMinor < 0 ? "negative" : "positive"} sign={profit.amountMinor < 0 ? "negative" : "none"} />
            </dd>
          </div>
          <div className="flex flex-col gap-1 sm:px-8">
            <dt className="text-[13px] text-text-secondary">Margin</dt>
            <dd className="font-numeric text-[22px] leading-7 font-medium tracking-[-0.01em] text-ink">{margin === null ? "—" : `${margin}%`}</dd>
          </div>
        </dl>
      </section>

      {/* ── The statement itself ─────────────────────────────────────── */}
      <Panel>
        <PanelHeader title="Statement" description="Income, then expenses by category, then the net result" />
        <Table fixed>
          <TableHeader>
            <TableRow>
              <TableHead className="w-full">Line</TableHead>
              <TableHead numeric className="w-24">
                Share
              </TableHead>
              <TableHead numeric className="w-44">
                Amount
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium">Total income</TableCell>
              <TableCell numeric className="text-text-tertiary">
                —
              </TableCell>
              <TableCell numeric>
                <Amount value={income} tone="ink" />
              </TableCell>
            </TableRow>

            <TableRow>
              <TableCell colSpan={3} className="bg-surface-sunken/60 text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">
                Expenses
              </TableCell>
            </TableRow>

            {byCategory.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-[13px] text-text-tertiary">
                  No categorised expenses in this period.
                </TableCell>
              </TableRow>
            ) : (
              byCategory.map((line) => (
                <TableRow key={line.categoryId ?? "uncategorized"}>
                  <TableCell className="max-w-0 truncate pl-6 text-text-secondary">{line.categoryName}</TableCell>
                  <TableCell numeric className="text-[13px] text-text-tertiary">
                    {((line.total.amountMinor / expenseTotal) * 100).toFixed(1)}%
                  </TableCell>
                  <TableCell numeric>
                    <Amount value={line.total} tone="neutral" />
                  </TableCell>
                </TableRow>
              ))
            )}

            <TableRow>
              <TableCell className="font-medium">Total expenses</TableCell>
              <TableCell numeric className="text-[13px] text-text-tertiary">
                100%
              </TableCell>
              <TableCell numeric>
                <Amount value={expense} tone="ink" />
              </TableCell>
            </TableRow>

            {/* The result line is the one figure a P&L exists to produce, so
                it gets a heavier top rule and the prominent numeric scale. */}
            <TableRow className="border-t-2 border-t-border hover:bg-transparent">
              <TableCell className="text-[15px] font-medium text-ink">Net {profit.amountMinor < 0 ? "loss" : "profit"}</TableCell>
              <TableCell numeric className="text-[13px] text-text-tertiary">
                {margin === null ? "—" : `${margin}%`}
              </TableCell>
              <TableCell numeric>
                <Amount
                  value={profit}
                  size="prominent"
                  tone={profit.amountMinor < 0 ? "negative" : "ink"}
                  sign={profit.amountMinor < 0 ? "negative" : "none"}
                />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <PanelFooter>
          <span>
            Calculated from {summary.transactionCount.toLocaleString("en-US")} {summary.transactionCount === 1 ? "transaction" : "transactions"} dated between {range.from} and{" "}
            {range.to}.{exclusionNote ? ` ${exclusionNote}` : ""}
          </span>
        </PanelFooter>
      </Panel>

      {organization.entityType !== "personal" && (
        <section className="flex flex-col gap-4">
          <SectionHeading
            title="Invoices issued in this period"
            description={`${invoicesInRange.length} ${invoicesInRange.length === 1 ? "invoice" : "invoices"}`}
          />
          {invoicesInRange.length === 0 ? (
            <p className="text-[13px] text-text-tertiary">No invoices were issued between these dates.</p>
          ) : (
            <Table fixed>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">Number</TableHead>
                  <TableHead className="w-full">Issued</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead numeric className="w-40">
                    Total
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoicesInRange.map((invoice) => (
                  <TableRow key={invoice.id}>
                    <TableCell className="font-numeric text-[13px]">{invoice.invoiceNumber}</TableCell>
                    <TableCell className={cn("font-numeric text-[13px] text-text-tertiary")}>{invoice.issueDate}</TableCell>
                    <TableCell>
                      <InvoiceStatusBadge status={invoice.status} />
                    </TableCell>
                    <TableCell numeric>
                      <Amount value={money(invoice.totalMinor, isSupportedCurrency(invoice.currency) ? invoice.currency : currency)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      )}
    </PageShell>
  );
}
