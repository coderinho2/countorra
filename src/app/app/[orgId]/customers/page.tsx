import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { getOrganization } from "@/server/db/repositories/organizations";
import { listCustomers } from "@/server/db/repositories/customers";
import { listInvoices } from "@/server/db/repositories/invoices";
import { NewCustomerDialog } from "@/components/customers/new-customer-dialog";
import { PageHeader, PageMeta, PageMetaItem, PageShell } from "@/components/ui/page-header";
import { Panel, PanelFooter } from "@/components/ui/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { Amount } from "@/components/amount";
import { money } from "@/domain/money/money";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";

/**
 * Customers, seen the way an accounting product should see them: not as a
 * contact list, but as the counterparties money is owed by.
 *
 * The page previously showed name, email and tax ID — three fields that tell
 * you nothing you would open this page to find out. Every row now carries
 * what has been billed, what is still outstanding, and how many invoices sit
 * behind those figures, all derived from the same invoice rows the Invoices
 * page reads. That is the difference between a CRM table and a receivables
 * ledger, and this product is the second one.
 */
export default async function CustomersPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const client = await createClient();

  const organization = await getOrganization(client, orgId);
  if (!organization) notFound();

  const [customers, invoiceResult] = await Promise.all([listCustomers(client, orgId), listInvoices(client, { organizationId: orgId, pageSize: 500 })]);

  const currency: CurrencyCode = isSupportedCurrency(organization.baseCurrency) ? organization.baseCurrency : "USD";

  const stats = new Map<string, { billed: number; outstanding: number; count: number }>();
  for (const invoice of invoiceResult.invoices) {
    if (invoice.currency !== currency || invoice.status === "void") continue;
    const entry = stats.get(invoice.customerId) ?? { billed: 0, outstanding: 0, count: 0 };
    entry.billed += invoice.totalMinor;
    entry.count += 1;
    if (invoice.status === "sent" || invoice.status === "overdue") entry.outstanding += invoice.totalMinor;
    stats.set(invoice.customerId, entry);
  }

  // Owed-the-most first: a customer list in a finance product is a queue,
  // and alphabetical order tells you nothing about who to chase.
  const ordered = [...customers].sort((a, b) => {
    const sa = stats.get(a.id);
    const sb = stats.get(b.id);
    return (sb?.outstanding ?? 0) - (sa?.outstanding ?? 0) || (sb?.billed ?? 0) - (sa?.billed ?? 0) || a.displayName.localeCompare(b.displayName);
  });

  const totalOutstanding = [...stats.values()].reduce((sum, s) => sum + s.outstanding, 0);
  const withOutstanding = [...stats.values()].filter((s) => s.outstanding > 0).length;

  return (
    <PageShell className="gap-6">
      <PageHeader
        eyebrow="Billing"
        title="Customers"
        description="Who you invoice, and what each of them still owes."
        actions={<NewCustomerDialog organizationId={orgId} />}
        meta={
          customers.length > 0 ? (
            <PageMeta>
              <PageMetaItem label="Customers" value={customers.length} />
              <PageMetaItem
                label="Outstanding"
                value={<Amount value={money(totalOutstanding, currency)} size="small" tone={totalOutstanding > 0 ? "neutral" : "muted"} />}
              />
              {withOutstanding > 0 && <PageMetaItem label="Owing" value={withOutstanding} />}
            </PageMeta>
          ) : undefined
        }
      />

      <Panel>
        {customers.length === 0 ? (
          <EmptyState title="No customers yet" description="Add a customer to start invoicing them." />
        ) : (
          <>
            <Table fixed>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-full">Customer</TableHead>
                  <TableHead className="w-56">Email</TableHead>
                  <TableHead numeric className="w-20">
                    Invoices
                  </TableHead>
                  <TableHead numeric className="w-36">
                    Billed
                  </TableHead>
                  <TableHead numeric className="w-36">
                    Outstanding
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ordered.map((customer) => {
                  const stat = stats.get(customer.id);
                  return (
                    <TableRow key={customer.id}>
                      <TableCell className="max-w-0">
                        <Link
                          href={`/app/${orgId}/customers/${customer.id}`}
                          className="block truncate rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          {customer.displayName}
                        </Link>
                        {customer.taxId && <span className="font-numeric text-[12px] text-text-tertiary">{customer.taxId}</span>}
                      </TableCell>
                      <TableCell className="truncate text-[13px] text-text-secondary">{customer.email ?? "—"}</TableCell>
                      <TableCell numeric className="text-[13px] text-text-tertiary">
                        {stat?.count ?? 0}
                      </TableCell>
                      <TableCell numeric>
                        {stat ? <Amount value={money(stat.billed, currency)} size="small" tone="muted" /> : <span className="text-text-tertiary">—</span>}
                      </TableCell>
                      <TableCell numeric>
                        {stat && stat.outstanding > 0 ? (
                          <Amount value={money(stat.outstanding, currency)} size="small" tone="ink" />
                        ) : (
                          <span className="text-[13px] text-text-tertiary">Settled</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <PanelFooter>
              <span>Sorted by what is outstanding. Figures cover invoices in {currency}, excluding voided ones.</span>
            </PanelFooter>
          </>
        )}
      </Panel>
    </PageShell>
  );
}
