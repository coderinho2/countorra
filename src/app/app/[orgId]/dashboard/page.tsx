import * as React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr/ArrowUpRight";
import { ArrowDownRight } from "@phosphor-icons/react/dist/ssr/ArrowDownRight";
import { createClient } from "@/server/supabase/server";
import { getOrganization } from "@/server/db/repositories/organizations";
import { getDashboardData } from "@/server/dashboard/get-dashboard-data";
import { Amount } from "@/components/amount";
import { Sparkline } from "@/components/charts/sparkline";
import { AttentionRow } from "@/components/attention-row";
import { MonthlyBarChart } from "@/components/charts/monthly-bar-chart";
import { CategoryBreakdown } from "@/components/charts/category-breakdown";
import { PageShell } from "@/components/ui/page-header";
import { Panel, PanelFooter, SectionHeading } from "@/components/ui/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { money, subtract, zero, type Money } from "@/domain/money/money";
import { isSupportedCurrency } from "@/domain/money/currency";
import { cn } from "@/lib/utils";
import { healthLabel } from "@/domain/insights/financial-health";
import { isModuleEnabled } from "@/domain/organizations/launch-scope";

/** DB currency columns are plain `text`, not the narrowed `CurrencyCode`
 *  union — this is the one place that boundary gets checked before handing a
 *  value to src/domain/money, rather than casting past it. */
function safeMoney(amountMinor: number, currency: string) {
  return isSupportedCurrency(currency) ? money(amountMinor, currency) : zero("USD");
}

function daysBetween(iso: string, nowMs: number): number {
  return Math.floor((nowMs - new Date(`${iso}T00:00:00Z`).getTime()) / 86_400_000);
}

/**
 * A figure on the delta band.
 *
 * Typeset like a row of a financial statement rather than as three cards:
 * micro mono label, figure, delta, separated by vertical hairlines.
 * DESIGN.md §26 bans the equal-card row outright, and this is what replaces
 * it — the same information with a quarter of the chrome, read across in one
 * pass.
 *
 * `favourableDirection` exists because colouring purely by arithmetic sign
 * produced the exact wrong reading: "Expenses −87% vs. last month" in
 * negative red tells an owner that spending far less was bad news. The
 * semantic colours mean money-good and money-bad (§3), not greater and less.
 */
function Metric({
  label,
  value,
  changePercent,
  favourableDirection = "up",
}: {
  label: string;
  value: Money;
  changePercent?: number | null;
  favourableDirection?: "up" | "down";
}) {
  const hasChange = changePercent !== undefined && changePercent !== null;
  const rose = hasChange && changePercent >= 0;
  const favourable = favourableDirection === "up" ? rose : !rose;
  const TrendIcon = rose ? ArrowUpRight : ArrowDownRight;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="font-numeric text-text-tertiary text-[10px] tracking-[0.08em] uppercase">{label}</span>
      <Amount value={value} size="prominent" tone="ink" />
      {hasChange ? (
        <span className={cn("flex items-center gap-1 text-[12px]", favourable ? "text-positive" : "text-negative")}>
          <TrendIcon weight="bold" className="size-3 shrink-0" aria-hidden="true" />
          <span className="font-numeric">
            {rose ? "+" : ""}
            {changePercent}%
          </span>
          <span className="text-text-tertiary">vs. last month</span>
        </span>
      ) : (
        <span className="text-text-tertiary text-[12px]">this month</span>
      )}
    </div>
  );
}

/**
 * The financial command center (product spec §7, DESIGN.md §15).
 *
 * Composed as a numbered document, not a widget board: five ruled sections in
 * the order the questions actually get asked — where am I, what is wrong,
 * what has been happening, why, and what exactly moved.
 *
 * The position band is a deliberate asymmetric split. The figure owns the
 * left column outright and six months of shape owns the right; nothing else
 * competes in that band. The hero figure itself stays at the 40px H1 numeric
 * scale because DESIGN.md §4 is explicit that in-app screens never exceed it
 * — so dominance is bought with composition and air (a band to itself, a
 * sparkline more than twice its previous size, every other figure on the page
 * dropped to the 22px scale) rather than by breaking the type scale.
 */
