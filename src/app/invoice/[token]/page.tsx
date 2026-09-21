import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/server/supabase/client";
import { money, format as formatMoney } from "@/domain/money/money";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";
import { daysOverdue, deriveInvoiceState, type StoredInvoiceStatus } from "@/domain/invoicing/lifecycle";
import { cn } from "@/lib/utils";

/**
 * The invoice as the CUSTOMER sees it.
 *
 * No session, no account, no organization context. The token in the URL is
 * the entire authorization, and it unlocks exactly one invoice.
 *
 * HOW THIS READS DATA WITHOUT A SESSION OR THE SERVICE ROLE
 *
 * Neither of the usual clients works here. An RLS-scoped client has no
 * session to satisfy `is_org_member`, and the service role would hand an
 * unauthenticated public route a client that can read every organization's
 * data — one bug away from a cross-tenant leak on the most exposed page in
 * the product.
 *
 * So it calls two SECURITY DEFINER functions (0037) with the anon key. They
 * take a token and return at most the one invoice it unlocks, with only the
 * fields a customer needs. Nothing else in the schema becomes reachable, and
 * the access control lives in the function body where it can be read in one
 * place.
 *
 * NOINDEX, ALWAYS. An invoice is somebody's private financial document that
 * happens to be reachable by URL.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Invoice — Countorra",
  robots: { index: false, follow: false, nocache: true },
};

interface PublicInvoice {
  id: string;
  organization_name: string;
  invoice_number: string;
  status: string;
  currency: string;
  issue_date: string;
  due_date: string | null;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  notes: string | null;
  payment_url: string | null;
  customer_name: string;
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export default async function PublicInvoicePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // A short token cannot be a real one. Refusing early keeps obviously
  // fabricated values from reaching the database at all.
  if (!token || token.length < 32) notFound();

  const supabase = createClient();
  const { data, error } = await supabase.rpc("invoice_by_public_token", { p_token: token });
  const invoice = (data as PublicInvoice[] | null)?.[0];

  // One answer for a wrong token, a revoked token and a draft. Distinguishing
  // them would confirm which tokens exist.
  if (error || !invoice) notFound();

  const { data: itemData } = await supabase.rpc("invoice_line_items_by_public_token", { p_token: token });
  const lineItems = (itemData as { description: string; quantity: number; unit_price_minor: number; amount_minor: number }[] | null) ?? [];

  const currency: CurrencyCode = isSupportedCurrency(invoice.currency) ? invoice.currency : "USD";
  const amount = (minor: number) => formatMoney(money(minor, currency));

  const state = deriveInvoiceState({ status: invoice.status as StoredInvoiceStatus, dueDate: invoice.due_date });
  const late = state === "overdue";
  const daysLate = daysOverdue(invoice.due_date);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-10 lg:py-16">
      <article className="rounded-md border border-border-subtle bg-surface p-8 sm:p-12">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-[17px] font-semibold tracking-[-0.005em] text-ink">{invoice.organization_name}</p>
            <p className="text-[13px] text-text-secondary">Invoice {invoice.invoice_number}</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="font-numeric text-[11px] tracking-[0.14em] text-text-tertiary uppercase">
              {state === "paid" ? "Paid" : state === "void" ? "Void" : late ? "Overdue" : "Due"}
            </span>
            <span className="font-numeric text-[26px] leading-8 font-medium text-ink">{amount(invoice.total_minor)}</span>
          </div>
        </header>

        {late && (
          <p className="mt-6 rounded-sm border border-border bg-surface-sunken px-3 py-2 text-[13px] text-text-secondary">
            This invoice was due {daysLate === 1 ? "1 day" : `${daysLate} days`} ago.
          </p>
        )}

        <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border-subtle pt-6 text-[13px]">
          <div className="flex flex-col gap-0.5">
            <dt className="text-text-tertiary">Billed to</dt>
            <dd className="text-text-primary">{invoice.customer_name}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-text-tertiary">Issued</dt>
            <dd className="font-numeric text-text-primary">{formatDate(invoice.issue_date)}</dd>
          </div>
          {invoice.due_date && (
            <div className="flex flex-col gap-0.5">
              <dt className="text-text-tertiary">Due</dt>
              <dd className={cn("font-numeric", late ? "text-warning" : "text-text-primary")}>{formatDate(invoice.due_date)}</dd>
            </div>
          )}
        </dl>

        <table className="mt-8 w-full border-t border-border-subtle text-[13px]">
          <thead>
            <tr className="text-text-tertiary">
              <th className="py-2 text-left font-normal">Description</th>
              <th className="py-2 text-right font-normal">Qty</th>
              <th className="py-2 text-right font-normal">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lineItems.map((item, i) => (
              <tr key={`${item.description}-${i}`} className="border-t border-border-subtle">
                <td className="py-2.5 text-text-primary">{item.description}</td>
                <td className="py-2.5 text-right font-numeric text-text-secondary">{item.quantity}</td>
                <td className="py-2.5 text-right font-numeric text-text-primary">{amount(item.amount_minor)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border-subtle">
              <td colSpan={2} className="py-2 text-right text-text-secondary">
                Subtotal
              </td>
              <td className="py-2 text-right font-numeric text-text-primary">{amount(invoice.subtotal_minor)}</td>
            </tr>
            <tr>
              <td colSpan={2} className="py-2 text-right text-text-secondary">
                Tax
              </td>
              <td className="py-2 text-right font-numeric text-text-primary">{amount(invoice.tax_minor)}</td>
            </tr>
            <tr className="border-t border-border">
              <td colSpan={2} className="py-2.5 text-right font-medium text-ink">
                Total
              </td>
              <td className="py-2.5 text-right font-numeric font-medium text-ink">{amount(invoice.total_minor)}</td>
            </tr>
          </tfoot>
        </table>

        {invoice.notes && <p className="mt-8 border-t border-border-subtle pt-6 text-[13px] leading-[1.6] text-text-secondary">{invoice.notes}</p>}

        {/* A pay button appears ONLY when a payment provider really issued a
            link. There is no placeholder that leads nowhere — a customer
            clicking "Pay" and landing on an error is worse than being told
            plainly how to pay. */}
        {invoice.payment_url && state !== "paid" && state !== "void" && (
          <a
            href={invoice.payment_url}
            className="mt-8 inline-flex h-10 items-center justify-center rounded-md bg-gold px-5 text-[14px] font-medium text-accent-contrast transition-colors duration-[var(--duration-fast)] ease-out hover:bg-gold-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Pay invoice
          </a>
        )}
      </article>

      <p className="text-center text-[12px] text-text-tertiary">
        Sent by {invoice.organization_name} using Countorra. Questions about this invoice go to {invoice.organization_name}.
      </p>
    </main>
  );
}
