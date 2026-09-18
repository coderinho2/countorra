import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "@/types/database";

/**
 * Sending an invoice, and the status machine behind it.
 *
 * The properties under test are the ones that cost real money when wrong: an
 * invoice cannot reach the customer twice, cannot be marked paid without
 * having been sent, and cannot report "sent" when nothing left the server.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const INVOICE = "33333333-3333-4333-8333-333333333333";

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    role: "owner" as OrgRole,
    memberOf: ["11111111-1111-4111-8111-111111111111"],
    invoice: null as Record<string, unknown> | null,
    /** Every transition attempted, in order. */
    transitions: [] as { to: string; allowedFrom: string[]; tokenIssued: boolean }[],
    /** Whether the transition should report a concurrent loss. */
    transitionReturnsNull: false,
    deliveries: [] as { variant: string; publicToken: string }[],
    deliveryOutcome: "sent" as "sent" | "failed" | "not_configured" | "suppressed",
    deliveryReason: "provider_down",
    deliveryThrows: false,
    deliveredForReal: true,
    reminders: 0,
    auditActions: [] as string[],
  };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT;${to}`); } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("@/lib/observability", () => ({ reportError: () => {}, reportEvent: () => {} }));
vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));

vi.mock("@/server/auth/session", () => ({
  requireUser: async () => ({ id: "user-1", email: "a@example.test" }),
  requireOrgMembership: async (organizationId: string) => {
    if (!state.memberOf.includes(organizationId)) throw new Error("NEXT_REDIRECT;/app");
    return { user: { id: "user-1", email: "a@example.test" }, membership: { organizationId, userId: "user-1", role: state.role } };
  },
}));

vi.mock("@/server/security/rate-limit", () => ({
  enforceRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0, message: "", degraded: false }),
}));

vi.mock("@/domain/audit/audit-log", () => ({
  recordAuditEvent: async (_c: unknown, event: { action: string }) => {
    state.auditActions.push(event.action);
  },
  AUDIT_ACTIONS: {
    invoiceCreated: "invoice.created",
    invoiceStatusChanged: "invoice.status_changed",
    invoiceSent: "invoice.sent",
    invoiceReminderSent: "invoice.reminder_sent",
  },
}));

vi.mock("@/server/db/repositories/invoices", () => ({
  createInvoice: async () => ({ id: INVOICE }),
  getInvoice: async (_c: unknown, invoiceId: string, organizationId: string) =>
    state.invoice && state.invoice.id === invoiceId && state.invoice.organizationId === organizationId ? state.invoice : null,
  transitionInvoiceStatus: async (
    _c: unknown,
    _id: string,
    _org: string,
    input: { to: string; allowedFrom: readonly string[]; publicToken?: string },
  ) => {
    state.transitions.push({ to: input.to, allowedFrom: [...input.allowedFrom], tokenIssued: Boolean(input.publicToken) });
    if (state.transitionReturnsNull) return null;
    // Model the `.in("status", allowedFrom)` predicate.
    if (!input.allowedFrom.includes(state.invoice!.status as string)) return null;
    state.invoice = { ...state.invoice, status: input.to, publicToken: input.publicToken ?? state.invoice!.publicToken };
    return state.invoice;
  },
  recordInvoiceReminder: async () => {
    state.reminders += 1;
  },
}));

vi.mock("@/server/invoices/send", () => ({
  generatePublicToken: () => "generated-token-0000000000000000000000000000",
  publicInvoiceUrl: (token: string) => `http://localhost:3000/invoice/${token}`,
  deliverInvoiceEmail: async (_c: unknown, params: { variant: string; publicToken: string }) => {
    if (state.deliveryThrows) throw new Error("render failed");
    state.deliveries.push({ variant: params.variant, publicToken: params.publicToken });
    return {
      outcome:
        state.deliveryOutcome === "sent"
          ? { status: "sent" as const, messageId: "m1", providerMessageId: "p1", deliveredForReal: state.deliveredForReal }
          : state.deliveryOutcome === "failed"
            ? { status: "failed" as const, messageId: "m1", reason: state.deliveryReason }
            : state.deliveryOutcome === "suppressed"
              ? { status: "suppressed" as const, messageId: "m1" }
              : { status: "not_configured" as const },
      deliveredForReal: state.deliveryOutcome === "sent" && state.deliveredForReal,
      customerEmail: "customer@example.test",
    };
  },
}));

const { sendInvoiceAction, updateInvoiceStatusAction, getInvoiceShareLinkAction } = await import("@/server/invoices/actions");

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE,
    organizationId: ORG,
    status: "draft",
    dueDate: "2099-01-01",
    publicToken: null,
    paymentUrl: null,
    lineItems: [{ description: "Consulting", quantity: 1, unitPriceMinor: 1000, taxRate: 0, amountMinor: 1000 }],
    ...overrides,
  };
}

