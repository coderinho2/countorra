"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { createBillingPortalSession } from "@/server/billing/actions";

/**
 * Opens the Stripe Customer Portal for this workspace.
 *
 * The organization id is the ONLY thing that travels. The Stripe customer id
 * is read server-side from that organization's own subscription row, so there
 * is nothing here for a caller to substitute — and `billing:manage` is
 * re-checked against the session before any session is created.
 */
export function ManageBillingButton({ organizationId, label = "Manage billing" }: { organizationId: string; label?: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function open() {
    setError(null);
    startTransition(async () => {
      const result = await createBillingPortalSession({ organizationId });
      if (result.url) {
        window.location.assign(result.url);
        return;
      }
      setError(result.error ?? "We couldn't open the billing portal.");
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button size="sm" variant="secondary" onClick={open} disabled={pending}>
        {pending ? "Opening…" : label}
      </Button>
      {error && (
        <p role="alert" className="max-w-[32ch] text-right text-[12px] leading-[1.5] text-negative">
          {error}
        </p>
      )}
    </div>
  );
}
