import { describe, expect, it } from "vitest";
import { isDeliverableAddress, normalizeEmailAddress, respectsSuppression } from "./message";
import { escapeHtml } from "./layout";
import { renderInvoiceEmail } from "./templates/invoice";

describe("address handling", () => {
  it("lowercases and trims for comparison", () => {
    expect(normalizeEmailAddress("  Person@Example.TEST  ")).toBe("person@example.test");
  });

  it("does NOT fold gmail dots or plus-addresses", () => {
    // Same inbox at Gmail, different addresses almost everywhere else.
    // Folding them would suppress mail to someone who never unsubscribed.
    expect(normalizeEmailAddress("a.b@gmail.com")).toBe("a.b@gmail.com");
    expect(normalizeEmailAddress("a+tag@example.test")).toBe("a+tag@example.test");
  });

  it.each(["a@b.co", "first.last+tag@sub.example.co.uk", "x@y.travel"])("accepts %s", (address) => {
    expect(isDeliverableAddress(address)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "no-at-sign",
    "@example.test",
    "a@",
    "a@b",
    "a b@example.test",
    "a@exam ple.test",
    "a@.test",
    "a@test.",
    "a@-example.test",
    "a@example-.test",
    "a@exam..ple.test",
  ])("rejects %s", (address) => {
    expect(isDeliverableAddress(address)).toBe(false);
  });

  it("rejects an over-long address rather than handing it to a provider", () => {
    expect(isDeliverableAddress(`${"a".repeat(250)}@example.test`)).toBe(false);
    expect(isDeliverableAddress(`${"a".repeat(65)}@example.test`)).toBe(false);
  });
});

describe("suppression applies to one category only", () => {
  it("honours an unsubscribe for notifications", () => {
    expect(respectsSuppression("notification")).toBe(true);
  });

  it("IGNORES it for transactional mail", () => {
    // Withholding an invoice from someone who unsubscribed from digests
    // silently costs them money, and is the reason the exemption exists.
    expect(respectsSuppression("transactional")).toBe(false);
  });
});

describe("escapeHtml", () => {
  it("neutralises markup, which lands in someone else's mail client", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("escapes the ampersand first, so entities are not double-broken", () => {
    expect(escapeHtml("Tom & Jerry <b>")).toBe("Tom &amp; Jerry &lt;b&gt;");
  });
});

describe("the invoice email", () => {
  const base = {
    invoiceNumber: "INV-1001",
    organizationName: "Acme LLC",
    customerName: "Wile E. Coyote",
    customerEmail: "wile@example.test",
    currency: "USD" as const,
    totalMinor: 125_000,
    issueDate: "2026-09-01",
    dueDate: "2026-10-01",
    notes: null,
    viewUrl: "https://app.test/invoice/tok",
  };

  it("is always transactional, never a notification", () => {
    // The category that makes suppression not apply.
    expect(renderInvoiceEmail(base).category).toBe("transactional");
  });

  it("states the amount from the supplied total, formatted once", () => {
    const email = renderInvoiceEmail(base);
    expect(email.html).toContain("$1,250.00");
    expect(email.text).toContain("$1,250.00");
  });

  it("does not recompute the total", () => {
    // The template is handed a number that `calculateInvoiceTotals` already
    // produced. A second implementation here would let two documents
    // disagree about what is owed.
    expect(renderInvoiceEmail({ ...base, totalMinor: 1 }).html).toContain("$0.01");
  });

  it("always carries a plain-text part", () => {
    // Not politeness: an HTML-only message scores worse with spam filters
    // and is unreadable in a text client.
    expect(renderInvoiceEmail(base).text.length).toBeGreaterThan(50);
  });

  it("shows VIEW rather than PAY when no payment link exists", () => {
    // A "Pay" button that leads nowhere is worse than no button.
    const email = renderInvoiceEmail(base);
    expect(email.html).toContain("View invoice");
    expect(email.html).not.toContain("Pay invoice");
  });

  it("shows a pay button only when a real link is supplied", () => {
    const email = renderInvoiceEmail({ ...base, payUrl: "https://pay.test/abc" });
    expect(email.html).toContain("Pay invoice");
    expect(email.html).toContain("https://pay.test/abc");
  });

  it.each([
    ["new", /^Invoice INV-1001 from Acme LLC$/],
    ["reminder", /^Reminder: invoice INV-1001/],
    ["overdue", /^Overdue: invoice INV-1001/],
  ] as const)("uses a distinct subject for the %s variant", (variant, pattern) => {
    // Sending "Overdue" to someone who is not late is a real complaint.
    expect(renderInvoiceEmail({ ...base, variant }).subject).toMatch(pattern);
  });

  it("escapes a customer name containing markup", () => {
    const email = renderInvoiceEmail({ ...base, customerName: `<img src=x onerror="alert(1)">` });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img src=x");
  });

  it("renders the due date in UTC, so it cannot shift by a day", () => {
    const email = renderInvoiceEmail(base);
    expect(email.html).toContain("Oct 1, 2026");
  });

  it("handles an invoice with no due date", () => {
    const email = renderInvoiceEmail({ ...base, dueDate: null });
    expect(email.html).not.toContain("Due");
    expect(email.subject).toContain("INV-1001");
  });

  it("attaches the PDF when one is supplied", () => {
    const email = renderInvoiceEmail({ ...base, attachmentPdfBase64: "JVBERi0=" });
    expect(email.attachments).toEqual([{ filename: "invoice-INV-1001.pdf", content: "JVBERi0=", contentType: "application/pdf" }]);
  });

  it("carries no unsubscribe link, because it is not a mailing", () => {
    expect(renderInvoiceEmail(base).unsubscribeUrl).toBeUndefined();
  });
});
