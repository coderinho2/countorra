"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { createCheckoutSession } from "@/server/billing/actions";
import type { PlanTier } from "@/types/database";

/**
 * The call to action inside a plan card.
 *
 * WHAT THE CLIENT IS TRUSTED WITH
 *
 * A plan NAME and an organization id. Not a price, not an amount, not a
 * Stripe identifier of any kind. `createCheckoutSession` re-derives the
 * caller's membership and role from their session, looks the price id up from
 * server-only configuration, and refuses anything it did not choose itself —
 * so the props below are a request, not an instruction.
 *
 * `relation` and `currentPlan` drive the LABEL only. They are computed on the
 * server that rendered the page, and a client that lied about them would
 * change what the button says, not what it is allowed to do.
 */

export type PlanCtaMode =
  /** Signed out — nothing to buy yet, make an account first. */
  | { kind: "signed-out" }
  /** This is the plan the workspace is already on. */
  | { kind: "current" }
  /** Purchasable, and we know exactly which workspace to charge. */
  | { kind: "checkout"; organizationId: string }
  /** Purchasable, but the viewer owns several workspaces and only they can
   *  say which one is upgrading. */
  | { kind: "choose-workspace"; href: string }
  /** A cheaper plan than the one they are on. Not a purchase. */
  | { kind: "downgrade"; href: string | null }
  /** Stripe is not connected on this deployment. */
  | { kind: "unavailable" };

export function PlanCta({ plan, planName, mode }: { plan: PlanTier; planName: string; mode: PlanCtaMode }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (mode.kind === "current") {
    return (
      <div className="flex h-9 items-center justify-center rounded-md border border-border-subtle bg-surface-sunken text-[13px] font-medium text-text-secondary">
        Current plan
      </div>
    );
  }

  if (mode.kind === "unavailable") {
    // Deliberately not a disabled-looking button with no explanation. The
    // product is not broken and the plan is not sold out — billing simply
    // has not been connected yet, and saying so is the honest state.
    return (
      <div className="flex h-9 items-center justify-center rounded-md border border-dashed border-border text-[13px] text-text-tertiary">
        Billing setup required
      </div>
    );
  }

  if (mode.kind === "signed-out") {
    return (
      <Button asChild className="w-full justify-center">
        <Link href={`/signup?plan=${plan}`}>Get started</Link>
      </Button>
    );
  }

  if (mode.kind === "choose-workspace") {
    // Several owned workspaces, and only one of them should be charged.
    // Guessing would put a real subscription on the wrong one.
    return (
      <Button asChild variant="secondary" className="w-full justify-center">
        <Link href={mode.href}>Choose a workspace</Link>
      </Button>
    );
  }

  if (mode.kind === "downgrade") {
    // Moving to a cheaper plan is a change to an existing subscription:
    // proration and period end are Stripe's job, in the portal.
    return mode.href ? (
      <Button asChild variant="ghost" className="w-full justify-center">
        <Link href={mode.href}>Manage billing</Link>
      </Button>
    ) : (
      <div className="flex h-9 items-center justify-center text-[13px] text-text-tertiary">Included in your plan</div>
    );
  }

  const organizationId = mode.organizationId;

  function upgrade() {
    setError(null);
    startTransition(async () => {
      const result = await createCheckoutSession({ organizationId, plan });

      if (result.url) {
        // Stripe-hosted. Full navigation, not a router push: it is a
        // different origin.
        window.location.assign(result.url);
        return;
      }
      setError(result.error ?? "We couldn't start checkout.");
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button onClick={upgrade} disabled={pending} className="w-full justify-center">
        {pending ? "Starting…" : `Upgrade to ${planName}`}
      </Button>
      {error && (
        <p role="alert" className="text-[12px] leading-[1.5] text-negative">
          {error}
        </p>
      )}
    </div>
  );
}
