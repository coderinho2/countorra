"use client";

import { useActionState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DEVELOPER_OVERRIDE_LABEL } from "@/domain/billing/developer-override";
import { setDeveloperPlanAction, type DeveloperPlanResult } from "@/server/billing/developer-actions";
import type { PlanTier } from "@/types/database";

/**
 * THE DEVELOPER'S TEST PLAN.
 *
 * Rendered only when the server has already established that the signed-in
 * person is a developer of this deployment AND an owner of this workspace.
 * This component receives that as a rendered fact; it decides nothing. The
 * action it posts to re-checks both conditions, so hiding this panel is a
 * courtesy rather than the boundary — the same rule every other surface in
 * Countorra follows.
 *
 * WHAT IT SAYS, AND WHY THE WORDING MATTERS
 *
 * It never claims a subscription. The effective plan is labelled "Premium —
 * Test override", and the real billed plan is printed beside it, because the
 * one thing this panel must not do is leave somebody unsure whether a
 * workspace is actually being charged.
 */

const PLANS: readonly { id: PlanTier; label: string }[] = [
  { id: "free", label: "Free" },
  { id: "premium", label: "Premium" },
  { id: "business", label: "Business" },
];

export interface DeveloperPlanPanelProps {
  organizationId: string;
  /** The tier currently forced, or null when the override is off. */
  override: PlanTier | null;
  /** The REAL plan's name, whatever the override says. Printed beside the
   *  effective plan so nobody is left unsure what is being charged. */
  billedPlanName: string;
}

export function DeveloperPlanPanel({ organizationId, override, billedPlanName }: DeveloperPlanPanelProps) {
  const [state, submit, pending] = useActionState<DeveloperPlanResult, FormData>(setDeveloperPlanAction, {});

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-[15px] font-medium text-text-primary">
            {override ? PLANS.find((plan) => plan.id === override)?.label : billedPlanName}
            {/* Never colour alone — the badge carries its own words. */}
            <Badge variant={override ? "warning" : "neutral"}>{override ? DEVELOPER_OVERRIDE_LABEL : "Off"}</Badge>
          </p>
          <p className="text-[13px] text-text-secondary">
            {override
              ? `This workspace behaves as ${override} for you. Billing is unchanged: it is really on ${billedPlanName}.`
              : `No override. This workspace is on ${billedPlanName}, as billing says.`}
          </p>
        </div>
      </div>

      <form action={submit} className="flex flex-col gap-3 border-t border-border-subtle pt-4">
        <input type="hidden" name="organizationId" value={organizationId} />
        <div className="flex flex-wrap items-center gap-2">
          {PLANS.map((plan) => (
            <Button
              key={plan.id}
              type="submit"
              name="plan"
              value={plan.id}
              size="sm"
              variant={override === plan.id ? "secondary" : "ghost"}
              disabled={pending}
              aria-pressed={override === plan.id}
            >
              {plan.label}
            </Button>
          ))}
          <Button type="submit" name="plan" value="off" size="sm" variant="ghost" disabled={pending || override === null}>
            Turn off
          </Button>
        </div>
        <p className="max-w-[70ch] text-[13px] text-text-tertiary">
          Entitlements only. Nothing here creates or changes a Stripe customer, subscription or invoice, and it applies to this workspace for accounts on this
          deployment&apos;s developer list — not to anybody else.
        </p>
        {state.error && (
          <p role="alert" className="text-[13px] text-negative">
            {state.error}
          </p>
        )}
        {state.message && (
          <p role="status" className="text-[13px] text-text-secondary">
            {state.message}
          </p>
        )}
      </form>
    </div>
  );
}
