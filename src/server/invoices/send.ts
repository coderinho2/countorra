import "server-only";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { publicEnv } from "@/lib/env";
import { renderInvoicePdf } from "@/domain/invoicing/pdf";
import { renderInvoiceEmail } from "@/domain/email/templates/invoice";
import { deriveInvoiceState, type StoredInvoiceStatus } from "@/domain/invoicing/lifecycle";
import type { CurrencyCode } from "@/domain/money/currency";
import { getInvoice } from "@/server/db/repositories/invoices";
import { getCustomer } from "@/server/db/repositories/customers";
import { getOrganization } from "@/server/db/repositories/organizations";
import { sendEmail, type EmailSendOutcome } from "@/server/email/send";

type Client = SupabaseClient<Database>;

/**
 * Rendering and delivering one invoice, shared by the first send and every
 * reminder.
 *
 * Kept out of `actions.ts` so that the action is authorization and state
 * transition, and this is composition and delivery. They fail differently
 * and are worth reading separately.
 */

/**
 * 32 random bytes, base64url.
 *
 * NOT the invoice's uuid. A uuid is an identifier: it appears in URLs, logs,
 * error messages and support tickets, and every one of those places would
 * become a disclosure if the same value also granted access. A capability
 * has to be generated as a secret and treated as one.
 */
export function generatePublicToken(): string {
  return randomBytes(32).toString("base64url");
}

export function publicInvoiceUrl(token: string): string {
  // From the canonical app URL, which a deployment cannot leave pointing at
  // localhost (src/lib/env.ts). Never from a request header.
  return `${publicEnv.NEXT_PUBLIC_APP_URL}/invoice/${token}`;
}

export interface DeliverInvoiceResult {
  outcome: EmailSendOutcome;
  /** False when the configured provider does not actually deliver (the
   *  console provider in development). The UI must not claim a customer
   *  received something that went to a log. */
  deliveredForReal: boolean;
  customerEmail: string | null;
}

/**
 * Renders the PDF and email for an invoice and hands them to the email
 * layer.
 *
 * Does NOT transition the invoice or check permissions — the caller has
 * already done both. Returning the outcome rather than throwing means a
 * provider outage does not roll back a status change the user already saw.
 */
export async function deliverInvoiceEmail(
  client: Client,
  params: {
    organizationId: string;
    invoiceId: string;
    publicToken: string;
    variant: "new" | "reminder" | "overdue";
  },
): Promise<DeliverInvoiceResult> {
  const invoice = await getInvoice(client, params.invoiceId, params.organizationId);
  if (!invoice) throw new Error("Invoice not found.");

  const [organization, customer] = await Promise.all([
    getOrganization(client, params.organizationId),
    getCustomer(client, invoice.customerId),
  ]);
  if (!organization) throw new Error("Organization not found.");
  // Belt and braces on top of RLS: the invoice was already scoped to this
  // organization, and the customer it names must belong to the same one.
  if (!customer || customer.organizationId !== params.organizationId) throw new Error("Customer not found.");

  if (!customer.email) {
    return { outcome: { status: "failed", messageId: null, reason: "customer_has_no_email" }, deliveredForReal: false, customerEmail: null };
  }

  const currency = invoice.currency as CurrencyCode;
  const state = deriveInvoiceState({ status: invoice.status as StoredInvoiceStatus, dueDate: invoice.dueDate });

  const pdf = renderInvoicePdf({
    invoiceNumber: invoice.invoiceNumber,
    organizationName: organization.name,
    customerName: customer.displayName,
    customerEmail: customer.email,
    currency,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    lineItems: invoice.lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      taxRate: item.taxRate,
      amountMinor: item.amountMinor,
    })),
    // Totals come from the stored columns, which `createInvoice` computed
    // with `calculateInvoiceTotals`. Nothing here re-adds them up: a second
    // implementation of the amount owed is how two documents disagree.
    subtotalMinor: invoice.subtotalMinor,
    taxMinor: invoice.taxMinor,
    totalMinor: invoice.totalMinor,
    notes: invoice.notes,
    state,
  });

  const message = renderInvoiceEmail({
    invoiceNumber: invoice.invoiceNumber,
    organizationName: organization.name,
    customerName: customer.displayName,
    customerEmail: customer.email,
    currency,
    totalMinor: invoice.totalMinor,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    notes: invoice.notes,
    viewUrl: publicInvoiceUrl(params.publicToken),
    // Only ever a link a payment provider really issued. Stripe is not wired
    // to invoices yet, so this is null today and the email shows "View
    // invoice" instead of a dead "Pay" button.
    payUrl: invoice.paymentUrl,
    attachmentPdfBase64: Buffer.from(pdf).toString("base64"),
    variant: params.variant === "overdue" ? "overdue" : params.variant,
  });

  const outcome = await sendEmail({
    message,
    template: `invoice.${params.variant}`,
    organizationId: params.organizationId,
    resource: { type: "invoice", id: invoice.id },
  });

  return {
    outcome,
    deliveredForReal: outcome.status === "sent" && outcome.deliveredForReal,
    customerEmail: customer.email,
  };
}
