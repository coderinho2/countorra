import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { getOrganization } from "@/server/db/repositories/organizations";
import { listInvoices } from "@/server/db/repositories/invoices";
import { listCustomers } from "@/server/db/repositories/customers";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { InvoiceStatusFilter } from "@/components/invoices/invoice-status-filter";
import { Button } from "@/components/ui/button";
import { PageHeader, PageMeta, PageMetaItem, PageShell } from "@/components/ui/page-header";
import { Panel, PanelFooter, PanelHeader } from "@/components/ui/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { Amount } from "@/components/amount";
import { money, zero } from "@/domain/money/money";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";
import { cn } from "@/lib/utils";
import type { InvoiceStatus } from "@/types/database";

function safeMoney(amountMinor: number, currency: string) {
  return isSupportedCurrency(currency) ? money(amountMinor, currency) : zero("USD");
}

const INVOICE_STATUSES: InvoiceStatus[] = ["draft", "sent", "paid", "overdue", "void"];
function parseStatus(value: string | undefined): InvoiceStatus | undefined {
  return INVOICE_STATUSES.find((s) => s === value);
}



/**
 * The receivables ledger.
 *
 * A list of invoices answers one question before any other: how much is owed,
 * and how much of it is late. That used to require reading and adding up the
 * rows yourself. The header now carries outstanding and overdue as figures,
 * status is a visible segmented filter rather than a hidden one, and an
 * overdue due-date is rendered in the negative tone with its age — the row
 * says "31 days late" instead of making the reader do date arithmetic.
 */
export default async function InvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { orgId } = await params;
  const search = await searchParams;
  const client = await createClient();

  const organization = await getOrganization(client, orgId);
  if (!organization) notFound();

  const status = parseStatus(search.status);
  const [{ invoices }, allResult, customers] = await Promise.all([
    listInvoices(client, { organizationId: orgId, status, pageSize: 100 }),
    listInvoices(client, { organizationId: orgId, pageSize: 500 }),
    listCustomers(client, orgId),
  ]);
  const customerName = new Map(customers.map((c) => [c.id, c.displayName]));

  const currency: CurrencyCode = isSupportedCurrency(organization.baseCurrency) ? organization.baseCurrency : "USD";
  // One clock read for the whole render. Reading the clock repeatedly inside
  // the row loop is both impure during render and subtly wrong: rows would be
  // compared against fractionally different "now"s.
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const nowMs = now.getTime();

  // Totals are taken from the full set, not the filtered view: "outstanding"
  // has to mean the same number whichever tab is selected, or the header
  // becomes a second, contradictory filter.
  const sumOf = (predicate: (i: (typeof allResult.invoices)[number]) => boolean) =>
    allResult.invoices.filter((i) => i.currency === currency && predicate(i)).reduce((sum, i) => sum + i.totalMinor, 0);

  const outstanding = sumOf((i) => i.status === "sent" || i.status === "overdue");
  const overdueMinor = sumOf((i) => i.status === "overdue" || (i.status === "sent" && !!i.dueDate && i.dueDate < today));
  const draftCount = allResult.invoices.filter((i) => i.status === "draft").length;

  return (
    <PageShell className="gap-6">
      <PageHeader
        eyebrow="Billing"
        title="Invoices"
        description="What you have billed, what has been paid, and what is still owed to you."
        actions={
          <Button asChild>
            <Link href={`/app/${orgId}/invoices/new`}>New invoice</Link>
          </Button>
        }
        meta={
          allResult.invoices.length > 0 ? (
            <PageMeta>
              <PageMetaItem label="Outstanding" value={<Amount value={money(outstanding, currency)} size="small" />} />
              <PageMetaItem
                label="Overdue"
                value={<Amount value={money(overdueMinor, currency)} size="small" tone={overdueMinor > 0 ? "negative" : "muted"} />}
              />
              {draftCount > 0 && <PageMetaItem label="Drafts" value={draftCount} tone="warning" />}
            </PageMeta>
          ) : undefined
        }
      />

      <Panel>
        <PanelHeader className="py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <InvoiceStatusFilter />
            <span className="font-numeric text-[13px] text-text-tertiary">
              {invoices.length} {invoices.length === 1 ? "invoice" : "invoices"}
            </span>
          </div>
        </PanelHeader>

        {invoices.length === 0 ? (
          <EmptyState
            title={status ? `No ${status} invoices` : "No invoices yet"}
            description={status ? "Nothing in this status right now." : "Create your first invoice to start billing customers."}
            action={
              status ? undefined : (
                <Button asChild size="sm">
                  <Link href={`/app/${orgId}/invoices/new`}>New invoice</Link>
                </Button>
              )
            }
          />
        ) : (
          <>
            <Table fixed>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">Number</TableHead>
                  <TableHead className="w-full">Customer</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead className="w-28">Issued</TableHead>
                  <TableHead className="w-40">Due</TableHead>
                  <TableHead numeric className="w-36">
                    Total
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((invoice) => {
                  const late = !!invoice.dueDate && invoice.dueDate < today && invoice.status !== "paid" && invoice.status !== "void";
                  const daysLate = late && invoice.dueDate ? Math.floor((nowMs - new Date(`${invoice.dueDate}T00:00:00Z`).getTime()) / 86_400_000) : 0;
                  return (
                    <TableRow key={invoice.id}>
                      <TableCell>
                        <Link
                          href={`/app/${orgId}/invoices/${invoice.id}`}
                          className="rounded-sm font-numeric text-[13px] font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          {invoice.invoiceNumber}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-0 truncate text-text-secondary">{customerName.get(invoice.customerId) ?? "—"}</TableCell>
                      <TableCell>
                        <InvoiceStatusBadge status={invoice.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-text-tertiary">
                        <span className="font-numeric text-[13px]">{invoice.issueDate}</span>
                      </TableCell>
                      <TableCell className={cn("whitespace-nowrap", late ? "text-negative" : "text-text-secondary")}>
                        <span className="font-numeric text-[13px]">{invoice.dueDate ?? "—"}</span>
                        {daysLate > 0 && <span className="ml-1.5 text-[12px] text-text-tertiary">{daysLate}d late</span>}
                      </TableCell>
                      <TableCell numeric>
                        <Amount value={safeMoney(invoice.totalMinor, invoice.currency)} tone={invoice.status === "paid" ? "muted" : "ink"} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <PanelFooter>
              <span>
                {status ? `Filtered to ${status}` : "All invoices"} · totals in the header cover every invoice in {currency}
              </span>
            </PanelFooter>
          </>
        )}
      </Panel>
    </PageShell>
  );
}