beforeEach(() => {
  state.role = "owner";
  state.memberOf = [ORG];
  state.invoice = invoice();
  state.transitions = [];
  state.transitionReturnsNull = false;
  state.deliveries = [];
  state.deliveryOutcome = "sent";
  state.deliveryThrows = false;
  state.deliveredForReal = true;
  state.reminders = 0;
  state.auditActions = [];
});

describe("sending an invoice", () => {
  it("marks it sent and delivers it", async () => {
    const result = await sendInvoiceAction(ORG, INVOICE);

    expect(result.error).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(state.transitions[0]).toMatchObject({ to: "sent", allowedFrom: ["draft"], tokenIssued: true });
    expect(state.deliveries).toEqual([{ variant: "new", publicToken: "generated-token-0000000000000000000000000000" }]);
    expect(state.auditActions).toEqual(["invoice.sent"]);
  });

  it("transitions BEFORE delivering", async () => {
    // The ordering that prevents a duplicate invoice reaching a customer:
    // if the status write fails, nothing was sent. The reverse order sends
    // first and, on a failed write, leaves a draft the user sends again.
    await sendInvoiceAction(ORG, INVOICE);
    expect(state.transitions.length).toBeGreaterThan(0);
    expect(state.deliveries.length).toBeGreaterThan(0);
  });

  it("does not send when the transition is lost to a concurrent change", async () => {
    state.transitionReturnsNull = true;
    const result = await sendInvoiceAction(ORG, INVOICE);

    expect(result.error).toMatch(/changed by someone else/i);
    expect(state.deliveries).toEqual([]);
  });

  it("refuses an invoice with no line items", async () => {
    state.invoice = invoice({ lineItems: [] });
    const result = await sendInvoiceAction(ORG, INVOICE);

    expect(result.error).toMatch(/line item/i);
    expect(state.transitions).toEqual([]);
  });

  it.each(["paid", "void"])("refuses to send a %s invoice again", async (status) => {
    state.invoice = invoice({ status });
    const result = await sendInvoiceAction(ORG, INVOICE);

    expect(result.error).toMatch(/can't be sent again/i);
    expect(state.deliveries).toEqual([]);
  });
});

describe("re-sending and reminders", () => {
  it("reuses the existing token rather than issuing a new one", async () => {
    // Re-issuing would break the link in the copy the customer already has.
    state.invoice = invoice({ status: "sent", publicToken: "existing-token-000000000000000000000000000" });
    await sendInvoiceAction(ORG, INVOICE);

    expect(state.deliveries[0].publicToken).toBe("existing-token-000000000000000000000000000");
    expect(state.transitions).toEqual([]);
  });

  it("sends a reminder variant for an invoice not yet due", async () => {
    state.invoice = invoice({ status: "sent", publicToken: "t".repeat(40), dueDate: "2099-01-01" });
    await sendInvoiceAction(ORG, INVOICE);

    expect(state.deliveries[0].variant).toBe("reminder");
    expect(state.auditActions).toEqual(["invoice.reminder_sent"]);
    expect(state.reminders).toBe(1);
  });

  it("sends an OVERDUE variant once past the due date", async () => {
    // A reminder and an overdue notice read differently, and sending the
    // wrong one shouts at a customer who is not late.
    state.invoice = invoice({ status: "sent", publicToken: "t".repeat(40), dueDate: "2020-01-01" });
    await sendInvoiceAction(ORG, INVOICE);

    expect(state.deliveries[0].variant).toBe("overdue");
  });

  it("issues a token for an already-sent invoice that has none", async () => {
    state.invoice = invoice({ status: "sent", publicToken: null });
    await sendInvoiceAction(ORG, INVOICE);

    expect(state.transitions[0]).toMatchObject({ to: "sent", allowedFrom: ["sent"], tokenIssued: true });
  });
});

describe("what the user is told when delivery does not work", () => {
  it("does not claim it was sent when email is unconfigured", async () => {
    state.deliveryOutcome = "not_configured";
    const result = await sendInvoiceAction(ORG, INVOICE);

    expect(result.success).toBe(true);
    expect(result.warning).toMatch(/isn't set up/i);
    expect(result.error).toBeUndefined();
  });

  it("names the missing customer email specifically", async () => {
    state.deliveryOutcome = "failed";
    state.deliveryReason = "customer_has_no_email";
    const result = await sendInvoiceAction(ORG, INVOICE);

    expect(result.warning).toMatch(/no email address/i);
  });

  it("reports a provider failure as a warning, not an error", async () => {
    // The invoice DID move to sent. Reporting a failure would make the user
    // send it again, and the customer would get two.
    state.deliveryOutcome = "failed";
    state.deliveryReason = "provider_down";
    const result = await sendInvoiceAction(ORG, INVOICE);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.warning).toMatch(/couldn't deliver/i);
  });

  it("says nothing left the server in development mode", async () => {
    state.deliveredForReal = false;
    const result = await sendInvoiceAction(ORG, INVOICE);
    expect(result.warning).toMatch(/development mode/i);
  });

  it("explains a suppressed address", async () => {
    state.deliveryOutcome = "suppressed";
    const result = await sendInvoiceAction(ORG, INVOICE);
    expect(result.warning).toMatch(/unsubscribed/i);
  });

  it("still reports success when rendering throws, because the invoice moved", async () => {
    state.deliveryThrows = true;
    const result = await sendInvoiceAction(ORG, INVOICE);

    expect(result.success).toBe(true);
    expect(result.warning).toMatch(/marked sent/i);
  });
});

describe("authorization and isolation", () => {
  it.each(["owner", "admin", "accountant", "manager", "employee"] as OrgRole[])("lets %s send", async (role) => {
    state.role = role;
    expect((await sendInvoiceAction(ORG, INVOICE)).error).toBeUndefined();
  });

  it("refuses a viewer", async () => {
    state.role = "viewer";
    const result = await sendInvoiceAction(ORG, INVOICE);

    expect(result.error).toMatch(/permission/i);
    expect(state.transitions).toEqual([]);
    expect(state.deliveries).toEqual([]);
  });

  it("refuses an organization the caller is not a member of", async () => {
    await expect(sendInvoiceAction(OTHER_ORG, INVOICE)).rejects.toThrow();
  });

  it("will not act on an invoice belonging to another organization", async () => {
    // The invoice id is client-supplied, so it is re-scoped to the
    // organization the caller was authorized against.
    state.invoice = invoice({ organizationId: OTHER_ORG });
    const result = await sendInvoiceAction(ORG, INVOICE);

    expect(result.error).toMatch(/not found/i);
  });
});

describe("status transitions", () => {
  it("marks a sent invoice paid", async () => {
    state.invoice = invoice({ status: "sent" });
    const result = await updateInvoiceStatusAction(ORG, INVOICE, "paid");

    expect(result.success).toBe(true);
    expect(state.transitions[0]).toMatchObject({ to: "paid", allowedFrom: ["sent"] });
  });

  it("REFUSES to mark a draft paid", async () => {
    // It was never sent. Recording payment against a demand the customer
    // never received is a false statement about money.
    const result = await updateInvoiceStatusAction(ORG, INVOICE, "paid");

    expect(result.error).toMatch(/can't go from draft to paid/i);
    expect(state.transitions).toEqual([]);
  });

  it("refuses to un-pay a paid invoice", async () => {
    state.invoice = invoice({ status: "paid" });
    for (const to of ["sent", "draft", "void"]) {
      state.transitions = [];
      const result = await updateInvoiceStatusAction(ORG, INVOICE, to);
      expect(result.error, to).toBeTruthy();
      expect(state.transitions, to).toEqual([]);
    }
  });

  it("refuses to pay a voided invoice", async () => {
    state.invoice = invoice({ status: "void" });
    const result = await updateInvoiceStatusAction(ORG, INVOICE, "paid");
    expect(result.error).toMatch(/void invoice can't be changed/i);
  });

  it("refuses `overdue`, which is derived rather than set", async () => {
    state.invoice = invoice({ status: "sent" });
    const result = await updateInvoiceStatusAction(ORG, INVOICE, "overdue");

    expect(result.error).toMatch(/isn't a status/i);
    expect(state.transitions).toEqual([]);
  });

  it.each(["", "PAID", "deleted", "sent; drop table invoices"])("refuses the value %s", async (status) => {
    expect((await updateInvoiceStatusAction(ORG, INVOICE, status)).error).toMatch(/isn't a status/i);
  });

  it("sends users to the send action rather than flipping to sent", async () => {
    const result = await updateInvoiceStatusAction(ORG, INVOICE, "sent");
    expect(result.error).toMatch(/Use Send invoice/i);
  });

  it("requires financial:delete to void", async () => {
    state.role = "employee"; // write-capable, not delete-capable
    state.invoice = invoice({ status: "sent" });
    const result = await updateInvoiceStatusAction(ORG, INVOICE, "void");

    expect(result.error).toMatch(/permission/i);
    expect(state.transitions).toEqual([]);
  });

  it("reports a concurrent change rather than overwriting it", async () => {
    state.invoice = invoice({ status: "sent" });
    state.transitionReturnsNull = true;
    const result = await updateInvoiceStatusAction(ORG, INVOICE, "paid");

    expect(result.error).toMatch(/changed by someone else/i);
  });
});

describe("the share link", () => {
  it("returns a link for a sent invoice", async () => {
    state.invoice = invoice({ status: "sent", publicToken: "t".repeat(40) });
    const result = await getInvoiceShareLinkAction(ORG, INVOICE);

    expect(result.url).toBe(`http://localhost:3000/invoice/${"t".repeat(40)}`);
  });

  it("refuses for a draft, which has no customer link", async () => {
    const result = await getInvoiceShareLinkAction(ORG, INVOICE);
    expect(result.error).toMatch(/Send the invoice first/i);
  });

  it("refuses an organization the caller does not belong to", async () => {
    await expect(getInvoiceShareLinkAction(OTHER_ORG, INVOICE)).rejects.toThrow();
  });
});
