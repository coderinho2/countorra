"use client";

import Link from "next/link";
import { useTransition } from "react";
import { FilePdf } from "@phosphor-icons/react/dist/ssr/FilePdf";
import { FileImage } from "@phosphor-icons/react/dist/ssr/FileImage";
import { FileText } from "@phosphor-icons/react/dist/ssr/FileText";
import { DotsThree } from "@phosphor-icons/react/dist/ssr/DotsThree";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ProcessingStatusBadge } from "./document-processing-badge";
import { getDocumentUrlAction, deleteDocumentAction } from "@/server/documents/actions";
import { cn } from "@/lib/utils";
import type { AppDocument } from "@/server/db/repositories/documents";
import type { ProcessingJobStatus } from "@/domain/documents/intelligence/types";

const KIND_LABEL: Record<string, string> = {
  receipt: "Receipt",
  invoice: "Invoice",
  bill: "Bill",
  bank_statement: "Bank statement",
  tax_form: "Tax form",
  other: "Document",
};

function iconFor(mimeType: string | null) {
  if (mimeType?.startsWith("image/")) return FileImage;
  if (mimeType === "application/pdf") return FilePdf;
  return FileText;
}

function formatSize(bytes: number | null) {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The document library.
 *
 * It was a three-across grid of cards, each carrying a generic file icon, a
 * filename, a type and two competing buttons — one of which was Delete,
 * given equal weight to View on every single card. A filing cabinet is a
 * list: one row per document, sortable by eye down a column, with the
 * destructive action moved into a row menu where it takes an extra
 * deliberate step to reach.
 *
 * Nothing here claims extraction that did not happen. The Reading column shows
 * the latest job or extraction for the row and no more; the filename opens the
 * document page, where every value read is shown with where it came from.
 */
export function DocumentsList({
  organizationId,
  documents,
  readingStatus,
}: {
  organizationId: string;
  documents: AppDocument[];
  /** The latest job or extraction status per document; null when never read. */
  readingStatus: Record<string, ProcessingJobStatus | null>;
}) {
  const [pending, startTransition] = useTransition();

  const view = (documentId: string) => {
    startTransition(async () => {
      const url = await getDocumentUrlAction(organizationId, documentId);
      window.open(url, "_blank", "noopener,noreferrer");
    });
  };

  const remove = (documentId: string) => {
    startTransition(() => deleteDocumentAction(organizationId, documentId));
  };

  return (
    <Table fixed>
      <TableHeader>
        <TableRow>
          <TableHead className="w-full">Document</TableHead>
          <TableHead className="w-36">Type</TableHead>
          <TableHead className="w-44">Reading</TableHead>
          <TableHead className="w-28">Added</TableHead>
          <TableHead numeric className="w-24">
            Size
          </TableHead>
          <TableHead className="w-12">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {documents.map((doc) => {
          const Icon = iconFor(doc.mimeType);
          return (
            <TableRow key={doc.id} className={cn(pending && "opacity-70")}>
              <TableCell className="max-w-0">
                <span className="flex items-center gap-2.5">
                  <Icon size={16} aria-hidden="true" className="shrink-0 text-text-tertiary" />
                  <Link
                    href={`/app/${organizationId}/documents/${doc.id}`}
                    className="truncate rounded-sm text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {doc.originalFilename ?? "Untitled document"}
                  </Link>
                </span>
              </TableCell>
              <TableCell className="truncate text-[13px] text-text-secondary">{KIND_LABEL[doc.kind] ?? doc.kind}</TableCell>
              <TableCell>
                <ProcessingStatusBadge status={readingStatus[doc.id] ?? null} />
              </TableCell>
              <TableCell className="font-numeric text-[13px] text-text-tertiary">{doc.createdAt.slice(0, 10)}</TableCell>
              <TableCell numeric className="text-[13px] text-text-tertiary">
                {formatSize(doc.sizeBytes)}
              </TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Actions for ${doc.originalFilename ?? "document"}`}
                      className={cn(
                        "flex size-7 items-center justify-center rounded-sm text-text-tertiary",
                        "transition-colors duration-[var(--duration-fast)] ease-out hover:bg-surface-sunken hover:text-text-primary",
                        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                      )}
                    >
                      <DotsThree size={18} weight="bold" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuItem className="text-[14px]" asChild>
                      <Link href={`/app/${organizationId}/documents/${doc.id}`}>Details</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="text-[14px]" onSelect={() => view(doc.id)}>
                      Open file
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {/* Destructive actions live behind a menu and are tinted,
                        not filled — DESIGN.md §18 keeps them distinct without
                        making them the loudest thing in the row. */}
                    <DropdownMenuItem className="text-[14px] text-negative data-[highlighted]:bg-negative-subtle" onSelect={() => remove(doc.id)}>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
