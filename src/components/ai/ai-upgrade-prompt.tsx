import Link from "next/link";
import { ArrowUp } from "@phosphor-icons/react/dist/ssr/ArrowUp";
import { Button } from "@/components/ui/button";
import { formatAiMessageLimit } from "@/domain/billing/limits";
import { PLAN_ENTITLEMENTS, formatOrganizationAllowance } from "@/domain/billing/entitlements";
import type { PlanTier } from "@/types/database";

/**
 * Derived from the canonical entitlements rather than written out.
 *
 * The previous version hardcoded "300 AI messages/day instead of 20" and
 * "Unlimited AI messages". Both became false the moment the plan definitions
 * changed, and nothing would have failed — a string in a component is not
 * checked against anything. Building the sentence from `PLAN_ENTITLEMENTS`
 * means the upgrade prompt cannot advertise a number the server will not
 * honour.
 *
 * Only entitlements that are REAL today appear here. OCR, tax tooling, bank
 * connections and priority support are entitlements of the paid tiers but are
 * not implemented, so promising them at the moment a user hits a limit would
 * be selling against a feature that does not exist.
 */
function nextPlanBenefits(plan: PlanTier): string[] {
  const upgrade: Partial<Record<PlanTier, PlanTier>> = { free: "premium", premium: "business" };
  const target = upgrade[plan];
  if (!target) return [];

  const current = PLAN_ENTITLEMENTS[plan];
  const next = PLAN_ENTITLEMENTS[target];

  return [
    `${next.aiMessagesPerDay} AI messages a day instead of ${current.aiMessagesPerDay}`,
    next.maxOrganizations === null ? "Unlimited organizations" : `Up to ${formatOrganizationAllowance(next.maxOrganizations)}`,
  ];
}

/**
 * Real upgrade UX for a real, server-enforced limit (DESIGN brief §5) —
 * shown only when src/server/ai/actions.ts#sendAiMessage actually returns
 * `limitReached: true`. No fake checkout: the CTA goes to /pricing, which
 * is honest about Premium/Business not being purchasable yet (DESIGN.md
 * §10 card treatment — hairline border, no shadow, no gradient).
 */
export function AiUpgradePrompt({ plan }: { plan: PlanTier }) {
  const benefits = nextPlanBenefits(plan);
  return (
    <div className="mt-2 mb-4 flex flex-col gap-3 rounded-md border border-border-subtle bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-sm border border-border-subtle bg-surface-sunken text-accent">
          <ArrowUp size={16} />
        </span>
        <div>
          <p className="text-[15px] font-medium text-text-primary">You&apos;ve reached today&apos;s {plan} plan limit</p>
          <p className="mt-0.5 text-[13px] text-text-secondary">
            The {plan} plan includes {formatAiMessageLimit(plan)} of AI messages per organization. Your limit resets in the next 24 hours.
          </p>
        </div>
      </div>

      {benefits.length > 0 && (
        <ul className="ml-11 flex flex-col gap-1">
          {benefits.map((benefit) => (
            <li key={benefit} className="text-[13px] text-text-secondary">
              — {benefit}
            </li>
          ))}
        </ul>
      )}

      <div className="ml-11">
        <Button asChild size="sm" variant="secondary">
          <Link href="/pricing">See plans</Link>
        </Button>
      </div>
    </div>
  );
}
