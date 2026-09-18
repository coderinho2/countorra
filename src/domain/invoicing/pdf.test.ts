import { describe, expect, it } from "vitest";
import { renderInvoicePdf, type InvoicePdfInput } from "./pdf";

/**
 * The PDF generator.
 *
 * Two things are worth testing about a hand-written PDF: that the file is
 * structurally valid (a wrong byte offset produces a document no reader
 * opens), and that nothing in it can be broken by user input.
 */

const base: InvoicePdfInput = {
  invoiceNumber: "INV-1001",
  organizationName: "Acme LLC",
  customerName: "Wile E. Coyote",
  customerEmail: "wile@example.test",
  currency: "USD",
  issueDate: "2026-09-01",
  dueDate: "2026-10-01",
  lineItems: [
    { description: "Consulting", quantity: 2, unitPriceMinor: 50_000, taxRate: 0, amountMinor: 100_000 },
    { description: "Materials", quantity: 1, unitPriceMinor: 25_000, taxRate: 0, amountMinor: 25_000 },
  ],
  subtotalMinor: 125_000,
  taxMinor: 0,
  totalMinor: 125_000,
  notes: "Payment within 30 days.",
  state: "sent",
};

const decode = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("document structure", () => {
  it("produces a PDF with a header and a terminator", () => {
    const pdf = decode(renderInvoicePdf(base));
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("declares every object it defines", () => {
    const pdf = decode(renderInvoicePdf(base));
    for (let i = 1; i <= 6; i++) expect(pdf, `object ${i}`).toContain(`${i} 0 obj`);
    expect(pdf).toContain("/Type /Catalog");
    expect(pdf).toContain("/Type /Page");
  });

  it("writes a cross-reference table whose offsets actually point at the objects", () => {
    // The single most likely way a hand-written PDF is broken: an offset out
    // by a byte, and no reader opens the file. Each recorded offset must
    // land exactly on its `N 0 obj` marker.
    const pdf = decode(renderInvoicePdf(base));
    // `\nxref\n`, not `lastIndexOf("xref")` — the latter matches inside
    // `startxref`, which sits AFTER the table.
    const xrefAt = pdf.lastIndexOf("\nxref\n");
    expect(xrefAt).toBeGreaterThan(0);

    const entries = pdf
      .slice(xrefAt)
      .split("\n")
      .filter((line) => /^\d{10} \d{5} n\s*$/.test(line))
      .map((line) => Number.parseInt(line.slice(0, 10), 10));

    expect(entries).toHaveLength(6);
    for (const [index, offset] of entries.entries()) {
      expect(pdf.slice(offset, offset + 16), `object ${index + 1}`).toMatch(new RegExp(`^${index + 1} 0 obj`));
    }
  });

  it("points startxref at the xref table", () => {
    const pdf = decode(renderInvoicePdf(base));
    const declared = Number.parseInt(pdf.slice(pdf.lastIndexOf("startxref") + 9).trim(), 10);
    expect(pdf.slice(declared, declared + 4)).toBe("xref");
  });

  it("declares a content stream whose /Length matches its bytes", () => {
    const pdf = decode(renderInvoicePdf(base));
    const declared = Number.parseInt(pdf.match(/<< \/Length (\d+) >>/)![1], 10);
    const body = pdf.slice(pdf.indexOf("stream\n") + 7, pdf.lastIndexOf("\nendstream"));
    expect(Buffer.byteLength(body, "latin1")).toBe(declared);
  });

  it("uses base-14 fonts, so nothing has to be embedded", () => {
    const pdf = decode(renderInvoicePdf(base));
    expect(pdf).toContain("/BaseFont /Helvetica");
    expect(pdf).toContain("/BaseFont /Helvetica-Bold");
  });
});

describe("determinism", () => {
  it("produces byte-identical output for the same invoice", () => {
    // A re-send must match the copy the customer already holds, and the
    // output must be testable. A `/CreationDate` would break both.
    const a = renderInvoicePdf(base);
    const b = renderInvoicePdf(base);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("embeds no timestamp or document id", () => {
    const pdf = decode(renderInvoicePdf(base));
    expect(pdf).not.toContain("/CreationDate");
    expect(pdf).not.toContain("/ModDate");
    expect(pdf).not.toContain("/ID");
  });

  it("changes when the invoice changes", () => {
    const changed = renderInvoicePdf({ ...base, totalMinor: 999_999 });
    expect(Buffer.from(changed).equals(Buffer.from(renderInvoicePdf(base)))).toBe(false);
  });
});

describe("content", () => {
  it("carries the figures the customer needs", () => {
    const pdf = decode(renderInvoicePdf(base));
    expect(pdf).toContain("INV-1001");
    expect(pdf).toContain("Acme LLC");
    expect(pdf).toContain("Wile E. Coyote");
    // $1,250.00 — formatted by src/domain/money, not re-derived here.
    expect(pdf).toContain("1,250.00");
  });

  it("states an overdue or paid invoice as such", () => {
    expect(decode(renderInvoicePdf({ ...base, state: "overdue" }))).toContain("OVERDUE");
    expect(decode(renderInvoicePdf({ ...base, state: "paid" }))).toContain("PAID");
    expect(decode(renderInvoicePdf({ ...base, state: "void" }))).toContain("VOID");
  });

  it("does not recompute the total from the line items", () => {
    // The stored total is authoritative — it was computed once by
    // `calculateInvoiceTotals`. If the PDF re-added the lines, a rounding
    // difference would put two different amounts in front of the customer.
    const pdf = decode(renderInvoicePdf({ ...base, totalMinor: 1 }));
    expect(pdf).toContain("$0.01");
  });
});

describe("user input cannot corrupt the file", () => {
  it("escapes parentheses and backslashes, which terminate a PDF string", () => {
    // Unescaped, `)` ends the literal early and everything after it is
    // parsed as operators — a corrupt document from a customer name.
    const pdf = decode(
      renderInvoicePdf({ ...base, customerName: "Evil ) Tj 0 0 0 rg (", notes: "back\\slash and (parens)" }),
    );
    expect(pdf).toContain("Evil \\) Tj 0 0 0 rg \\(");
    expect(pdf).toContain("back\\\\slash");
    // Still structurally valid afterwards.
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("survives newlines in a note without breaking the stream", () => {
    const pdf = decode(renderInvoicePdf({ ...base, notes: "line one\nline two\rline three" }));
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf).not.toContain("line one\nline two");
  });

  it("replaces characters the encoding cannot represent rather than emitting them raw", () => {
    // A raw multi-byte character desynchronises the parser and produces a
    // file that will not open.
    const pdf = decode(renderInvoicePdf({ ...base, customerName: "日本語 Ltd" }));
    expect(pdf).toContain("??? Ltd");
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("stays on one page when there are more line items than fit", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      description: `Item ${i}`,
      quantity: 1,
      unitPriceMinor: 100,
      taxRate: 0,
      amountMinor: 100,
    }));
    const pdf = decode(renderInvoicePdf({ ...base, lineItems: many }));

    // The overflow is STATED rather than silently dropped: a document
    // showing 24 of 60 lines and a total for all 60 would look wrong.
    expect(pdf).toContain("36 more line items");
    expect(pdf).toContain("/Count 1");
  });

  it("truncates a very long description instead of running into the amount column", () => {
    const pdf = decode(
      renderInvoicePdf({ ...base, lineItems: [{ description: "x".repeat(400), quantity: 1, unitPriceMinor: 100, taxRate: 0, amountMinor: 100 }] }),
    );
    expect(pdf).toContain("...");
    expect(pdf).not.toContain("x".repeat(200));
  });

  it("renders an invoice with no notes, no due date and no email", () => {
    const pdf = decode(renderInvoicePdf({ ...base, notes: null, dueDate: null, customerEmail: null }));
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  });
});
