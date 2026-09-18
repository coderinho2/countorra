import { format as formatMoney, money } from "@/domain/money/money";
import type { CurrencyCode } from "@/domain/money/currency";

/**
 * Invoice PDF generation, with no dependency.
 *
 * WHY NOT A LIBRARY
 *
 * pdfkit and @react-pdf/renderer both solve a much larger problem than this
 * one — embedded fonts, arbitrary layout, images, page flow — and both bring
 * a substantial dependency tree into a financial application. What an
 * invoice needs is fixed-layout text and rules on A4, in one font.
 *
 * PDF has a base-14 font set (Helvetica among them) that every reader is
 * required to provide, so no font file has to be embedded. That reduces the
 * job to: emit text-positioning operators, build the cross-reference table,
 * and get the byte offsets right. That is what this file is.
 *
 * WHY DETERMINISM MATTERS HERE
 *
 * The same invoice must produce the same bytes. It makes the output
 * testable, it makes a re-send byte-identical to what the customer already
 * has, and it means no clock or random value can leak into a financial
 * document. There is deliberately no `/CreationDate` — it is the one field
 * that would make two renders of the same invoice differ.
 *
 * WHAT THIS IS NOT
 *
 * Not a general PDF writer. It handles Latin-1 text in one font at fixed
 * positions. Anything outside that — a logo, a non-Latin script, arbitrary
 * wrapping — is a reason to revisit the decision above, not to extend this
 * quietly.
 */

export interface InvoicePdfLineItem {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  taxRate: number;
  amountMinor: number;
}

export interface InvoicePdfInput {
  invoiceNumber: string;
  organizationName: string;
  customerName: string;
  customerEmail: string | null;
  currency: CurrencyCode;
  issueDate: string;
  dueDate: string | null;
  lineItems: InvoicePdfLineItem[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  notes: string | null;
  /** Rendered as a status band. Uses the DERIVED state, so a PDF of an
   *  overdue invoice says so. */
  state: string;
}

// A4 at 72dpi.
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/**
 * Escapes a string for a PDF literal, and drops what the base-14 encoding
 * cannot represent.
 *
 * `(`, `)` and `\` terminate or escape a literal and must be escaped, or the
 * document is corrupt. Characters above U+00FF have no WinAnsi
 * representation; they are replaced rather than emitted raw, because a
 * mangled byte can desynchronise the parser and produce a file no reader
 * opens.
 */
function pdfString(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "(" || char === ")" || char === "\\") out += `\\${char}`;
    else if (code === 10 || code === 13) out += " ";
    else if (code < 32) continue;
    else if (code <= 255) out += char;
    else out += "?";
  }
  return out;
}

/** Helvetica advance widths (1/1000 em) for the printable Latin-1 range.
 *  Needed only for right-aligning numbers and truncating descriptions. */
const HELVETICA_WIDTHS: Record<string, number> = {
  " ": 278, "!": 278, '"': 355, "#": 556, $: 556, "%": 889, "&": 667, "'": 191,
  "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
  "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556,
  "8": 556, "9": 556, ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556,
  "@": 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
  I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
  S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, "[": 278,
  "\\": 278, "]": 278, "^": 469, _: 556, "`": 333, a: 556, b: 556, c: 500, d: 556,
  e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556,
  o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500,
  y: 500, z: 500, "{": 334, "|": 260, "}": 334, "~": 584,
};

function textWidth(text: string, size: number, bold: boolean): number {
  // Helvetica-Bold is wider; 1.05 is close enough for right-alignment and
  // truncation, and nothing here depends on exact metrics.
  const factor = bold ? 1.05 : 1;
  let units = 0;
  for (const char of text) units += HELVETICA_WIDTHS[char] ?? 556;
  return (units / 1000) * size * factor;
}

/** Truncates with an ellipsis so a long description cannot run into the
 *  amount column. */
