import { notFound } from "next/navigation";
import { ArrowsClockwise } from "@phosphor-icons/react/dist/ssr/ArrowsClockwise";
import { createClient } from "@/server/supabase/server";
import { getOrganization } from "@/server/db/repositories/organizations";
import { listInsights } from "@/server/db/repositories/insights";
import { getRecurringPatterns } from "@/server/insights/recurring";
import { InsightsPanel } from "@/components/insights/insights-panel";
import { PageHeader, PageMeta, PageMetaItem, PageShell } from "@/components/ui/page-header";
import { SectionHeading } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Amount } from "@/components/amount";
import { sum, zero } from "@/domain/money/money";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";
import { cn } from "@/lib/utils";

/**
 * The intelligence console.
 *
 * Two distinct things live here and they are now visually distinct: findings
 * that want a decision (InsightsPanel), and the standing commitments the
 * detector has inferred from repeated charges. The second used to be another
 * grid of cards; it is now a ruled table of obligations with an annualised
 * total in the section header, because "what am I committed to per year" is
 * the question a list of subscriptions is opened to answer.
 */
export default async function InsightsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const client = await createClient();
  const organization = await getOrganization(client, orgId);
  if (!organization) notFound();

  const [insights, recurringPatterns] = await Promise.all([listInsights(client, orgId), getRecurringPatterns(client, orgId)]);
  const currency: CurrencyCode = isSupportedCurrency(organization.baseCurrency) ? organization.baseCurrency : "USD";

  const annualTotal =
    recurringPatterns.length > 0
      ? sum(
          recurringPatterns.map((p) => p.annualizedCost),
          currency,
        )
      : zero(currency);

  return (
    <PageShell className="gap-10">
      <PageHeader
        eyebrow="Analysis"
        title="Insights"
        description="What Countorra noticed in your books, and the commitments it can see repeating."
        meta={
          <PageMeta>
            <PageMetaItem label="Open findings" value={insights.length} />
            <PageMetaItem label="Recurring charges" value={recurringPatterns.length} />
            {recurringPatterns.length > 0 && <PageMetaItem label="Committed per year" value={<Amount value={annualTotal} size="small" />} />}
          </PageMeta>
        }
      />

      <InsightsPanel organizationId={orgId} initialInsights={insights} currency={currency} />

      <section className="flex flex-col gap-4">
        <SectionHeading
          title="Recurring commitments"
          description="Charges that repeat on a predictable schedule, detected from your transaction history"
          action={recurringPatterns.length > 0 ? <Amount value={annualTotal} size="small" tone="muted" /> : undefined}
        />

        {recurringPatterns.length === 0 ? (
          <EmptyState
            icon={<ArrowsClockwise size={24} />}
            title="Nothing recurring detected yet"
            description="Once you have a few months of history, likely subscriptions and recurring bills will show up here."
          />
        ) : (
          <ul className="flex flex-col">
            {recurringPatterns.map((pattern) => (
              <li
                key={`${pattern.merchantId}-${pattern.interval}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border-subtle py-3.5 last:border-0"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[15px] font-medium text-text-primary">{pattern.merchantName}</span>
                    <Badge variant={pattern.confidence >= 0.8 ? "info" : "neutral"}>{pattern.confidence >= 0.8 ? "Likely" : "Possible"}</Badge>
                    {pattern.amountChangeMinor > 0 && <Badge variant="warning">Price increased</Badge>}
                  </span>
                  <span className="text-[12px] text-text-tertiary">
                    Every {pattern.interval.replace("ly", "")} · next expected <span className="font-numeric">{pattern.nextExpectedOn}</span>
                  </span>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
                  <Amount value={pattern.averageAmount} tone="ink" />
                  <span className={cn("text-[12px] text-text-tertiary")}>
                    <Amount value={pattern.annualizedCost} size="small" tone="muted" /> / year
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageShell>
  );
}
