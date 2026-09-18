import { canonicalJson } from "./canonical-json";
import type { FilingPackage, PackageJurisdiction, PackageLine } from "./types";

/**
 * Exports of a stored Countorra Filing Package.
 *
 * Pure and deterministic: the same stored package always produces the same
 * bytes, in every format. Nothing here renders anything that resembles an
 * official form — no form number, no line numbers, no layout of a government
 * document — and every format opens with the same notice.
 */

export const EXPORT_NOTICE = "Preparation summary — not an IRS or state filing form. Countorra has not filed or submitted this return.";

export type ExportFormat = "json" | "csv" | "txt";

export const EXPORT_CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = {
  json: "application/json; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

export function exportFileName(filingPackage: FilingPackage, format: ExportFormat): string {
  const { taxYear, filingVersion } = filingPackage.metadata;
  return `countorra-filing-package-${taxYear}-v${filingVersion}.${format}`;
}

/** The stored package, verbatim, with keys in canonical order. */
export function toJsonExport(filingPackage: FilingPackage): string {
  return `${JSON.stringify({ notice: EXPORT_NOTICE, package: JSON.parse(canonicalJson(filingPackage)) }, null, 2)}\n`;
}

/** The supported structured figures, one per row. Amounts as exact decimals. */
export function toCsvExport(filingPackage: FilingPackage): string {
  const currency = filingPackage.metadata.currency;
  const rows: string[][] = [["section", "item", "amount", "currency", "detail"]];
  rows.push(["notice", "", "", "", EXPORT_NOTICE]);
  rows.push(["metadata", "tax_year", "", "", String(filingPackage.metadata.taxYear)]);
  rows.push(["metadata", "filing_version", "", "", String(filingPackage.metadata.filingVersion)]);
  rows.push(["metadata", "scope", "", "", filingPackage.metadata.scope]);
  rows.push(["metadata", "filing_status", "", "", filingPackage.filingStatus.label]);

  const line = (section: string, entry: PackageLine) =>
    rows.push([section, entry.label, decimal(entry.amountMinor), currency, entry.includedInCalculation ? "included in calculation" : "recorded, not included in any calculated figure"]);

  for (const entry of filingPackage.income) line("income", entry);
  for (const entry of filingPackage.adjustments) line("adjustment", entry);
  for (const entry of filingPackage.deductions.collectedNotApplied) line("deduction_not_applied", entry);
  if (filingPackage.deductions.standardDeductionAppliedMinor !== null) {
    rows.push(["deduction", "Standard deduction applied (federal)", decimal(filingPackage.deductions.standardDeductionAppliedMinor), currency, ""]);
  }

  const payments = filingPackage.payments;
  for (const [label, amount] of [
    ["Federal income tax withheld", payments.federalWithholdingMinor],
    ["Federal estimated tax payments", payments.federalEstimatedPaymentsMinor],
    ["State income tax withheld", payments.stateWithholdingMinor],
    ["State estimated tax payments", payments.stateEstimatedPaymentsMinor],
  ] as const) {
    rows.push(["payment", label, amount === null ? "" : decimal(amount), amount === null ? "" : currency, amount === null ? "not recorded" : ""]);
  }

  for (const jurisdiction of [filingPackage.federal, ...filingPackage.states]) {
    rows.push(["jurisdiction", jurisdiction.name, jurisdiction.totals ? decimal(jurisdiction.totals.totalTaxMinor) : "", jurisdiction.totals ? currency : "", describeJurisdiction(jurisdiction)]);
  }

  const refund = filingPackage.refund.federal;
  rows.push(["refund", "Federal refund or balance due", refund.amountMinor === null ? "" : decimal(refund.amountMinor), refund.amountMinor === null ? "" : currency, refund.status]);

  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** A plain-text summary for a person to read. */
export function toTextSummary(filingPackage: FilingPackage): string {
  const currency = filingPackage.metadata.currency;
  const money = (minor: number | null) => (minor === null ? "not stated" : `${decimal(minor)} ${currency}`);
  const out: string[] = [];

  out.push(EXPORT_NOTICE, "");
  out.push(`${filingPackage.format.name} — tax year ${filingPackage.metadata.taxYear}, version ${filingPackage.metadata.filingVersion}`);
  out.push(`Scope: ${filingPackage.metadata.scope === "FULL" ? "federal and every state component" : "federal only"}`);
  out.push(`Filing status: ${filingPackage.filingStatus.label}`);
  out.push(`Generated: ${filingPackage.metadata.generatedAt}`, "");

  out.push("Income");
  for (const entry of filingPackage.income) out.push(`  ${entry.label}: ${money(entry.amountMinor)}${entry.includedInCalculation ? "" : " (recorded, not calculated)"}`);
  if (filingPackage.income.length === 0) out.push("  None recorded");
  out.push("");

  out.push("Tax before credits");
  for (const jurisdiction of [filingPackage.federal, ...filingPackage.states]) {
    out.push(`  ${jurisdiction.name}: ${jurisdiction.totals ? money(jurisdiction.totals.totalTaxMinor) : "no figure"} — ${describeJurisdiction(jurisdiction)}`);
  }
  out.push("");

  const refund = filingPackage.refund.federal;
  out.push(`Federal refund or balance due: ${refund.status === "NOT_DETERMINABLE" ? "not determinable" : `${refund.status === "REFUND" ? "refund" : "balance due"} ${money(refund.amountMinor)}`}`);
  out.push(`  ${refund.explanation}`, "");

  const reviews = filingPackage.readiness.issues.filter((issue) => issue.severity === "REVIEW");
  if (reviews.length > 0) {
    out.push("Needs review");
    for (const review of reviews) out.push(`  - ${review.message}`);
    out.push("");
  }

  const warnings = filingPackage.readiness.issues.filter((issue) => issue.severity === "WARNING");
  if (warnings.length > 0) {
    out.push("Warnings");
    for (const warning of warnings) out.push(`  - ${warning.message}`);
    out.push("");
  }

  out.push("Limitations");
  for (const limitation of filingPackage.limitations) out.push(`  - ${limitation}`);
  out.push("", filingPackage.disclaimer, "");
  return out.join("\n");
}

// ── helpers ───────────────────────────────────────────────────────────

/** Exact decimal from integer minor units — no float ever touches the figure. */
export function decimal(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  const cents = absolute % 100;
  return `${sign}${Math.trunc(absolute / 100)}.${cents < 10 ? `0${cents}` : cents}`;
}

function describeJurisdiction(jurisdiction: PackageJurisdiction): string {
  if (jurisdiction.role === "NO_INDIVIDUAL_INCOME_TAX_RETURN") return "no individual income-tax return in this state";
  if (jurisdiction.role === "EXCLUDED") return `excluded: ${jurisdiction.exclusionReason ?? "not ready for filing"}`;
  if (jurisdiction.resultStatus === "ESTIMATE") return "estimate under another year's published rules";
  return jurisdiction.ruleSet ? `calculated under ${jurisdiction.ruleSet.taxYear} rules, version ${jurisdiction.ruleSet.version}` : jurisdiction.message;
}

function csvCell(value: string): string {
  // Neutralise spreadsheet formula injection as well as quoting.
  const guarded = /^[=+\-@\t\r]/.test(value) && !/^-?\d+\.\d{2}$/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
