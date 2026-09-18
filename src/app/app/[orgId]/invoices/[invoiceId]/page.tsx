import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "@phosphor-icons/react/dist/ssr/ArrowLeft";
import { createClient } from "@/server/supabase/server";
import { getInvoice } from "@/server/db/repositories/invoices";
import { daysOverdue, deriveInvoiceState, isSettled, type StoredInvoiceStatus } from "@/domain/invoicing/lifecycle";
import { getCustomer } from "@/server/db/repositories/customers";
import { getOrganization } from "@/server/db/repositories/organizations";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { InvoiceStatusActions } from "@/components/invoices/invoice-status-actions";
import { PrintInvoiceButton } from "@/components/invoices/print-invoice-button";
import { Amount } from "@/components/amount";
import { money } from "@/domain/money/money";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";
import { cn } from "@/lib/utils";

/**
 * DESIGN.md §13: the invoice reads like an actual document, not an app panel.
 *
 * What changed in the Phase 2 pass, beyond spacing:
 *
 * - The document sits on the page as paper, with `48px` print-document
 *   margins rather than app-card padding, and — for anything unpaid — opens
 *   with the one fact the recipient and the sender both care about: the
 *   amount due and when. That figure is the largest thing on the page, ahead
 *   of the business name, because it is what the page is *for*.
 * - "From" and "Bill to" are a real two-column band separated by a rule,
 *   which is how every invoice in the world is laid out. Previously only the
 *   customer appeared, so the document never said who was billing.
 * - The line-item table is ruled, right-aligns every figure in Geist Mono,
 *   and its totals block sits under a top rule at the bottom right with the
 *   final total against `--color-ink` — never the accent, which would make
 *   the most important number on the page look like a link.
 * - It prints. `print:` rules (globals.css) drop the app chrome and the
 *   action bar so the sheet that comes out is the document alone.
 */
