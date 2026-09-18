import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { type CurrencyCode, toMajorUnits } from "@/domain/money/money";
import { calculateInvoiceTotals, type LineItemInput } from "@/domain/invoicing/invoice-calculations";
import type { StoredInvoiceStatus } from "@/domain/invoicing/lifecycle";

type Client = SupabaseClient<Database>;
type InvoiceRow = Database["public"]["Tables"]["invoices"]["Row"];
type InvoiceLineItemRow = Database["public"]["Tables"]["invoice_line_items"]["Row"];

export interface InvoiceLineItem {
  id: string;
  description: string;
  quantity: number;
  unitPriceMinor: number;
  taxRate: number;
  discountRate: number;
  amountMinor: number;
}

export interface Invoice {
  id: string;
  organizationId: string;
  customerId: string;
  invoiceNumber: string;
  status: InvoiceRow["status"];
  currency: string;
  issueDate: string;
  dueDate: string | null;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  notes: string | null;
  createdAt: string;
  // ── Added by 0037_invoice_delivery_and_recurrence.sql ──
  sentAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  lastReminderAt: string | null;
  /** Unguessable capability for the customer-facing view; null until sent. */
  publicToken: string | null;
  /** A real provider-issued link, or null. Never a placeholder. */
  paymentUrl: string | null;
  recurrenceId: string | null;
}

function toInvoice(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    organizationId: row.organization_id,
    customerId: row.customer_id,
    invoiceNumber: row.invoice_number,
    status: row.status,
    currency: row.currency,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    subtotalMinor: row.subtotal_minor,
    taxMinor: row.tax_minor,
    totalMinor: row.total_minor,
    notes: row.notes,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    paidAt: row.paid_at,
    voidedAt: row.voided_at,
    lastReminderAt: row.last_reminder_at,
    publicToken: row.public_token,
    paymentUrl: row.payment_url,
    recurrenceId: row.recurrence_id,
  };
}

function toLineItem(row: InvoiceLineItemRow): InvoiceLineItem {
  return {
    id: row.id,
    description: row.description,
    quantity: row.quantity,
    unitPriceMinor: row.unit_price_minor,
    taxRate: row.tax_rate,
    discountRate: row.discount_rate,
    amountMinor: row.amount_minor,
  };
}

export interface InvoiceFilters {
  organizationId: string;
  status?: InvoiceRow["status"];
  customerId?: string;
  overdueOnly?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listInvoices(
  client: Client,
  filters: InvoiceFilters,
): Promise<{ invoices: Invoice[]; total: number }> {
  const page = filters.page ?? 1;
  const pageSize = Math.min(filters.pageSize ?? 50, 200);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = client.from("invoices").select("*", { count: "exact" }).eq("organization_id", filters.organizationId);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.customerId) query = query.eq("customer_id", filters.customerId);
  if (filters.overdueOnly) {
    query = query.lt("due_date", new Date().toISOString().slice(0, 10)).in("status", ["sent", "overdue"]);
  }
  if (filters.search) {
    const escaped = filters.search.replace(/[%_]/g, (c) => `\\${c}`);
    query = query.ilike("invoice_number", `%${escaped}%`);
  }

  const { data, error, count } = await query.order("issue_date", { ascending: false }).range(from, to);
  if (error) throw error;
  return { invoices: data.map(toInvoice), total: count ?? 0 };
}

export async function getInvoice(
  client: Client,
  invoiceId: string,
  organizationId: string,
): Promise<(Invoice & { lineItems: InvoiceLineItem[] }) | null> {
  const [invoiceResult, lineItemsResult] = await Promise.all([
    client.from("invoices").select("*").eq("id", invoiceId).eq("organization_id", organizationId).maybeSingle(),
    client.from("invoice_line_items").select("*").eq("invoice_id", invoiceId).order("position"),
  ]);
  if (invoiceResult.error) throw invoiceResult.error;
  if (lineItemsResult.error) throw lineItemsResult.error;
  if (!invoiceResult.data) return null;

  return { ...toInvoice(invoiceResult.data), lineItems: lineItemsResult.data.map(toLineItem) };
}

export interface CreateInvoiceInput {
  organizationId: string;
  customerId: string;
  invoiceNumber: string;
  currency: CurrencyCode;
  issueDate: string;
  dueDate?: string | null;
  notes?: string | null;
  status?: InvoiceRow["status"];
  createdBy: string;
  lineItems: (LineItemInput & { description: string })[];
}

