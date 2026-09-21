import type { Metadata } from "next";
import { Fragment } from "react";
import { Check } from "@phosphor-icons/react/dist/ssr/Check";
import { Clock } from "@phosphor-icons/react/dist/ssr/Clock";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Reveal } from "@/components/marketing/reveal";
import { EntitySegments } from "@/components/marketing/entity-segments";
import { CtaSection } from "@/components/marketing/cta-section";
import { PlanCta } from "@/components/billing/plan-cta";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatAiMessageLimit } from "@/domain/billing/limits";
import { FEATURE_IMPLEMENTED, PLAN_ENTITLEMENTS, formatOrganizationAllowance, type GatedFeature } from "@/domain/billing/entitlements";
import { formatPlanPrice, planFeatureLines, planPriceNote, type FeatureState } from "@/domain/billing/plan-presentation";
import { ctaModeFor, resolveBillingViewer } from "@/server/billing/viewer-context";
import type { PlanTier } from "@/types/database";

export const metadata: Metadata = {
  title: "Pricing — Countorra",
  description: "One financial system, priced by how much of it you use.",
};

/**
 * Pricing.
 *
 * EVERY NUMBER ON THIS PAGE IS READ FROM `PLAN_ENTITLEMENTS`.
 *
 * It used to hardcode them — "20 AI messages per day", "300 AI messages per
 * day", "Unlimited AI messages" — in a `PLANS` array beside the layout. That
 * is a published promise stored in a component, checked by nothing, and it
 * went stale the moment the plan definitions changed. The server would refuse
 * at 3 while the page advertised 20, and no test would fail.
 *
 * Now the page renders `PLAN_ENTITLEMENTS[tier].aiMessagesPerDay`. It cannot
 * disagree with what `sendAiMessage` enforces, because it is the same value.
 *
 * FEATURES THAT DO NOT EXIST YET ARE MARKED, NOT CLAIMED.
 *
 * Premium and Business are entitled to OCR, advanced tax tooling, bank
 * connections and (for Business) priority support. None of those are
 * implemented. Rendering a checkmark for them would be selling something that
 * cannot be delivered, so `FEATURE_IMPLEMENTED` — declared next to the
 * entitlements, not here — downgrades every one of them to "Coming soon".
 * The day a feature ships, one boolean flips and this page starts telling the
 * truth about it automatically.
 */

const TAGLINES: Record<PlanTier, string> = {
  free: "For getting started, and for seeing your own numbers clearly.",
  premium: "For people who want bank connections and deeper financial intelligence.",
  // "Business" is the name of the plan tier, not the kind of workspace:
  // every workspace is personal at launch (src/domain/organizations/launch-scope.ts).
  business: "For households and heavy users who need more workspaces and more AI.",
};

const PLANS = (["free", "premium", "business"] as const).map((tier) => {
  const plan = PLAN_ENTITLEMENTS[tier];
  return {
    id: tier,
    name: plan.name,
    tagline: TAGLINES[tier],
    priceLabel: formatPlanPrice(tier),
    priceNote: planPriceNote(tier),
    recommended: tier === "premium",
    aiLimit: formatAiMessageLimit(tier),
    organizations: plan.maxOrganizations === null ? "Unlimited" : formatOrganizationAllowance(plan.maxOrganizations),
    /** Same derived list the comparison table and Settings render. */
    features: planFeatureLines(tier),
  };
});

/**
 * Bar heights, on a square-root scale against the largest allowance.
 *
 * The allowances span 167× (3 to 500). Drawn linearly, Free is a 10px stub
 * next to Business's 160px — it reads as "nothing", not "a small amount",
 * which is both bad charting and, on a pricing page, flattering to us in the
 * wrong direction: it makes the free tier look worthless. A square root
 * compresses the range enough for all three to be legible while keeping the
 * ordering strictly monotonic.
 *
 * This is safe to do here only because the exact figure is printed under
 * every bar (`value` below). The number carries the precision; the bar
 * carries the ranking.
 */
const USAGE_STEPS = (["free", "premium", "business"] as const).map((tier) => ({
  plan: PLAN_ENTITLEMENTS[tier].name,
  value: formatAiMessageLimit(tier),
  heightPercent: Math.max(
    10,
    Math.round(Math.sqrt(PLAN_ENTITLEMENTS[tier].aiMessagesPerDay / PLAN_ENTITLEMENTS.business.aiMessagesPerDay) * 100),
  ),
}));

/** A cell value: a string, a plain yes/no, or an entitlement that is granted
 *  by the plan but not yet built. */
type CellValue = string | boolean | { comingSoon: true };

function featureCell(tier: PlanTier, feature: GatedFeature): CellValue {
  const entitled = PLAN_ENTITLEMENTS[tier][feature];
  if (!entitled) return false;
  return FEATURE_IMPLEMENTED[feature] ? true : { comingSoon: true };
}

