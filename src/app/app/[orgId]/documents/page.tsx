import { Info } from "@phosphor-icons/react/dist/ssr/Info";
import { createClient } from "@/server/supabase/server";
import { listDocuments } from "@/server/db/repositories/documents";
import { latestProcessingByDocument } from "@/server/db/repositories/document-intelligence";
import type { ProcessingJobStatus } from "@/domain/documents/intelligence/types";
import { UploadDocumentDialog } from "@/components/documents/upload-document-dialog";
import { DocumentsList } from "@/components/documents/documents-list";
import { PageHeader, PageMeta, PageMetaItem, PageShell } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * The filing cabinet.
 *
 * What reading exists is stated on the page, once, in plain language: the
 * text of a digital PDF can be read, a scan or photo cannot (no OCR provider
 * is configured), and nothing read is used until a person confirms it. Each
 * row's "Reading" column is the real state of its latest job or extraction —
 * never an animation. DESIGN.md §1 is a document about trust; a product that
 * pretends to read your receipts and does not is the fastest way to lose it.
 */
export default async function DocumentsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const client = await createClient();
  const documents = await listDocuments(client, orgId);
  // Two queries for the whole list, not one per row.
  const processing = await latestProcessingByDocument(client, orgId, documents.map((document) => document.id));
  const readingStatus: Record<string, ProcessingJobStatus | null> = {};
  for (const document of documents) {
    const entry = processing.get(document.id);
    const job = entry?.job ?? null;
    const inFlight = job && (job.status === "QUEUED" || job.status === "PROCESSING" || job.status === "FAILED");
    readingStatus[document.id] = inFlight ? job.status : (entry?.extraction?.status ?? job?.status ?? null);
  }

  const totalBytes = documents.reduce((sum, d) => sum + (d.sizeBytes ?? 0), 0);
  const totalSize = totalBytes >= 1024 * 1024 ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(totalBytes / 1024))} KB`;

  return (
    <PageShell className="gap-6">
      <PageHeader
        eyebrow="Records"
        title="Documents"
        description="Receipts, bills, statements and tax forms, kept alongside the books they belong to."
        actions={<UploadDocumentDialog organizationId={orgId} />}
        meta={
          documents.length > 0 ? (
            <PageMeta>
              <PageMetaItem label="Files" value={documents.length} />
              <PageMetaItem label="Stored" value={totalSize} />
            </PageMeta>
          ) : undefined
        }
      />

      {/* An honest capability note, styled as an info banner per DESIGN.md
          §19 — a semantic rail rather than a tinted block. */}
      <p className="flex items-start gap-2.5 rounded-md border border-border-subtle border-l-2 border-l-accent bg-surface px-4 py-3 text-[13px] text-text-secondary">
        <Info size={16} aria-hidden="true" className="mt-px shrink-0 text-accent" />
        <span>
          Documents are stored and kept private to this workspace. Countorra can read the text built into digital PDFs — open a document to read it. Scans and
          photos need an OCR provider, which isn&apos;t configured. Anything read is a suggestion until you confirm it.
        </span>
      </p>

      <Panel>
        {documents.length === 0 ? (
          <EmptyState
            title="No documents yet"
            description="Upload receipts, invoices, bills, or tax forms to keep them with your records."
            action={<UploadDocumentDialog organizationId={orgId} />}
          />
        ) : (
          <DocumentsList organizationId={orgId} documents={documents} readingStatus={readingStatus} />
        )}
      </Panel>
    </PageShell>
  );
}
