import Link from "next/link";
import { notFound } from "next/navigation";
import { Info } from "@phosphor-icons/react/dist/ssr/Info";
import { createClient } from "@/server/supabase/server";
import { requireOrgMembership } from "@/server/auth/session";
import { can } from "@/domain/organizations/permissions";
import { format, money } from "@/domain/money/money";
import { isSupportedCurrency } from "@/domain/money/currency";
import { willPropose, type ProposalRelation } from "@/domain/documents/intelligence/proposals";
import {
  isIdentityDocument,
  DOCUMENT_TYPE_LABELS,
  EXTRACTION_WARNING_TEXT,
  PROCESSING_VERSION,
  type FieldSection,
} from "@/domain/documents/intelligence/types";
import { loadDocumentIntelligence } from "@/server/documents/intelligence-workspace";
import type { StoredExtractedField } from "@/server/db/repositories/document-intelligence";
import { PageHeader, PageMeta, PageMetaItem, PageShell } from "@/components/ui/page-header";
import { Panel, PanelFooter, SectionHeading } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FieldReviewBadge, PreparationStateBadge, ProcessingStatusBadge, type PreparationColumnState } from "@/components/documents/document-processing-badge";
import { ProposeFactsForm, ReadDocumentForm } from "@/components/documents/document-intelligence-forms";

/**
 * One document, and what was read from it.
 *
 * Read like a working paper, in the order a person checks one: what the file
 * is, whether it was read and how, what was read — each value with where it
 * came from — and what happened to those values in Tax preparation.
 *
 * THREE WORDS ARE KEPT APART ON THIS PAGE
 *
 *   Extracted   read from the document; nobody has confirmed it
 *   Proposed    offered to Tax preparation as a suggestion
 *   Confirmed   a person accepted it there
 *
 * No raw text dump: the document's text is not stored. Every value shown is a
 * stored field, escaped as text by React, with its page and method beside it.
 */

const SECTION_ORDER: readonly { section: FieldSection; title: string }[] = [
  { section: "DOCUMENT", title: "Document" },
  { section: "PARTIES", title: "Parties" },
  { section: "INCOME", title: "Income" },
  { section: "WITHHOLDING", title: "Withholding" },
  { section: "DEDUCTIONS", title: "Deductions and payments" },
  { section: "STATE", title: "State" },
  { section: "LOCAL", title: "Local" },
  { section: "PERIOD", title: "Dates" },
  { section: "BALANCES", title: "Balances" },
  { section: "TOTALS", title: "Totals" },
  { section: "IDENTITY", title: "Identity document" },
];

const ROW_SECTIONS: readonly FieldSection[] = ["TRANSACTIONS", "LINE_ITEMS"];

const RELATION_TEXT: Record<ProposalRelation, string> = {
  PROPOSE: "Will be suggested",
  PROPOSE_CONFLICT: "Will be suggested — conflicts with a figure already recorded from this document",
  PROPOSE_ALONGSIDE: "Will be suggested alongside an existing figure",
  ALREADY_PROPOSED: "Already sent",
  MATCHES_EXISTING: "Already recorded",
  NOT_PROPOSABLE: "Can't be used",
};

