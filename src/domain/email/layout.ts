/**
 * The one HTML shell every Countorra email renders inside.
 *
 * WHY THIS LOOKS LIKE 2005 HTML
 *
 * Email clients are not browsers. Outlook renders with Word's engine, Gmail
 * strips `<style>` blocks and external stylesheets, and flexbox/grid are
 * unreliable across the set. So: tables for structure, inline styles only,
 * no classes, no web fonts, no CSS variables. Following DESIGN.md's tokens
 * here means transcribing their VALUES, not importing them — the same quiet
 * paper-and-ledger palette, hand-inlined.
 *
 * Colours are the light-theme values from DESIGN.md, fixed rather than
 * theme-aware: `prefers-color-scheme` support is inconsistent across clients
 * and a half-applied dark theme is worse than a consistent light one.
 */

const INK = "#1a1a18";
const TEXT_SECONDARY = "#5c5c57";
const TEXT_TERTIARY = "#8a8a83";
const BORDER = "#e3e1dc";
const SURFACE = "#ffffff";
const CANVAS = "#f7f6f3";
const ACCENT = "#3d5a45";

export interface LayoutOptions {
  /** Preview text shown in the inbox list beside the subject. */
  preheader: string;
  bodyHtml: string;
  /** Rendered as a footer line under the rule. */
  footerNote?: string;
  unsubscribeUrl?: string;
}

/** Escapes a value for interpolation into HTML. Every template value goes
 *  through this — an invoice note or a customer name is user input, and it
 *  lands in someone else's mail client. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderLayout(options: LayoutOptions): string {
  const unsubscribe = options.unsubscribeUrl
    ? `<p style="margin:8px 0 0;font-size:12px;line-height:18px;color:${TEXT_TERTIARY};">
         <a href="${escapeHtml(options.unsubscribeUrl)}" style="color:${TEXT_TERTIARY};text-decoration:underline;">Unsubscribe from these emails</a>
       </p>`
    : "";

  const footerNote = options.footerNote
    ? `<p style="margin:0;font-size:12px;line-height:18px;color:${TEXT_TERTIARY};">${escapeHtml(options.footerNote)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Countorra</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(options.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:${SURFACE};border:1px solid ${BORDER};border-radius:8px;">
        <tr>
          <td style="padding:28px 32px 0;">
            <p style="margin:0;font:600 15px/22px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};letter-spacing:-0.005em;">Countorra</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 28px;font:400 15px/23px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${TEXT_SECONDARY};">
${options.bodyHtml}
          </td>
        </tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr>
          <td style="padding:16px 32px;font:400 12px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${TEXT_TERTIARY};">
            ${footerNote}
            ${unsubscribe}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** A primary action, as a table-wrapped anchor — the only button shape that
 *  renders consistently in Outlook. */
export function renderButton(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 4px;">
  <tr>
    <td style="background:${ACCENT};border-radius:6px;">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 20px;font:500 14px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

export function renderHeading(text: string): string {
  return `<p style="margin:0 0 12px;font:600 19px/27px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};letter-spacing:-0.01em;">${escapeHtml(text)}</p>`;
}

export function renderParagraph(text: string): string {
  return `<p style="margin:0 0 12px;">${escapeHtml(text)}</p>`;
}

/** A label/value row, for the facts an email exists to convey. */
export function renderFactRow(label: string, value: string, emphasis = false): string {
  const valueStyle = emphasis
    ? `font-weight:600;color:${INK};font-variant-numeric:tabular-nums;`
    : `color:${INK};font-variant-numeric:tabular-nums;`;
  return `<tr>
    <td style="padding:6px 0;border-bottom:1px solid ${BORDER};color:${TEXT_SECONDARY};font-size:13px;">${escapeHtml(label)}</td>
    <td align="right" style="padding:6px 0;border-bottom:1px solid ${BORDER};font-size:13px;${valueStyle}">${escapeHtml(value)}</td>
  </tr>`;
}

export function renderFactTable(rows: string[]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;font:400 13px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">${rows.join("")}</table>`;
}
