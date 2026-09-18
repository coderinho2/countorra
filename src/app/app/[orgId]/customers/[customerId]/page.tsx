import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "@phosphor-icons/react/dist/ssr/ArrowLeft";
import { createClient } from "@/server/supabase/server";
import { getCustomer } from "@/server/db/repositories/customers";
import { listInvoices } from "@/server/db/repositories/invoices";
import { getOrganization } from "@/server/db/repositories/organizations";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { Amount } from "@/components/amount";
import { money, zero } from "@/domain/money/money";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";
import { cn } from "@/lib/utils";

function safeMoney(amountMinor: number, currency: string) {
  return isSupportedCurrency(currency) ? money(amountMinor, currency) : zero("USD");
}

/**
 * One counterparty's financial relationship with this workspace.
 *
 * The page opens with the number the relationship is actually about — what
 * they owe — rather than with a contact card. Billed-to-date and paid sit
 * beside it as context, contact details drop to a quiet rail underneath, and
 * the invoice history is a ruled ledger.
 */
export default async function CustomerDetailPage({ params }: { params: Promise<{ orgId: string; customerId: string }> }) {
  const { orgId, customerId } = await params;
  const client = await createClient();

  const [customer, organization] = await Promise.all([getCustomer(client, customerId), getOrganization(client, orgId)]);
  if (!customer || customer.organizationId !== orgId || !organization) notFound();

  const { invoices } = await listInvoices(client, { organizationId: orgId, customerId, pageSize: 200 });
  const currency: CurrencyCode = isSupportedCurrency(organization.baseCurrency) ? organization.baseCurrency : "USD";
  const today = new Date().toISOString().slice(0, 10);

  const counted = invoices.filter((i) => i.currency === currency && i.status !== "void");
  const billed = counted.reduce((sum, i) => sum + i.totalMinor, 0);
  const outstanding = counted.filter((i) => i.status === "sent" || i.status === "overdue").reduce((sum, i) => sum + i.totalMinor, 0);
  const paid = counted.filter((i) => i.status === "paid").reduce((sum, i) => sum + i.totalMinor, 0);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 lg:px-8 lg:py-8">
      <Link
        href={`/app/${orgId}/customers`}
        className="flex w-fit items-center gap-1.5 rounded-sm text-[13px] text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <ArrowLeft size={14} />
        Customers
      </Link>

      <header className="flex flex-col gap-5 border-b border-border-subtle pb-6">
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">Customer</p>
          <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.01em] text-ink">{customer.displayName}</h1>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text-secondary">
            {customer.email ? <span>{customer.email}</span> : <span className="text-text-tertiary">No email on file</span>}
            {customer.taxId && (
              <>
                <span aria-hidden="true" className="text-text-tertiary">
                  ·
                </span>
                <span className="font-numeric">{customer.taxId}</span>
              </>
            )}
          </p>
        </div>

        <dl className="grid grid-cols-1 gap-x-0 gap-y-5 sm:grid-cols-3 sm:divide-x sm:divide-border-subtle">
          <div className="flex flex-col gap-1 sm:pr-8">
            <dt className="text-[13px] text-text-secondary">Outstanding</dt>
            <dd>
              <Amount value={money(outstanding, currency)} size="prominent" tone={outstanding > 0 ? "ink" : "muted"} />
            </dd>
          </div>
          <div className="flex flex-col gap-1 sm:px-8">
            <dt className="text-[13px] text-text-secondary">Billed to date</dt>
            <dd>
              <Amount value={money(billed, currency)} size="prominent" tone="ink" />
            </dd>
          </div>
          <div className="flex flex-col gap-1 sm:px-8">
            <dt className="text-[13px] text-text-secondary">Paid</dt>
            <dd>
              <Amount value={money(paid, currency)} size="prominent" tone="ink" />
            </dd>
          </div>
        </dl>
      </header>

      <Panel>
        <PanelHeader title="Invoices" description={`${invoices.length} ${invoices.length === 1 ? "invoice" : "invoices"} for this customer`} />
        {invoices.length === 0 ? (
          <EmptyState title="No invoices yet" description="Invoices you raise for this customer will appear here." />
        ) : (
          <Table fixed>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">Number</TableHead>
                <TableHead className="w-28">Status</TableHead>
                <TableHead className="w-full">Issued</TableHead>
                <TableHead className="w-32">Due</TableHead>
                <TableHead numeric className="w-36">
                  Total
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => {
                const late = !!invoice.dueDate && invoice.dueDate < today && invoice.status !== "paid" && invoice.status !== "void";
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
                    <TableCell>
                      <InvoiceStatusBadge status={invoice.status} />
                    </TableCell>
                    <TableCell className="font-numeric text-[13px] text-text-tertiary">{invoice.issueDate}</TableCell>
                    <TableCell className={cn("font-numeric text-[13px]", late ? "text-negative" : "text-text-secondary")}>{invoice.dueDate ?? "—"}</TableCell>
                    <TableCell numeric>
                      <Amount value={safeMoney(invoice.totalMinor, invoice.currency)} tone={invoice.status === "paid" ? "muted" : "ink"} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
