"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";

/**
 * Route-level error boundary for every screen inside an organization.
 *
 * Without this, a thrown error in any page anywhere under /app/[orgId]
 * falls through to Next's default error screen — which shows a stack trace
 * in development and a bare "Application error" in production, and in both
 * cases loses the sidebar, so the user cannot navigate away from a broken
 * page without editing the URL. This keeps the shell intact and offers the
 * two things that actually recover: retry, or go somewhere that works.
 *
 * Deliberately shows no error text (DESIGN.md §18: never a stack trace by
 * default). `digest` is the server-generated correlation id Next attaches to
 * production errors and is the only thing safe to surface — it identifies
 * the log entry without revealing what went wrong, which for a financial
 * product could otherwise disclose schema, query shape or record ids.
 */
export default function OrganizationError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Report to the server console; the browser console gets nothing useful
    // in production anyway, and there is no telemetry vendor in this stack.
    console.error("[app] route error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <div className="page-enter flex flex-1 items-center justify-center p-8">
      <div className="flex w-full max-w-md flex-col gap-4">
        <ErrorState
          title="This page couldn't load"
          description="Something went wrong on our side. Your data hasn't been changed — nothing on this screen was saved or modified."
          action={
            <div className="flex gap-2">
              <Button size="sm" onClick={reset}>
                Try again
              </Button>
              <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
                Reload the page
              </Button>
            </div>
          }
        />
        {error.digest && (
          <p className="text-[13px] text-text-tertiary">
            Reference <span className="font-numeric">{error.digest}</span> — quote this if you contact support.
          </p>
        )}
      </div>
    </div>
  );
}
