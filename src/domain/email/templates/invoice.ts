import { format as formatMoney, money } from "@/domain/money/money";
import type { CurrencyCode } from "@/domain/money/currency";
import type { EmailMessage } from "../message";
import { renderButton, renderFactRow, renderFactTable, renderHeading, renderLayout, renderParagraph } from "../layout";

/**
 * The invoice email.
 *
 * Pure: takes primitives, returns a message. No database types, no client,
 * no network — so every amount, subject line and escaping rule is testable
 * without sending anything.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not compute a total. `totalMinor` arrives already computed by
 * `calculateInvoiceTotals`, which is the only place invoice arithmetic
 * happens. A template that added up line items would be a second, unverified
 * implementation of the number the customer is being asked to pay.
 */

export interface InvoiceEmailInput {
  invoiceNumber: string;
  organizationName: string;
  customerName: string;
  customerEmail: string;
  currency: CurrencyCode;
  totalMinor: number;
  issueDate: string;
  dueDate: string | null;
  notes: string | null;
  /** Public, token-bearing URL. Server-built; the template never composes it. */
  viewUrl: string;
  /** Present only when a payment provider is connected. */
  payUrl?: string | null;
  attachmentPdfBase64?: string;
  /** A reminder reads differently from a first send, and pretending
   *  otherwise is how customers get shouted at for an invoice they never
   *  received. */
  variant?: "new" | "reminder" | "overdue";
}

function formatDate(iso: string): string {
  // Fixed locale and UTC. A due date is a calendar date, not an instant —
  // rendering it in the server's zone can shift it by a day.
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function renderInvoiceEmail(input: InvoiceEmailInput): EmailMessage {
  const variant = input.variant ?? "new";
  const total = formatMoney(money(input.totalMinor, input.currency));

  const subject =
    variant === "overdue"
      ? `Overdue: invoice ${input.invoiceNumber} from ${input.organizationName}`
      : variant === "reminder"
        ? `Reminder: invoice ${input.invoiceNumber} from ${input.organizationName}`
        : `Invoice ${input.invoiceNumber} from ${input.organizationName}`;

  const opening =
    variant === "overdue"
      ? `This invoice was due on ${input.dueDate ? formatDate(input.dueDate) : "an earlier date"} and is still showing as unpaid.`
      : variant === "reminder"
        ? `A reminder that this invoice is still open.`
        : `${input.organizationName} has sent you an invoice.`;

  const rows = [
    renderFactRow("Invoice", input.invoiceNumber),
    renderFactRow("From", input.organizationName),
    renderFactRow("Issued", formatDate(input.issueDate)),
    ...(input.dueDate ? [renderFactRow("Due", formatDate(input.dueDate))] : []),
    renderFactRow("Amount due", total, true),
  ];

  const bodyHtml = [
    renderHeading(variant === "overdue" ? "Invoice overdue" : "Invoice"),
    renderParagraph(`Hello ${input.customerName},`),
    renderParagraph(opening),
    renderFactTable(rows),
    // The pay button appears ONLY when the server passed a real URL. There
    // is no placeholder "Pay now" that goes nowhere — a payment button that
    // cannot take a payment is worse than no button.
    input.payUrl ? renderButton("Pay invoice", input.payUrl) : renderButton("View invoice", input.viewUrl),
    input.payUrl ? renderParagraph(`Or view the invoice: ${input.viewUrl}`) : "",
    input.notes ? renderParagraph(input.notes) : "",
  ]
    .filter(Boolean)
    .join("\n");

  const text = [
    `${subject}`,
    "",
    `Hello ${input.customerName},`,
    "",
    opening,
    "",
    `Invoice:    ${input.invoiceNumber}`,
    `From:       ${input.organizationName}`,
    `Issued:     ${formatDate(input.issueDate)}`,
    ...(input.dueDate ? [`Due:        ${formatDate(input.dueDate)}`] : []),
    `Amount due: ${total}`,
    "",
    input.payUrl ? `Pay: ${input.payUrl}` : "",
    `View: ${input.viewUrl}`,
    input.notes ? `\n${input.notes}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  return {
    to: { address: input.customerEmail, name: input.customerName },
    subject,
    html: renderLayout({
      preheader: `${total} due${input.dueDate ? ` by ${formatDate(input.dueDate)}` : ""}`,
      bodyHtml,
      footerNote: `Sent by ${input.organizationName} using Countorra.`,
    }),
    text,
    // Transactional, always. An invoice is the direct consequence of a
    // business relationship the recipient is part of, and a suppression list
    // must never stop someone being told they are owed money.
    category: "transactional",
    attachments: input.attachmentPdfBase64
      ? [{ filename: `invoice-${input.invoiceNumber}.pdf`, content: input.attachmentPdfBase64, contentType: "application/pdf" }]
      : undefined,
  };
}
