import type { InvoiceStatus } from "@/types/database";

/**
 * The invoice state machine, in one place.
 *
 * Before this, `updateInvoiceStatusAction` accepted any status the caller
 * named and wrote it. That let a paid invoice go back to draft, a voided one
 * be marked paid, and an unsent draft be marked paid without ever reaching
 * the customer — each of which is a false statement about money that someone
 * does or does not owe.
 *
 * OVERDUE IS NOT A STORED STATE
 *
 * `invoice_status` has an 'overdue' value and nothing writes it. "Overdue"
 * is a function of the due date and today's date, so storing it would need a
 * scheduled job to keep it true — and this project has no scheduler. A
 * stored 'overdue' that nothing refreshes is worse than none: it is wrong on
 * the day the customer pays, and wrong again on the day it lapses.
 *
 * So the stored status stays what a HUMAN decided (draft/sent/paid/void),
 * and `deriveInvoiceState` computes what is TRUE right now. Every read path
 * goes through it, so the list, the detail page, the customer-facing page
 * and the email all agree without a job running anywhere.
 */

/** What a human can set. `overdue` is deliberately absent — see above. */
export type StoredInvoiceStatus = Extract<InvoiceStatus, "draft" | "sent" | "paid" | "void">;

/** What a reader is shown, which adds the derived state. */
export type DerivedInvoiceState = StoredInvoiceStatus | "overdue";

const TRANSITIONS: Record<StoredInvoiceStatus, readonly StoredInvoiceStatus[]> = {
  // A draft has not been sent. It can go out, or be abandoned.
  draft: ["sent", "void"],
  // Once a customer has it, it is settled or cancelled. It can NEVER return
  // to draft: the customer is holding a copy, and editing it afterwards
  // would make their copy and ours disagree about what is owed.
  sent: ["paid", "void"],
  // Both terminal. Money that arrived does not un-arrive, and a voided
  // invoice is cancelled rather than paused.
  paid: [],
  void: [],
};

export function canTransition(from: StoredInvoiceStatus, to: StoredInvoiceStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function allowedTransitions(from: StoredInvoiceStatus): readonly StoredInvoiceStatus[] {
  return TRANSITIONS[from] ?? [];
}

/** A status a human may set, as opposed to the derived `overdue`. */
export function isStoredStatus(value: unknown): value is StoredInvoiceStatus {
  return value === "draft" || value === "sent" || value === "paid" || value === "void";
}

/** Terminal states accept no further change. */
export function isSettled(status: StoredInvoiceStatus): boolean {
  return status === "paid" || status === "void";
}

/**
 * What the invoice IS today.
 *
 * Compared as calendar dates in UTC, not as instants. A due date is a day,
 * not a moment: comparing it against `Date.now()` makes an invoice due
 * "today" overdue for anyone west of UTC, which is a real complaint from a
 * real customer.
 */
export function deriveInvoiceState(
  invoice: { status: StoredInvoiceStatus; dueDate: string | null },
  today: Date = new Date(),
): DerivedInvoiceState {
  if (invoice.status !== "sent" || !invoice.dueDate) return invoice.status;

  const todayIso = today.toISOString().slice(0, 10);
  // Due ON a date means due at the end of it — an invoice due today is not
  // yet late.
  return invoice.dueDate < todayIso ? "overdue" : "sent";
}

/** Whole days past due; 0 when not overdue. For reminder copy and sorting. */
export function daysOverdue(dueDate: string | null, today: Date = new Date()): number {
  if (!dueDate) return 0;
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const now = Date.parse(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(due) || now <= due) return 0;
  return Math.floor((now - due) / 86_400_000);
}

/**
 * Whether this invoice is one a customer may be chased about.
 *
 * A draft was never sent, and paid/void are settled. Chasing either is the
 * kind of mistake that costs a customer relationship.
 */
export function isRemindable(invoice: { status: StoredInvoiceStatus }): boolean {
  return invoice.status === "sent";
}

/** The due date implied by an issue date and net terms. */
export function dueDateFrom(issueDate: string, netDays: number): string {
  const issued = new Date(`${issueDate}T00:00:00Z`);
  issued.setUTCDate(issued.getUTCDate() + netDays);
  return issued.toISOString().slice(0, 10);
}
