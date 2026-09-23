"use client";

import { useActionState } from "react";
import { Warning } from "@phosphor-icons/react/dist/ssr/Warning";
import { CheckCircle } from "@phosphor-icons/react/dist/ssr/CheckCircle";
import { Button } from "@/components/ui/button";
import { processDocumentAction, proposeDocumentFactsAction, type DocumentIntelligenceActionResult } from "@/server/documents/intelligence-actions";

/**
 * The two things a person can do with a document's reading.
 *
 * Both post only ids. The server re-derives everything else — what the
 * document is, which reader applies, which figures may be proposed — so there
 * is nothing on this form a person could change to alter the outcome.
 */

/**
 * The outcome of a read.
 *
 * A failure and a success used to render identically — same size, same
 * colour, same position — so "couldn't read this document" and "read, review
 * the figures" were distinguishable only by reading them. They carry an icon
 * and their semantic token now, which is DESIGN.md §24's rule that status is
 * never colour alone and never text alone either.
 *
 * Deliberately not a banner, a card or a toast: this sits under the button
 * that caused it, which is where the eye already is, and a failed read is a
 * normal outcome of photographing a receipt badly rather than an incident.
 * The sentences themselves come from FAILURE_MESSAGES on the server, so they
 * say what to do differently and never name the reader.
 */
function Result({ state }: { state: DocumentIntelligenceActionResult }) {
  if (state.error) {
    return (
      <p role="alert" className="flex max-w-[60ch] items-start gap-1.5 text-[13px] leading-[1.6] text-negative">
        <Warning size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>{state.error}</span>
      </p>
    );
  }
  if (state.message) {
    return (
      <p role="status" className="flex max-w-[60ch] items-start gap-1.5 text-[13px] leading-[1.6] text-text-secondary">
        <CheckCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-positive" />
        <span>{state.message}</span>
      </p>
    );
  }
  return null;
}

export function ReadDocumentForm({ organizationId, documentId, label }: { organizationId: string; documentId: string; label: string }) {
  const [state, formAction, pending] = useActionState(processDocumentAction, {});
  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="documentId" value={documentId} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Reading…" : label}
      </Button>
      <Result state={state} />
    </form>
  );
}

export function ProposeFactsForm({ organizationId, extractionId, count, taxYear }: { organizationId: string; extractionId: string; count: number; taxYear: number }) {
  const [state, formAction, pending] = useActionState(proposeDocumentFactsAction, {});
  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="extractionId" value={extractionId} />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? "Adding…" : `Suggest ${count} ${count === 1 ? "figure" : "figures"} to Tax preparation ${taxYear}`}
      </Button>
      <Result state={state} />
    </form>
  );
}
