"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";

/**
 * Root error boundary — everything outside /app/[orgId], which has its own.
 *
 * Covers the public marketing pages, the auth screens, /onboarding and /app
 * itself. Without it those routes fell through to Next's default screen: a
 * stack trace in development, a bare "Application error" in production.
 *
 * Shows no error text by design (DESIGN.md §18). `digest` is Next's
 * server-side correlation id and is the only safe thing to surface — it
 * identifies a log entry without disclosing schema, query shape or record
 * ids, which for a financial product is the difference between a support
 * reference and an information leak.
 */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Mirrors the reporting seam in src/lib/observability.ts. Client-side we
    // have only the digest — the real error stayed on the server, which is
    // exactly where it should have stayed.
    console.error("[route] boundary", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <main className="flex min-h-dvh items-center justify-center p-8">
      <div className="flex w-full max-w-md flex-col gap-4">
        <ErrorState
          title="Something went wrong"
          description="We hit an unexpected problem loading this page. Your data hasn't been changed — nothing was saved or modified."
          action={
            <div className="flex gap-2">
              <Button size="sm" onClick={reset}>
                Try again
              </Button>
              <Button asChild size="sm" variant="secondary">
                <Link href="/">Go to the homepage</Link>
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
    </main>
  );
}