export default async function InvoiceDetailPage({ params }: { params: Promise<{ orgId: string; invoiceId: string }> }) {
  const { orgId, invoiceId } = await params;
  const client = await createClient();

  const [invoice, organization] = await Promise.all([getInvoice(client, invoiceId, orgId), getOrganization(client, orgId)]);
  if (!invoice || invoice.organizationId !== orgId || !organization) notFound();

  const customer = await getCustomer(client, invoice.customerId);
  const currency: CurrencyCode = isSupportedCurrency(invoice.currency) ? invoice.currency : "USD";
  const m = (amountMinor: number) => money(amountMinor, currency);

  const now = new Date();
  // Both derived through the one state machine, so this page, the list, the
  // PDF and the customer-facing view cannot disagree about whether an
  // invoice is late (src/domain/invoicing/lifecycle.ts).
  const status = invoice.status as StoredInvoiceStatus;
  const state = deriveInvoiceState({ status, dueDate: invoice.dueDate }, now);
  const settled = isSettled(status);
  const late = state === "overdue";
  const daysLate = daysOverdue(invoice.dueDate, now);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 lg:px-8 lg:py-8 print:max-w-none print:p-0">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <Link
          href={`/app/${orgId}/invoices`}
          className="flex items-center gap-1.5 rounded-sm text-[13px] text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <ArrowLeft size={14} />
          Invoices
        </Link>
        <div className="flex items-center gap-2">
          <PrintInvoiceButton />
          <InvoiceStatusActions organizationId={orgId} invoiceId={invoiceId} status={status} state={state} />
        </div>
      </div>

      <article
        className={cn(
          "rounded-md border border-border-subtle bg-surface p-8 sm:p-12",
          "print:rounded-none print:border-0 print:bg-white print:p-0 print:text-black",
        )}
      >
        {/* ── Masthead ────────────────────────────────────────────────── */}
        <header className="flex flex-wrap items-start justify-between gap-6">
          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">Invoice</p>
            <p className="text-[20px] leading-7 font-semibold tracking-[-0.005em] text-ink">{organization.name}</p>
            {organization.taxIdentifier && (
              <p className="text-[13px] text-text-secondary">
                Tax ID <span className="font-numeric">{organization.taxIdentifier}</span>
              </p>
            )}
          </div>

          <div className="flex flex-col items-end gap-1.5 text-right">
            <div className="flex items-center gap-2">
              <span className="font-numeric text-[15px] font-medium text-ink">{invoice.invoiceNumber}</span>
              <InvoiceStatusBadge status={invoice.status} />
            </div>
            <dl className="flex flex-col gap-0.5 text-[13px]">
              <div className="flex justify-end gap-3">
                <dt className="text-text-tertiary">Issued</dt>
                <dd className="font-numeric text-text-secondary">{invoice.issueDate}</dd>
              </div>
              {invoice.dueDate && (
                <div className="flex justify-end gap-3">
                  <dt className="text-text-tertiary">Due</dt>
                  <dd className={cn("font-numeric", late ? "text-negative" : "text-text-secondary")}>{invoice.dueDate}</dd>
                </div>
              )}
            </dl>
          </div>
        </header>

        {/* ── Amount due ──────────────────────────────────────────────────
            The document's focal point while money is outstanding. Once it is
            paid or voided this band disappears entirely rather than showing a
            settled figure at hero scale — a paid invoice is a record, and a
            record does not need to shout. */}
        {!settled && (
          <section className="mt-8 flex flex-wrap items-end justify-between gap-4 border-y border-border-subtle py-5">
            <div className="flex flex-col gap-1">
              <span className="text-[13px] text-text-secondary">Amount due</span>
              <Amount value={m(invoice.totalMinor)} size="hero" tone="ink" />
            </div>
            {late ? (
              <p className="text-[13px] text-negative">
                {daysLate} {daysLate === 1 ? "day" : "days"} past due
              </p>
            ) : (
              invoice.dueDate && (
                <p className="text-[13px] text-text-tertiary">
                  Payable by <span className="font-numeric">{invoice.dueDate}</span>
                </p>
              )
            )}
          </section>
        )}

        {/* ── Parties ─────────────────────────────────────────────────── */}
        <section className={cn("grid gap-8 border-b border-border-subtle pb-6 sm:grid-cols-2", settled ? "mt-8" : "mt-6")}>
          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">From</p>
            <p className="text-[15px] text-text-primary">{organization.name}</p>
            {organization.taxIdentifier && <p className="font-numeric text-[13px] text-text-secondary">{organization.taxIdentifier}</p>}
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">Bill to</p>
            <p className="text-[15px] text-text-primary">{customer?.displayName ?? "—"}</p>
            {customer?.email && <p className="text-[13px] text-text-secondary">{customer.email}</p>}
            {customer?.taxId && <p className="font-numeric text-[13px] text-text-secondary">{customer.taxId}</p>}
          </div>
        </section>

        {/* ── Line items ──────────────────────────────────────────────── */}
        <table className="mt-8 w-full table-fixed border-collapse">
          <thead>
            <tr className="border-b border-border text-left text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">
              <th scope="col" className="w-full pb-2 font-semibold">
                Description
              </th>
              <th scope="col" className="w-16 pb-2 text-right font-semibold">
                Qty
              </th>
              <th scope="col" className="w-32 pb-2 text-right font-semibold">
                Rate
              </th>
              <th scope="col" className="w-32 pb-2 text-right font-semibold">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {invoice.lineItems.map((item) => (
              <tr key={item.id} className="border-b border-border-subtle align-top text-[15px]">
                <td className="py-3 pr-4 text-text-primary">{item.description}</td>
                <td className="py-3 text-right font-numeric text-[13px] text-text-secondary">{item.quantity}</td>
                <td className="py-3 text-right font-numeric text-[13px] text-text-secondary">
                  <Amount value={m(item.unitPriceMinor)} size="small" tone="muted" />
                </td>
                <td className="py-3 text-right">
                  <Amount value={m(item.amountMinor)} size="small" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* ── Totals ──────────────────────────────────────────────────── */}
        <div className="mt-6 flex justify-end">
          <dl className="flex w-full max-w-[280px] flex-col gap-2">
            <div className="flex items-baseline justify-between text-[13px]">
              <dt className="text-text-secondary">Subtotal</dt>
              <dd>
                <Amount value={m(invoice.subtotalMinor)} size="small" tone="muted" />
              </dd>
            </div>
            <div className="flex items-baseline justify-between text-[13px]">
              <dt className="text-text-secondary">Tax</dt>
              <dd>
                <Amount value={m(invoice.taxMinor)} size="small" tone="muted" />
              </dd>
            </div>
            <div className="mt-1 flex items-baseline justify-between border-t border-border pt-3">
              <dt className="text-[15px] font-medium text-ink">{settled ? "Total" : "Total due"}</dt>
              <dd>
                <Amount value={m(invoice.totalMinor)} size="prominent" tone="ink" />
              </dd>
            </div>
          </dl>
        </div>

        {invoice.notes && (
          <footer className="mt-12 border-t border-border-subtle pt-4">
            <p className="text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">Notes</p>
            <p className="mt-1.5 max-w-[70ch] text-[13px] text-text-secondary">{invoice.notes}</p>
          </footer>
        )}
      </article>
    </div>
  );
}