const COMPARISON_GROUPS = [
  {
    label: "Intelligence",
    rows: [
      { label: "Ask Countorra", render: (p: (typeof PLANS)[number]): CellValue => p.aiLimit },
      { label: "Document OCR & extraction", render: (p: (typeof PLANS)[number]): CellValue => featureCell(p.id, "documentProcessing") },
      { label: "Advanced tax tools", render: (p: (typeof PLANS)[number]): CellValue => featureCell(p.id, "advancedTaxTools") },
    ],
  },
  {
    label: "Connections",
    rows: [{ label: "Bank connections (Plaid)", render: (p: (typeof PLANS)[number]): CellValue => featureCell(p.id, "bankConnections") }],
  },
  {
    label: "Organizations",
    rows: [{ label: "Organizations", render: (p: (typeof PLANS)[number]): CellValue => p.organizations }],
  },
  {
    label: "Documents",
    rows: [{ label: "Private document storage", render: (): CellValue => true }],
  },
  {
    label: "Support",
    rows: [{ label: "Priority support", render: (p: (typeof PLANS)[number]): CellValue => featureCell(p.id, "prioritySupport") }],
  },
] as const;

function Cell({ value }: { value: CellValue }) {
  if (typeof value === "string") return <span className="font-numeric text-[14px] text-text-primary">{value}</span>;
  if (typeof value === "object") {
    // Included in the plan, not yet built. Said plainly rather than shown as
    // a checkmark — a tick here would be a promise the product cannot keep.
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] whitespace-nowrap text-text-tertiary">
        <Clock size={13} aria-hidden="true" />
        Coming soon
      </span>
    );
  }
  return value ? <Check size={16} weight="bold" className="text-positive" /> : <span className="text-text-tertiary">—</span>;
}

/** ✓ for what a plan includes, — for what it does not, a clock for what it
 *  will. Three marks because there are three states; a tick on an unbuilt
 *  feature would be a promise, and a dash would understate the plan. */
function FeatureMark({ state }: { state: FeatureState }) {
  if (state === "included") return <Check size={14} weight="bold" aria-label="Included" className="mt-0.5 shrink-0 text-positive" />;
  if (state === "coming-soon") return <Clock size={14} aria-label="Coming soon" className="mt-0.5 shrink-0 text-text-tertiary" />;
  return (
    <span aria-label="Not included" className="mt-0.5 w-[14px] shrink-0 text-center text-text-tertiary">
      —
    </span>
  );
}

