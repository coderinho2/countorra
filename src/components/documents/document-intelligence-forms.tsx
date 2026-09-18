"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { processDocumentAction, proposeDocumentFactsAction, type DocumentIntelligenceActionResult } from "@/server/documents/intelligence-actions";

/**
 * The two things a person can do with a document's reading.
 *
 * Both post only ids. The server re-derives everything else — what the
 * document is, which reader applies, which figures may be proposed — so there
 * is nothing on this form a person could change to alter the outcome.
 */

function Result({ state }: { state: DocumentIntelligenceActionResult }) {
  if (state.error) {
    return (
      <p role="alert" className="max-w-[60ch] text-[13px] text-text-secondary">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p role="status" className="max-w-[60ch] text-[13px] text-text-secondary">
        {state.message}
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
