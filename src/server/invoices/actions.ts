"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { requireOrgMembership } from "@/server/auth/session";
import { can } from "@/domain/organizations/permissions";
import { createInvoice, getInvoice, recordInvoiceReminder, transitionInvoiceStatus } from "@/server/db/repositories/invoices";
import { recordAuditEvent, AUDIT_ACTIONS } from "@/domain/audit/audit-log";
import { createInvoiceSchema } from "@/validation/schemas/invoice";
import { fromMajorUnits } from "@/domain/money/money";
import type { CurrencyCode } from "@/domain/money/currency";
import { canTransition, deriveInvoiceState, isSettled, isStoredStatus, type StoredInvoiceStatus } from "@/domain/invoicing/lifecycle";
import { deliverInvoiceEmail, generatePublicToken, publicInvoiceUrl } from "./send";
import { reportError } from "@/lib/observability";
import { enforceRateLimit } from "@/server/security/rate-limit";

export interface InvoiceActionResult {
  error?: string;
  success?: boolean;
  /** The action succeeded, but something the user should know about did not.
   *  Distinct from `error` because the invoice DID move — reporting this as a
   *  failure is how someone sends the same invoice twice. */
  warning?: string;
}

export async function createInvoiceAction(_prev: InvoiceActionResult, formData: FormData): Promise<InvoiceActionResult> {
  const organizationId = formData.get("organizationId") as string;
  const lineItemsRaw = formData.get("lineItems") as string;

  let lineItems: unknown;
  try {
    lineItems = JSON.parse(lineItemsRaw);
  } catch {
    return { error: "Invalid line items." };
  }

  const parsed = createInvoiceSchema.safeParse({
    organizationId,
    customerId: formData.get("customerId"),
    currency: formData.get("currency"),
    issueDate: formData.get("issueDate"),
    dueDate: formData.get("dueDate") || undefined,
    notes: formData.get("notes") || undefined,
    lineItems,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { user, membership } = await requireOrgMembership(parsed.data.organizationId);
  if (!can(membership.role, "financial:write")) return { error: "You don't have permission to create invoices." };

  // Bounded after authorization, so the limiter is keyed on an identity that
  // has already been verified (rate-limit-policy.ts: recordMutationPerUser).
  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const client = await createClient();
  const invoiceNumber = `INV-${Date.now().toString(36).toUpperCase()}`;

  const invoice = await createInvoice(client, {
    organizationId: parsed.data.organizationId,
    customerId: parsed.data.customerId,
    invoiceNumber,
    currency: parsed.data.currency as CurrencyCode,
    issueDate: parsed.data.issueDate,
    dueDate: parsed.data.dueDate,
    notes: parsed.data.notes,
    status: "draft",
    createdBy: user.id,
    lineItems: parsed.data.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unitPriceMinor: fromMajorUnits(li.unitPrice, parsed.data.currency as CurrencyCode).amountMinor,
      taxRate: li.taxRate,
      discountRate: 0,
    })),
  });

  await recordAuditEvent(client, {
    organizationId: parsed.data.organizationId,
    action: AUDIT_ACTIONS.invoiceCreated,
    resourceType: "invoice",
    resourceId: invoice.id,
  });

  revalidatePath(`/app/${parsed.data.organizationId}/invoices`);
  redirect(`/app/${parsed.data.organizationId}/invoices/${invoice.id}`);
}

/**
 * Status changes, gated by the state machine rather than by the caller.
 *
 * The previous version took any `InvoiceStatus` and wrote it unconditionally.
 * That let a paid invoice return to draft, a voided one be marked paid, and a
 * draft the customer had never seen be marked paid. Those are not cosmetic
 * bugs — each is a false statement about whether someone owes money.
 */
export async function updateInvoiceStatusAction(organizationId: string, invoiceId: string, status: string): Promise<InvoiceActionResult> {
  // `overdue` is derived from the due date and is deliberately not settable;
  // see src/domain/invoicing/lifecycle.ts.
  if (!isStoredStatus(status)) return { error: "That isn't a status an invoice can be set to." };

  const { user, membership } = await requireOrgMembership(organizationId);
  const permission = status === "void" ? "financial:delete" : "financial:write";
  if (!can(membership.role, permission)) return { error: "You don't have permission to change this invoice's status." };

  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const client = await createClient();
  const invoice = await getInvoice(client, invoiceId, organizationId);
  if (!invoice) return { error: "Invoice not found." };

  const from = invoice.status as StoredInvoiceStatus;
  if (!canTransition(from, status)) return { error: describeRefusal(from, status) };

  // Sending is a delivery, not a status flip: it needs a customer email, a
  // rendered PDF and a share token. `sendInvoiceAction` owns that.
  if (status === "sent") return { error: "Use Send invoice to send this to the customer." };

  const now = new Date().toISOString();
  const updated = await transitionInvoiceStatus(client, invoiceId, organizationId, {
    to: status,
    allowedFrom: [from],
    stamps: status === "paid" ? { paid_at: now } : status === "void" ? { voided_at: now } : undefined,
  });

  // `null` means a concurrent change moved the invoice out from under this
  // request. Reporting it beats silently overwriting the other decision.
  if (!updated) return { error: "This invoice was changed by someone else. Reload and try again." };

  await recordAuditEvent(client, {
    organizationId,
    action: AUDIT_ACTIONS.invoiceStatusChanged,
    resourceType: "invoice",
    resourceId: invoiceId,
    metadata: { from, to: status },
  });

  revalidatePath(`/app/${organizationId}/invoices`);
  revalidatePath(`/app/${organizationId}/invoices/${invoiceId}`);
  return { success: true };
}