export default async function DashboardPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const client = await createClient();
  const organization = await getOrganization(client, orgId);
  if (!organization) notFound();

  const data = await getDashboardData(client, organization);

  const netByMonth = data.monthlyTotals.map((m) => subtract(m.income, m.expense).amountMinor);
  const netTrend = netByMonth.length > 1 ? netByMonth[netByMonth.length - 1] - netByMonth[0] : 0;

  const nowMs = new Date().getTime();
  // Invoicing is deferred at launch (src/domain/organizations/launch-scope.ts):
  // an overdue invoice from before would link to a page that is switched off.
  const overdue = isModuleEnabled("invoicing") ? data.overdueInvoices.slice(0, 4) : [];
  const attentionCount = overdue.length + data.insights.length;

  // Section numbers must stay contiguous when a section is absent — an
  // "01, 03, 04" run reads as a rendering bug, not as a document.
  let step = 0;
  const nextStep = () => ++step;

  return (
    <PageShell className="gap-12">
      {/* ── Masthead ───────────────────────────────────────────────────── */}
      <header className="border-border flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b pb-4">
        <h1 className="font-numeric text-text-secondary text-[11px] tracking-[0.14em] uppercase">Overview</h1>
        <p className="font-numeric text-text-tertiary text-[11px] tracking-[0.02em] uppercase">{data.monthlyTotals.length} month window</p>
      </header>

      {/* ── 01 Position ────────────────────────────────────────────────── */}
      <section className="section-enter flex flex-col gap-6" style={{ "--enter-index": 0 } as React.CSSProperties}>
        <SectionHeading index={nextStep()} title="Position" />

        <div className="grid grid-cols-1 items-end gap-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-16">
          <div className="flex flex-col gap-2">
            <span className="text-text-secondary text-[13px]">Available balance</span>
            <Amount value={data.totalBalance} size="hero" tone="ink" />
            <span className="text-text-tertiary text-[13px]">
              Across {data.accountCount} {data.accountCount === 1 ? "account" : "accounts"}
            </span>
          </div>

          {netByMonth.length > 1 && (
            <div className="flex flex-col items-start gap-2 lg:items-end">
              <Sparkline values={netByMonth} width={320} height={64} ariaLabel="Net movement over the last six months" className="w-full max-w-[320px]" />
              <span className="font-numeric text-text-tertiary flex items-center gap-2 text-[10px] tracking-[0.08em] uppercase">
                Net movement
                <span aria-hidden="true" className="bg-border h-px w-4" />
                <span className={netTrend >= 0 ? "text-positive" : "text-negative"}>{netTrend >= 0 ? "Rising" : "Falling"}</span>
              </span>
            </div>
          )}
        </div>

        <dl
          className="border-border-subtle sm:divide-border-subtle grid grid-cols-2 gap-x-6 gap-y-6 border-t pt-6 sm:grid-cols-2 sm:gap-x-0 sm:divide-x"
        >
          <div className="sm:pr-10">
            <Metric label="Income this month" value={data.thisMonth.income} changePercent={data.comparisonVsLastMonth.incomePercentChange} />
          </div>
          <div className="sm:px-10">
            <Metric
              label="Expenses this month"
              value={data.thisMonth.expense}
              changePercent={data.comparisonVsLastMonth.expensePercentChange}
              favourableDirection="down"
            />
          </div>
        </dl>
      </section>

      {/* ── 02 Attention ───────────────────────────────────────────────── */}
      {attentionCount > 0 && (
        <section className="section-enter flex flex-col gap-3" style={{ "--enter-index": 1 } as React.CSSProperties}>
          <SectionHeading
            index={nextStep()}
            title="Attention"
            description={`${attentionCount} ${attentionCount === 1 ? "item wants" : "items want"} a decision`}
            action={
              data.insights.length > 0 ? (
                <Link
                  href={`/app/${orgId}/insights`}
                  className="font-numeric text-accent rounded-sm text-[11px] tracking-[0.02em] uppercase transition-opacity duration-[var(--duration-fast)] ease-out hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  All insights
                </Link>
              ) : undefined
            }
          />
          <ul className="flex flex-col">
            {overdue.map((invoice) => {
              const days = invoice.dueDate ? daysBetween(invoice.dueDate, nowMs) : null;
              return (
                <AttentionRow
                  key={invoice.id}
                  severity="urgent"
                  title={`Invoice ${invoice.invoiceNumber} is overdue`}
                  description={invoice.dueDate ? `Due ${invoice.dueDate}` : undefined}
                  value={<Amount value={safeMoney(invoice.totalMinor, invoice.currency)} size="small" tone="negative" />}
                  meta={days && days > 0 ? `${days} ${days === 1 ? "day" : "days"} late` : undefined}
                  href={`/app/${orgId}/invoices/${invoice.id}`}
                />
              );
            })}
            {data.insights.map((insight) => (
              <AttentionRow key={insight.id} severity="insight" title={insight.title} description={insight.body} />
            ))}
          </ul>
        </section>
      )}

      {/* ── 03 Cash flow ───────────────────────────────────────────────── */}
      <section className="section-enter flex flex-col gap-5" style={{ "--enter-index": 2 } as React.CSSProperties}>
        <SectionHeading
          index={nextStep()}
          title="Cash flow"
          description="Income against expenses, by month"
          action={
            <div className="font-numeric text-text-tertiary flex items-center gap-4 text-[10px] tracking-[0.08em] uppercase">
              <span className="flex items-center gap-1.5">
                <span aria-hidden="true" className="bg-positive size-2 rounded-[2px]" />
                In
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden="true" className="bg-negative size-2 rounded-[2px]" />
                Out
              </span>
            </div>
          }
        />
        <MonthlyBarChart data={data.monthlyTotals} />
      </section>

      {/* ── 04 Analysis ────────────────────────────────────────────────── */}
      <div className="section-enter grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-16" style={{ "--enter-index": 3 } as React.CSSProperties}>
        <section className="flex flex-col gap-5">
          <SectionHeading index={nextStep()} title="Where it went" description="Top categories this month" />
          <CategoryBreakdown items={data.topCategories} />
        </section>

        <section className="flex flex-col gap-5">
          <SectionHeading index={nextStep()} title="Financial health" description={healthLabel(data.financialHealth.overallScore)} />
          <div className="flex items-baseline gap-2">
            <span className="font-numeric text-ink text-[40px] leading-[48px] font-medium tracking-[-0.015em]">{data.financialHealth.overallScore}</span>
            <span className="font-numeric text-text-tertiary text-[13px]">/ 100</span>
          </div>
          <ul className="flex flex-col">
            {data.financialHealth.factors.map((factor) => (
              <li key={factor.key} className="border-border-subtle flex items-center gap-4 border-b py-2.5 last:border-0">
                <span className="text-text-secondary flex-1 truncate text-[13px]">{factor.label}</span>
                <span aria-hidden="true" className="bg-surface-sunken h-1 w-20 shrink-0 overflow-hidden rounded-pill">
                  <span
                    className={cn(
                      "block h-full rounded-pill",
                      factor.status === "strong" ? "bg-positive" : factor.status === "risk" ? "bg-negative" : "bg-warning",
                    )}
                    style={{ width: `${Math.max(0, Math.min(100, factor.score))}%` }}
                  />
                </span>
                <span className="font-numeric text-text-primary w-8 shrink-0 text-right text-[13px]">{factor.score}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* ── 05 Ledger ──────────────────────────────────────────────────── */}
      <section className="section-enter flex flex-col gap-5" style={{ "--enter-index": 4 } as React.CSSProperties}>
        <SectionHeading
          index={nextStep()}
          title="Ledger"
          description="Most recent activity"
          action={
            <Link
              href={`/app/${orgId}/transactions`}
              className="font-numeric text-accent rounded-sm text-[11px] tracking-[0.02em] uppercase transition-opacity duration-[var(--duration-fast)] ease-out hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              View all
            </Link>
          }
        />
        <Panel>
          {data.recentTransactions.length === 0 ? (
            <EmptyState
              title="No transactions yet"
              description="Once you add income or expenses, they'll show up here."
              action={
                <Link href={`/app/${orgId}/transactions`} className="text-accent text-[13px] hover:underline">
                  Add a transaction
                </Link>
              }
            />
          ) : (
            <>
              <Table fixed>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-full">Description</TableHead>
                    <TableHead className="w-32">Date</TableHead>
                    <TableHead numeric className="w-40">
                      Amount
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recentTransactions.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="max-w-0 truncate font-medium">{t.description ?? "—"}</TableCell>
                      <TableCell className="text-text-tertiary whitespace-nowrap">
                        <span className="font-numeric text-[13px]">{t.occurredOn}</span>
                      </TableCell>
                      <TableCell numeric>
                        <Amount
                          value={safeMoney(t.amountMinor, t.currency)}
                          sign={t.kind === "income" ? "positive" : t.kind === "expense" ? "negative" : "none"}
                          tone={t.kind === "income" ? "positive" : "neutral"}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <PanelFooter>
                <span className="font-numeric text-[11px] tracking-[0.02em] uppercase">{data.recentTransactions.length} most recent</span>
              </PanelFooter>
            </>
          )}
        </Panel>
      </section>
    </PageShell>
  );
}