function formatSize(bytes: number | null) {
  if (bytes === null) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatValue(field: StoredExtractedField): string {
  switch (field.valueKind) {
    case "MONEY":
      if (field.amountMinor !== null && field.currency && isSupportedCurrency(field.currency)) return format(money(field.amountMinor, field.currency));
      return field.normalizedDecimal !== null ? `${field.normalizedDecimal} (no currency stated)` : "—";
    case "DATE":
      return field.normalizedDate ?? "—";
    case "PRESENCE":
      return field.normalizedText === "PRESENT" ? `Printed${field.rawValue && /\d{4}$/.test(field.rawValue) ? ` · ends ${field.rawValue.slice(-4)}` : ""} · not stored` : "—";
    default:
      return field.normalizedText ?? "—";
  }
}

function sourceText(field: StoredExtractedField, method: string): string {
  if (field.pageNumber === null) return "—";
  const via = method === "PDF_TEXT_LAYER" ? "PDF text" : "OCR";
  return `Page ${field.pageNumber}${field.box ? ` · box ${field.box}` : ""} · ${via}`;
}

export default async function DocumentIntelligencePage({ params }: { params: Promise<{ orgId: string; documentId: string }> }) {
  const { orgId, documentId } = await params;
  const { membership } = await requireOrgMembership(orgId);
  const canWrite = can(membership.role, "financial:write");

  const client = await createClient();
  const intelligence = await loadDocumentIntelligence(client, orgId, documentId);
  if (!intelligence) notFound();

  const { document, reader, latestJob, extraction, extractions, fields, preparationStateByField, proposalPlan, conflicts } = intelligence;
  const planByField = new Map((proposalPlan?.items ?? []).map((item) => [item.fieldId, item]));
  const proposable = (proposalPlan?.items ?? []).filter((item) => willPropose(item.relation));

  const currentReadDone =
    extraction !== null && extraction.processingVersion === PROCESSING_VERSION && extraction.provider === reader.providerId && extraction.providerVersion === reader.providerVersion;
  const retryable = latestJob?.status === "FAILED" && latestJob.attempts < latestJob.maxAttempts;
  const readLabel = retryable ? "Try again" : extraction ? "Read again with the current reader" : "Read document";
  const showRead = canWrite && reader.available && (!currentReadDone || retryable) && latestJob?.status !== "PROCESSING";

  const displayStatus = latestJob?.status === "FAILED" || latestJob?.status === "PROCESSING" || latestJob?.status === "QUEUED" ? latestJob.status : (extraction?.status ?? latestJob?.status ?? null);

  const preparationColumn = (field: StoredExtractedField): PreparationColumnState => {
    if (field.reviewState === "CONFLICT" || planByField.get(field.id)?.relation === "PROPOSE_CONFLICT") return "CONFLICTING";
    return preparationStateByField.get(field.id) ?? "EXTRACTED";
  };

  const regular = fields.filter((field) => !ROW_SECTIONS.includes(field.section));
  const rows = fields.filter((field) => ROW_SECTIONS.includes(field.section));

  return (
    <PageShell className="gap-8">
      <PageHeader
        eyebrow="Documents"
        title={document.originalFilename ?? "Untitled document"}
        description={`Uploaded ${document.createdAt.slice(0, 10)} · ${document.mimeType === "application/pdf" ? "PDF" : "Image"} · ${formatSize(document.sizeBytes)}`}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={`/app/${orgId}/documents`}>All documents</Link>
          </Button>
        }
        meta={
          <PageMeta>
            <PageMetaItem label="Reading" value={<ProcessingStatusBadge status={displayStatus} />} />
            <PageMetaItem label="Type" value={extraction ? DOCUMENT_TYPE_LABELS[extraction.documentType] : "Not known"} />
            <PageMetaItem label="Tax year" value={extraction?.taxYear ?? "Not printed"} />
            <PageMetaItem label="Reading version" value={extraction ? extraction.version : "None"} />
          </PageMeta>
        }
      />

      <p className="flex items-start gap-2.5 rounded-md border border-border-subtle border-l-2 border-l-accent bg-surface px-4 py-3 text-[13px] text-text-secondary">
        <Info size={16} aria-hidden="true" className="mt-px shrink-0 text-accent" />
        <span>
          {reader.available ? (
            <>
              <span className="font-medium text-text-primary">Countorra reads the text built into digital PDFs, on its own servers.</span> Scans and photos need an OCR provider, which
              isn&apos;t configured. Anything read here is a suggestion until you confirm it in Tax preparation.
            </>
          ) : (
            <>
              <span className="font-medium text-text-primary">This file can&apos;t be read automatically.</span> {reader.message}
            </>
          )}
        </span>
      </p>

      {/* ── Reading ──────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <SectionHeading index={1} title="Reading" description="Whether the document was read, by which reader, and what got in the way." />
        <Panel className="flex flex-col gap-4 p-6">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
            <ProcessingStatusBadge status={displayStatus} />
            <p className="text-[15px] text-text-primary">
              {!latestJob && !extraction
                ? "This document hasn't been read."
                : latestJob?.status === "FAILED"
                  ? (latestJob.failureMessage ?? "The last attempt failed.")
                  : latestJob?.status === "PROCESSING"
                    ? "This document is being read."
                    : extraction?.status === "UNSUPPORTED"
                      ? "Nothing could be read from this file with the readers configured."
                      : extraction?.status === "REVIEW_REQUIRED"
                        ? (extraction.classificationReviewReason ?? "What was read needs review before any figure can be used.")
                        : extraction?.status === "PARTIAL"
                          ? "Read, but some expected fields weren't found."
                          : "Read. Review each value below before using it."}
            </p>
          </div>

          {extraction && extraction.warnings.length > 0 && (
            <ul className="flex list-disc flex-col gap-0.5 pl-5 text-[13px] text-text-secondary">
              {extraction.warnings.map((warning) => (
                <li key={warning}>{EXTRACTION_WARNING_TEXT[warning]}</li>
              ))}
            </ul>
          )}

          {showRead && <ReadDocumentForm organizationId={orgId} documentId={document.id} label={readLabel} />}
          {!canWrite && <p className="text-[13px] text-text-secondary">Only members who can edit records can read documents.</p>}
          {latestJob?.status === "FAILED" && latestJob.attempts >= latestJob.maxAttempts && (
            <p className="text-[13px] text-text-secondary">No attempts remain for this reader. The document is still stored.</p>
          )}
        </Panel>
      </section>

      {/* ── What was read ────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <SectionHeading index={2} title="What was read" description="Each value as read, where it came from, and how cleanly. Extracted is not confirmed." />
        {!extraction ? (
          <Panel>
            <EmptyState title="Nothing read yet" description="Values appear here once the document has been read." />
          </Panel>
        ) : (
          <Panel>
            <div className="grid gap-4 border-b border-border-subtle px-4 py-4 sm:grid-cols-3">
              <Figure label="Document type" value={DOCUMENT_TYPE_LABELS[extraction.documentType]} note={`Confidence: ${extraction.classificationConfidence.toLowerCase()} · from the document's own markings`} />
              <Figure label="Tax year" value={extraction.taxYear === null ? "Not printed" : String(extraction.taxYear)} note={extraction.taxYear === null ? "None is assumed." : "As printed on the document."} />
              <Figure label="Read by" value={extraction.method === "PDF_TEXT_LAYER" ? "PDF text layer" : "OCR"} note={`${extraction.provider} ${extraction.providerVersion} · ${extraction.pageCount} ${extraction.pageCount === 1 ? "page" : "pages"}`} />
            </div>

            {isIdentityDocument(extraction.documentType) ? (
              /* Identity documents carry a different promise from every other
                 kind, and the promise is only worth anything if the person
                 can see it. Each sentence is a property enforced elsewhere:
                 storage (identity.ts + migration 0055), the assistant
                 (explain.ts), and the proposal path (no schema mapping). */
              <div className="flex items-start gap-3 border-b border-border-subtle bg-surface-sunken px-4 py-3">
                <Info size={16} className="mt-0.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                <div className="flex flex-col gap-1 text-[13px] leading-[1.6] text-text-secondary">
                  <p className="font-medium text-text-primary">This is an identity document, and it is treated differently.</p>
                  <p>
                    The number on it was never stored — only the last four digits, so you can tell two documents apart. Its details are not shared with the
                    assistant, and nothing on it can be used to change a figure or a transaction. Deleting the document removes everything read from it.
                  </p>
                </div>
              </div>
            ) : null}

            {regular.length === 0 ? (
              <EmptyState title="No fields" description="No figures are extracted from this kind of document." />
            ) : (
              SECTION_ORDER.filter(({ section }) => regular.some((field) => field.section === section)).map(({ section, title }) => (
                <div key={section} className="border-b border-border-subtle last:border-b-0">
                  <p className="bg-surface-sunken px-4 py-2 text-[11px] font-semibold tracking-[0.08em] text-text-secondary uppercase">{title}</p>
                  <Table fixed>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-full">Field</TableHead>
                        <TableHead numeric className="w-44">
                          Value
                        </TableHead>
                        <TableHead className="w-32">Read</TableHead>
                        <TableHead className="w-44">Source</TableHead>
                        <TableHead className="w-32">Tax preparation</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {regular
                        .filter((field) => field.section === section)
                        .map((field) => (
                          <TableRow key={field.id}>
                            <TableCell className="max-w-0">
                              <span className="block truncate text-text-primary">
                                {field.box ? <span className="font-numeric text-text-tertiary">Box {field.box} · </span> : null}
                                {field.label}
                              </span>
                              {field.reviewReason && <span className="block truncate text-[12px] text-text-tertiary">{field.reviewReason}</span>}
                            </TableCell>
                            <TableCell numeric className="truncate font-numeric tabular-nums">
                              {formatValue(field)}
                            </TableCell>
                            <TableCell>
                              <FieldReviewBadge state={field.reviewState} />
                            </TableCell>
                            <TableCell className="truncate text-[13px] text-text-secondary">{sourceText(field, extraction.method)}</TableCell>
                            <TableCell>
                              {field.valueKind === "MONEY" && (field.normalizedDecimal !== null || field.reviewState === "CONFLICT") ? (
                                <PreparationStateBadge state={preparationColumn(field)} />
                              ) : (
                                <span className="text-text-tertiary">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </div>
              ))
            )}

            {rows.length > 0 && (
              <div className="border-t border-border-subtle">
                <p className="bg-surface-sunken px-4 py-2 text-[11px] font-semibold tracking-[0.08em] text-text-secondary uppercase">
                  {rows[0].section === "TRANSACTIONS" ? "Transaction candidates" : "Line items"} · {rows.length} · uncertain, not imported
                </p>
                <Table fixed>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-28">Date</TableHead>
                      <TableHead className="w-full">Description</TableHead>
                      <TableHead numeric className="w-40">
                        Amount
                      </TableHead>
                      <TableHead className="w-24">Page</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-numeric text-[13px] text-text-secondary">{row.normalizedDate ?? "—"}</TableCell>
                        <TableCell className="max-w-0 truncate text-[13px]">{row.normalizedText ?? "—"}</TableCell>
                        <TableCell numeric className="font-numeric tabular-nums">
                          {formatValue(row)}
                        </TableCell>
                        <TableCell className="font-numeric text-[13px] text-text-tertiary">{row.pageNumber ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <PanelFooter>
              <span className="font-numeric">
                Reading {extraction.version} · {extraction.createdAt.slice(0, 16).replace("T", " ")} UTC · {extraction.processingVersion}
              </span>
            </PanelFooter>
          </Panel>
        )}
      </section>

      {/* ── Tax preparation ──────────────────────────────────────────── */}
      {extraction && proposalPlan && (
        <section className="flex flex-col gap-4">
          <SectionHeading index={3} title="Tax preparation" description="Figures from this document can be suggested for review. Nothing is used until you confirm it there." />
          <Panel className="flex flex-col gap-4 p-6">
            {proposalPlan.blocked ? (
              <p className="text-[15px] text-text-primary">{proposalPlan.blocked}</p>
            ) : (
              <>
                <ul className="flex flex-col divide-y divide-border-subtle">
                  {proposalPlan.items.map((item) => (
                    <li key={item.fieldId} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:gap-4">
                      <span className="w-full text-[15px] text-text-primary">
                        {item.label}
                        {item.box ? <span className="font-numeric text-text-tertiary"> · box {item.box}</span> : null}
                      </span>
                      <span className="font-numeric w-40 shrink-0 text-right tabular-nums">
                        {item.amountMinor !== null && item.currency && isSupportedCurrency(item.currency) ? format(money(item.amountMinor, item.currency)) : "—"}
                      </span>
                      <span className="flex w-72 shrink-0 flex-col gap-0.5">
                        <Badge variant={item.relation === "PROPOSE_CONFLICT" ? "negative" : willPropose(item.relation) ? "info" : "neutral"}>{RELATION_TEXT[item.relation]}</Badge>
                        <span className="text-[12px] text-text-tertiary">{item.reason}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {canWrite && proposable.length > 0 && proposalPlan.taxYear !== null && (
                  <ProposeFactsForm organizationId={orgId} extractionId={extraction.id} count={proposable.length} taxYear={proposalPlan.taxYear} />
                )}
              </>
            )}
            <p className="text-[13px] text-text-secondary">
              Suggestions appear on the{" "}
              <Link href={`/app/${orgId}/tax-preparation`} className="text-accent hover:underline">
                Tax preparation
              </Link>{" "}
              page, where each one is confirmed, corrected or rejected by a person.
            </p>
          </Panel>
        </section>
      )}

      {/* ── Conflicts ────────────────────────────────────────────────── */}
      {conflicts.length > 0 && (
        <section className="flex flex-col gap-4">
          <SectionHeading index={4} title="Conflicts with other documents" description="Shown, never resolved automatically." />
          <Panel>
            <ul className="flex flex-col divide-y divide-border-subtle">
              {conflicts.map((conflict) => {
                const other = conflict.documentIds.find((id) => id !== document.id) ?? conflict.documentIds[1];
                return (
                  <li key={`${conflict.kind}:${conflict.documentIds.join(":")}`} className="flex flex-col gap-1 px-4 py-3">
                    <Badge variant="negative">Conflicting</Badge>
                    <p className="text-[15px] text-text-primary">{conflict.message}</p>
                    {conflict.values && <p className="font-numeric text-[13px] text-text-secondary">{conflict.values.join(" vs ")}</p>}
                    <Link href={`/app/${orgId}/documents/${other}`} className="text-[13px] text-accent hover:underline">
                      Open the other document
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </section>
      )}

      {/* ── History ──────────────────────────────────────────────────── */}
      {extractions.length > 0 && (
        <section className="flex flex-col gap-4">
          <SectionHeading index={conflicts.length > 0 ? 5 : 4} title="Reading history" description="Every reading is kept exactly as it was recorded. A newer reading never replaces an older one." />
          <Panel>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reading</TableHead>
                  <TableHead>Recorded</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Reader</TableHead>
                  <TableHead numeric>Fields</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {extractions.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="font-numeric tabular-nums">v{entry.version}</TableCell>
                    <TableCell className="font-numeric text-[13px] text-text-secondary">{entry.createdAt.slice(0, 16).replace("T", " ")}</TableCell>
                    <TableCell>
                      <ProcessingStatusBadge status={entry.status} />
                    </TableCell>
                    <TableCell className="text-text-secondary">{DOCUMENT_TYPE_LABELS[entry.documentType]}</TableCell>
                    <TableCell className="font-numeric text-[13px] text-text-secondary">
                      {entry.provider} {entry.providerVersion}
                    </TableCell>
                    <TableCell numeric className="font-numeric tabular-nums">
                      {entry.fieldCount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        </section>
      )}
    </PageShell>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold tracking-[0.08em] text-text-tertiary uppercase">{label}</span>
      <span className="text-[15px] text-text-primary">{value}</span>
      <span className="text-[12px] text-text-tertiary">{note}</span>
    </div>
  );
}