function describeRefusal(from: StoredInvoiceStatus, to: StoredInvoiceStatus): string {
  if (from === to) return `This invoice is already ${to}.`;
  if (isSettled(from)) return `A ${from} invoice can't be changed. Create a new invoice instead.`;
  return `An invoice can't go from ${from} to ${to}.`;
}

/**
 * Sends an invoice to its customer, and marks it sent.
 *
 * THE ORDER IS THE OPPOSITE OF THE OBVIOUS ONE, DELIBERATELY.
 *
 * The transition to `sent` happens FIRST, then the email. That reads
 * backwards — surely you send, then record? — until you compare the two
 * failure modes:
 *
 *   Email first: the customer receives the invoice, the status write then
 *   fails, and the app still shows a draft. The user sends again. The
 *   customer now holds two demands for the same money.
 *
 *   Status first: either the status write fails and nothing was sent (safe),
 *   or the invoice is `sent` and the email failed — which this reports as a
 *   warning, and re-sending is safe because the token is reused rather than
 *   re-issued.
 *
 * A duplicate invoice in a customer's inbox is worse than a state the user
 * has to retry, so the transition goes first.
 */
export async function sendInvoiceAction(organizationId: string, invoiceId: string): Promise<InvoiceActionResult> {
  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "financial:write")) return { error: "You don't have permission to send invoices." };

  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const client = await createClient();
  const invoice = await getInvoice(client, invoiceId, organizationId);
  if (!invoice) return { error: "Invoice not found." };

  const from = invoice.status as StoredInvoiceStatus;
  if (isSettled(from)) return { error: `A ${from} invoice can't be sent again.` };
  if (invoice.lineItems.length === 0) return { error: "Add at least one line item before sending." };

  // Issued once, then reused. Re-issuing on every send would break the link
  // in the copy the customer already has.
  const publicToken = invoice.publicToken ?? generatePublicToken();
  const isFirstSend = from === "draft";

  if (isFirstSend) {
    const updated = await transitionInvoiceStatus(client, invoiceId, organizationId, {
      to: "sent",
      allowedFrom: ["draft"],
      stamps: { sent_at: new Date().toISOString() },
      publicToken,
    });
    if (!updated) return { error: "This invoice was changed by someone else. Reload and try again." };
  } else if (!invoice.publicToken) {
    // Already sent, but with no token — an invoice from before this existed.
    // Give it one so the link in the email resolves.
    await transitionInvoiceStatus(client, invoiceId, organizationId, { to: "sent", allowedFrom: ["sent"], publicToken });
  }

  const variant = isFirstSend ? "new" : deriveInvoiceState({ status: from, dueDate: invoice.dueDate }) === "overdue" ? "overdue" : "reminder";

  let delivery;
  try {
    delivery = await deliverInvoiceEmail(client, { organizationId, invoiceId, publicToken, variant });
  } catch (error) {
    reportError(error, { scope: "route", organizationId, userId: user.id, detail: { step: "deliver_invoice" } });
    return { success: true, warning: "The invoice was marked sent, but we couldn't build the email. Try sending again." };
  }

  if (!isFirstSend) await recordInvoiceReminder(client, invoiceId, organizationId, new Date().toISOString());

  await recordAuditEvent(client, {
    organizationId,
    action: isFirstSend ? AUDIT_ACTIONS.invoiceSent : AUDIT_ACTIONS.invoiceReminderSent,
    resourceType: "invoice",
    resourceId: invoiceId,
    metadata: { outcome: delivery.outcome.status, deliveredForReal: delivery.deliveredForReal },
  });

  revalidatePath(`/app/${organizationId}/invoices`);
  revalidatePath(`/app/${organizationId}/invoices/${invoiceId}`);

  // Every branch below says what actually happened. "Sent" when nothing left
  // the server is the one answer this must never give.
  if (delivery.outcome.status === "not_configured") {
    return { success: true, warning: "Email isn't set up, so nothing was sent. The invoice is marked sent and its customer link is ready to share." };
  }
  if (delivery.outcome.status === "failed") {
    return {
      success: true,
      warning:
        delivery.outcome.reason === "customer_has_no_email"
          ? "This customer has no email address. Add one, then send again — or share the invoice link."
          : "We couldn't deliver the email. The invoice is marked sent — try again, or share the link.",
    };
  }
  if (delivery.outcome.status === "suppressed") {
    return { success: true, warning: "That address has unsubscribed, so the email was not sent. Share the invoice link instead." };
  }
  if (!delivery.deliveredForReal) {
    return { success: true, warning: "Email is in development mode, so nothing left this server." };
  }

  return { success: true };
}

/** The customer-facing link, for sharing by hand. */
export async function getInvoiceShareLinkAction(organizationId: string, invoiceId: string): Promise<{ url?: string; error?: string }> {
  const { membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "financial:read")) return { error: "You don't have permission to view this invoice." };

  const client = await createClient();
  const invoice = await getInvoice(client, invoiceId, organizationId);
  if (!invoice) return { error: "Invoice not found." };
  if (invoice.status === "draft") return { error: "Send the invoice first — a draft has no customer link." };

  let token = invoice.publicToken;
  if (!token) {
    token = generatePublicToken();
    const status = invoice.status as StoredInvoiceStatus;
    await transitionInvoiceStatus(client, invoiceId, organizationId, { to: status, allowedFrom: [status], publicToken: token });
  }

  return { url: publicInvoiceUrl(token) };
}