/** Creates an invoice and its line items in one call. Totals are computed
 *  here from the line items (src/domain/invoicing), never accepted as
 *  client-supplied numbers — see the module comment in
 *  invoice-calculations.ts. Not wrapped in an explicit SQL transaction: if
 *  line-item insertion fails after the invoice insert succeeds, the
 *  invoice is left with zero line items rather than partially-committed
 *  ones, which is safe (visibly incomplete, not silently wrong) but not
 *  atomic — acceptable for Phase 2's scope; revisit with a
 *  `create_invoice_with_line_items` RPC if this needs hard atomicity. */
export async function createInvoice(client: Client, input: CreateInvoiceInput): Promise<Invoice & { lineItems: InvoiceLineItem[] }> {
  const totals = calculateInvoiceTotals(input.lineItems, input.currency);

  const { data: invoiceRow, error: invoiceError } = await client
    .from("invoices")
    .insert({
      organization_id: input.organizationId,
      customer_id: input.customerId,
      invoice_number: input.invoiceNumber,
      currency: input.currency,
      issue_date: input.issueDate,
      due_date: input.dueDate ?? null,
      notes: input.notes ?? null,
      status: input.status ?? "draft",
      subtotal_minor: totals.subtotal.amountMinor,
      tax_minor: totals.tax.amountMinor,
      total_minor: totals.total.amountMinor,
      created_by: input.createdBy,
    })
    .select("*")
    .single();
  if (invoiceError) throw invoiceError;

  if (input.lineItems.length > 0) {
    const rows = input.lineItems.map((item, position) => {
      const lineTotal = calculateInvoiceTotals([item], input.currency);
      return {
        invoice_id: invoiceRow.id,
        position,
        description: item.description,
        quantity: item.quantity,
        unit_price_minor: item.unitPriceMinor,
        tax_rate: item.taxRate,
        discount_rate: item.discountRate,
        amount_minor: lineTotal.subtotal.amountMinor,
      };
    });
    const { error: lineItemsError } = await client.from("invoice_line_items").insert(rows);
    if (lineItemsError) throw lineItemsError;
  }

  const created = await getInvoice(client, invoiceRow.id, input.organizationId);
  if (!created) throw new Error("Invoice creation succeeded but could not be re-read.");
  return created;
}

/**
 * Moves an invoice to a new status, ONLY from a status the state machine
 * allows it to leave.
 *
 * The `.in("status", ...)` predicate is what makes this safe under
 * concurrency: two people clicking "Mark paid" and "Void" at the same moment
 * both read `sent`, both issue an update, and exactly one matches a row. The
 * loser gets `null` and the caller reports the invoice has already moved,
 * rather than the second write silently overwriting the first.
 *
 * The old version took any status and wrote it unconditionally, which let a
 * paid invoice return to draft and a voided one be marked paid.
 */
export async function transitionInvoiceStatus(
  client: Client,
  invoiceId: string,
  organizationId: string,
  input: {
    to: StoredInvoiceStatus;
    allowedFrom: readonly StoredInvoiceStatus[];
    /** Timestamp columns that belong to this transition. */
    stamps?: Partial<Record<"sent_at" | "paid_at" | "voided_at", string>>;
    publicToken?: string;
  },
): Promise<Invoice | null> {
  const patch: Database["public"]["Tables"]["invoices"]["Update"] = { status: input.to, ...(input.stamps ?? {}) };
  if (input.publicToken) patch.public_token = input.publicToken;

  const { data, error } = await client
    .from("invoices")
    .update(patch)
    .eq("id", invoiceId)
    .eq("organization_id", organizationId)
    .in("status", [...input.allowedFrom])
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? toInvoice(data) : null;
}

/** Records that a reminder went out. Never changes the status — a reminder
 *  is a second delivery of an invoice that is already `sent`. */
export async function recordInvoiceReminder(client: Client, invoiceId: string, organizationId: string, at: string): Promise<void> {
  const { error } = await client
    .from("invoices")
    .update({ last_reminder_at: at })
    .eq("id", invoiceId)
    .eq("organization_id", organizationId);
  if (error) throw error;
}

/** Invoices that are past due and still open, for reminders and reporting. */
export async function listOverdueInvoices(client: Client, organizationId: string, asOf: string): Promise<Invoice[]> {
  const { data, error } = await client
    .from("invoices")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "sent")
    .lt("due_date", asOf)
    .order("due_date", { ascending: true });
  if (error) throw error;
  return data.map(toInvoice);
}

export function invoiceTotalMajor(invoice: Pick<Invoice, "totalMinor" | "currency">): number {
  return toMajorUnits({ amountMinor: invoice.totalMinor, currency: invoice.currency as CurrencyCode });
}