function truncateToWidth(text: string, maxWidth: number, size: number, bold = false): string {
  if (textWidth(text, size, bold) <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && textWidth(`${result}...`, size, bold) > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}...`;
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Builds the content stream: a list of PDF operators. */
class Content {
  private ops: string[] = [];

  text(value: string, x: number, y: number, size: number, bold = false, gray = 0): this {
    this.ops.push(
      "BT",
      `/${bold ? "F2" : "F1"} ${size} Tf`,
      `${gray} g`,
      `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`,
      `(${pdfString(value)}) Tj`,
      "ET",
    );
    return this;
  }

  textRight(value: string, right: number, y: number, size: number, bold = false, gray = 0): this {
    return this.text(value, right - textWidth(value, size, bold), y, size, bold, gray);
  }

  line(x1: number, y1: number, x2: number, y2: number, gray = 0.85): this {
    this.ops.push(`${gray} G`, "0.5 w", `${x1.toFixed(2)} ${y1.toFixed(2)} m`, `${x2.toFixed(2)} ${y2.toFixed(2)} l`, "S");
    return this;
  }

  toString(): string {
    return this.ops.join("\n");
  }
}

export function renderInvoicePdf(input: InvoicePdfInput): Uint8Array {
  const c = new Content();
  const right = PAGE_WIDTH - MARGIN;
  let y = PAGE_HEIGHT - MARGIN;

  const amount = (minor: number) => formatMoney(money(minor, input.currency));

  // ── Header ────────────────────────────────────────────────────────────
  c.text(input.organizationName, MARGIN, y, 15, true);
  c.textRight("INVOICE", right, y, 15, true, 0.45);
  y -= 26;
  c.line(MARGIN, y, right, y);
  y -= 24;

  // ── Meta ──────────────────────────────────────────────────────────────
  c.text("Billed to", MARGIN, y, 8, false, 0.45);
  c.textRight("Invoice", right, y, 8, false, 0.45);
  y -= 14;
  c.text(truncateToWidth(input.customerName, CONTENT_WIDTH / 2, 11), MARGIN, y, 11, true);
  c.textRight(input.invoiceNumber, right, y, 11, true);
  y -= 14;

  if (input.customerEmail) {
    c.text(truncateToWidth(input.customerEmail, CONTENT_WIDTH / 2, 9), MARGIN, y, 9, false, 0.35);
  }
  c.textRight(`Issued ${formatDate(input.issueDate)}`, right, y, 9, false, 0.35);
  y -= 13;

  if (input.dueDate) {
    c.textRight(`Due ${formatDate(input.dueDate)}`, right, y, 9, false, 0.35);
    y -= 13;
  }
  if (input.state === "overdue") {
    c.textRight("OVERDUE", right, y, 9, true, 0.2);
    y -= 13;
  } else if (input.state === "paid") {
    c.textRight("PAID", right, y, 9, true, 0.2);
    y -= 13;
  } else if (input.state === "void") {
    c.textRight("VOID", right, y, 9, true, 0.2);
    y -= 13;
  }

  y -= 16;

  // ── Line items ────────────────────────────────────────────────────────
  const qtyRight = MARGIN + CONTENT_WIDTH * 0.56;
  const priceRight = MARGIN + CONTENT_WIDTH * 0.78;
  const descriptionWidth = qtyRight - MARGIN - 16;

  c.text("Description", MARGIN, y, 8, false, 0.45);
  c.textRight("Qty", qtyRight, y, 8, false, 0.45);
  c.textRight("Unit price", priceRight, y, 8, false, 0.45);
  c.textRight("Amount", right, y, 8, false, 0.45);
  y -= 8;
  c.line(MARGIN, y, right, y);
  y -= 16;

  // Bounded: a single-page document cannot show an unbounded list, and
  // silently dropping rows would misstate the total. The overflow is stated.
  const MAX_ROWS = 24;
  const visible = input.lineItems.slice(0, MAX_ROWS);

  for (const item of visible) {
    c.text(truncateToWidth(item.description, descriptionWidth, 10), MARGIN, y, 10);
    c.textRight(String(item.quantity), qtyRight, y, 10, false, 0.25);
    c.textRight(amount(item.unitPriceMinor), priceRight, y, 10, false, 0.25);
    c.textRight(amount(item.amountMinor), right, y, 10);
    y -= 18;
  }

  if (input.lineItems.length > MAX_ROWS) {
    c.text(`+ ${input.lineItems.length - MAX_ROWS} more line items — see the online invoice`, MARGIN, y, 9, false, 0.45);
    y -= 18;
  }

  // ── Totals ────────────────────────────────────────────────────────────
  y -= 6;
  c.line(MARGIN + CONTENT_WIDTH * 0.55, y, right, y);
  y -= 18;

  c.textRight("Subtotal", priceRight, y, 10, false, 0.35);
  c.textRight(amount(input.subtotalMinor), right, y, 10);
  y -= 16;

  c.textRight("Tax", priceRight, y, 10, false, 0.35);
  c.textRight(amount(input.taxMinor), right, y, 10);
  y -= 8;
  c.line(MARGIN + CONTENT_WIDTH * 0.55, y, right, y);
  y -= 18;

  c.textRight("Total", priceRight, y, 12, true);
  c.textRight(amount(input.totalMinor), right, y, 12, true);
  y -= 30;

  if (input.notes) {
    c.text("Notes", MARGIN, y, 8, false, 0.45);
    y -= 14;
    // One line, truncated. Real wrapping is a layout engine, and this file
    // is explicitly not one.
    c.text(truncateToWidth(input.notes, CONTENT_WIDTH, 9), MARGIN, y, 9, false, 0.3);
  }

  c.text(`${input.organizationName} — invoice ${input.invoiceNumber}`, MARGIN, MARGIN - 16, 8, false, 0.55);

  return assemblePdf(c.toString());
}

/**
 * Wraps a content stream in the minimum viable PDF document.
 *
 * Five objects: catalog, page tree, page, content, and two fonts. The
 * cross-reference table records each object's BYTE OFFSET from the start of
 * the file, which is why the body is assembled first and measured as it goes
 * — an offset that is wrong by one byte produces a file no reader opens.
 */
function assemblePdf(content: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];

  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }

  // No /CreationDate and no /ID: both would make two renders of the same
  // invoice differ, which is the property this generator exists to keep.
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(body + xref + trailer, "latin1"));
}