export default async function PricingPage() {
  // Resolved server-side from the session. Decides what each card's button
  // says; `createCheckoutSession` re-checks what it may do regardless.
  const viewer = await resolveBillingViewer();

  return (
    <MarketingShell>
      {/* 1. Editorial hero */}
      <section className="mx-auto max-w-[820px] px-6 pt-20 pb-16 text-center lg:px-10 lg:pt-28">
        <Reveal>
          <p className="font-numeric text-[11px] tracking-[0.14em] text-text-tertiary uppercase">Countorra / Plans</p>
          <h1 className="font-serif font-normal tracking-[0] mx-auto mt-4 max-w-[22ch] text-[40px] leading-[46px] text-ink sm:text-[52px] sm:leading-[60px]">
            One financial system. Priced by how far you take it.
          </h1>
          <p className="mx-auto mt-6 max-w-[54ch] text-[17px] leading-[27px] text-text-secondary">
            Every plan runs on the same ledger, the same organization-level security, and the same AI assistant. What
            changes between them is how much of it you can use.
          </p>
        </Reveal>
      </section>

      {/* 2. Pricing plans */}
      <section className="border-t border-border-subtle">
        <div className="mx-auto max-w-[1100px] px-6 py-16 lg:px-10 lg:py-20">
          <Reveal>
            <div className="grid grid-cols-1 overflow-hidden rounded-lg border border-border-subtle lg:grid-cols-3">
              {PLANS.map((plan, i) => (
                <div
                  key={plan.id}
                  className={cn(
                    "relative flex flex-col gap-6 p-8",
                    i > 0 && "border-t border-border-subtle lg:border-t-0 lg:border-l",
                    plan.recommended ? "border-border bg-surface" : "bg-surface-sunken/40",
                  )}
                >
                  {plan.recommended && <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-gold" />}
                  <div className="flex flex-col gap-3">
                    <div className="flex h-4 items-center">
                      {plan.recommended && (
                        <span className="font-numeric text-[10px] tracking-[0.14em] text-accent uppercase">Recommended</span>
                      )}
                    </div>
                    <h2 className="text-[20px] font-semibold tracking-[-0.005em] text-ink">{plan.name}</h2>
                    <p className="min-h-[40px] text-[13px] leading-[1.6] text-text-secondary">{plan.tagline}</p>
                  </div>

                  <div className="flex flex-col gap-1 border-t border-border-subtle pt-6">
                    <span className="font-numeric text-4xl font-medium text-ink">{plan.priceLabel}</span>
                    <span className="text-[13px] text-text-tertiary">{plan.priceNote}</span>
                  </div>

                  {/* The CTA sits directly under the price, ABOVE the feature
                      list. Someone who has decided on a plan should not have to
                      read past everything it includes to find the button —
                      and someone still deciding scrolls the list with the
                      button already in view. */}
                  <div>
                    <PlanCta plan={plan.id} planName={plan.name} mode={ctaModeFor(viewer, plan.id)} />
                  </div>

                  <ul className="flex flex-1 flex-col gap-2.5 border-t border-border-subtle pt-6">
                    {plan.features.map((feature) => (
                      <li
                        key={feature.label}
                        className={cn(
                          "flex items-start gap-2 text-[13px]",
                          feature.state === "included" ? "text-text-secondary" : "text-text-tertiary",
                        )}
                      >
                        <FeatureMark state={feature.state} />
                        <span>
                          {feature.label}
                          {feature.state === "coming-soon" && <span className="text-text-tertiary"> — coming soon</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Reveal>

          <Reveal delayMs={60}>
            <p className="mt-8 flex items-center justify-center gap-2 font-numeric text-[11px] tracking-[0.02em] text-text-tertiary uppercase">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-border-strong" />
              Every plan runs the same ledger, the same isolation, and the same assistant
            </p>
          </Reveal>
        </div>
      </section>

      {/* 3. Ask Countorra — capacity visualization */}
      <section className="border-t border-border-subtle bg-surface-sunken/40">
        <div className="mx-auto max-w-[1100px] px-6 py-16 lg:px-10 lg:py-20">
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center">
            <Reveal>
              <h2 className="text-2xl font-semibold tracking-[-0.01em] text-ink sm:text-[28px]">
                Ask Countorra grows with your plan.
              </h2>
              <p className="mt-3 max-w-[46ch] text-[15px] leading-[1.6] text-text-secondary">
                The assistant is the same on every plan — real answers grounded in your actual transactions and
                invoices, never invented. What scales is how many questions you can ask it in a day.
              </p>
            </Reveal>

            <Reveal delayMs={80}>
              <div className="flex items-end justify-center gap-10 rounded-lg border border-border-subtle bg-surface px-8 py-10 sm:gap-16">
                {USAGE_STEPS.map((step) => (
                  <div key={step.plan} className="flex flex-col items-center gap-3">
                    <div className="flex h-40 flex-col justify-end">
                      <div
                        className="w-12 rounded-t-sm border border-b-0 border-border bg-surface-sunken sm:w-16"
                        style={{ height: `${step.heightPercent}%` }}
                        aria-hidden="true"
                      />
                    </div>
                    <span className="font-numeric text-[15px] font-medium text-ink">{step.value}</span>
                    <span className="text-[12px] text-text-tertiary">{step.plan}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* 4. Feature comparison */}
      <section className="border-t border-border-subtle">
        <div className="mx-auto max-w-[1100px] px-6 py-16 lg:px-10 lg:py-20">
          <Reveal>
            <h2 className="text-2xl font-semibold tracking-[-0.01em] text-ink sm:text-[28px]">Plan specification</h2>
          </Reveal>

          <Reveal delayMs={80} className="mt-8 overflow-x-auto rounded-lg border border-border-subtle">
            <Table className="min-w-[640px]">
              <TableHeader className="static">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Plan</TableHead>
                  {PLANS.map((plan) => (
                    <TableHead key={plan.id} numeric className="text-text-primary">
                      {plan.name}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {COMPARISON_GROUPS.map((group) => (
                  <Fragment key={group.label}>
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={4} className="h-9 bg-surface-sunken/60 text-[11px] font-semibold tracking-[0.1em] text-text-tertiary uppercase">
                        {group.label}
                      </TableCell>
                    </TableRow>
                    {group.rows.map((row) => (
                      <TableRow key={row.label}>
                        <TableCell className="text-text-secondary">{row.label}</TableCell>
                        {PLANS.map((plan) => (
                          <TableCell key={`${row.label}-${plan.id}`} numeric>
                            <Cell value={row.render(plan)} />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </Reveal>
        </div>
      </section>

      {/* 6. Product-context: what a personal workspace includes */}
      <section className="border-t border-border-subtle bg-surface-sunken/40">
        <div className="mx-auto max-w-[1100px] px-6 py-16 lg:px-10 lg:py-20">
          <Reveal>
            <h2 className="max-w-[36ch] text-2xl font-semibold tracking-[-0.01em] text-ink sm:text-[28px]">
              What every workspace includes.
            </h2>
          </Reveal>
          <Reveal delayMs={80} className="mt-10">
            <EntitySegments />
          </Reveal>
        </div>
      </section>

      {/* 7. Closing CTA */}
      <section className="border-t border-border-subtle">
        <div className="mx-auto max-w-[1200px] px-6 py-16 lg:px-10">
          <Reveal>
            <CtaSection />
          </Reveal>
        </div>
      </section>
    </MarketingShell>
  );
}
