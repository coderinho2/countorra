"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ArrowClockwise } from "@phosphor-icons/react/dist/ssr/ArrowClockwise";
import { X } from "@phosphor-icons/react/dist/ssr/X";
import { Warning } from "@phosphor-icons/react/dist/ssr/Warning";
import { TrendUp } from "@phosphor-icons/react/dist/ssr/TrendUp";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { Sparkle } from "@phosphor-icons/react/dist/ssr/Sparkle";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr/ArrowRight";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Amount } from "@/components/amount";
import { dismissInsightAction } from "@/server/insights/actions";
import { refreshInsights } from "@/server/notifications/actions";
import { money } from "@/domain/money/money";
import type { CurrencyCode } from "@/domain/money/currency";
import { cn } from "@/lib/utils";
import type { Insight } from "@/server/db/repositories/insights";

/**
 * The insights console.
 *
 * Every insight the generator produces carries a namespaced `kind` and a
 * small `data` payload — a confidence, sometimes an amount, and usually the
 * id of the record it came from. None of that was on screen: insights
 * rendered as identical bordered cards with a title, a paragraph, and a
 * dismiss X, which is an AI content feed.
 *
 * The layout below is the hierarchy the brief asks for, built only from
 * fields that genuinely exist:
 *
 *   what happened   the title, ranked so overdue money sorts above analysis
 *   why it matters  the generator's own explanation
 *   evidence        the amount, the confidence, and a link to the actual
 *                   transaction or invoice the claim came from
 *   what you can do  open the record, or dismiss the insight
 *
 * Nothing is invented. Where an insight has no amount, no amount is shown —
 * a placeholder impact figure would be a fabricated number in a financial
 * product, which DESIGN.md §1 rules out more firmly than any layout rule.
 */
type Severity = "urgent" | "attention" | "info";

const SEVERITY = {
  urgent: { Icon: Warning, tone: "text-negative", rail: "border-l-negative", label: "Needs action" },
  attention: { Icon: TrendUp, tone: "text-warning", rail: "border-l-warning", label: "Worth a look" },
  info: { Icon: Sparkle, tone: "text-accent", rail: "border-l-accent", label: "Observation" },
} as const;

/**
 * Severity and category come from the insight's `kind`, which the generator
 * writes namespaced (`anomaly.large_amount`, `invoice.overdue`,
 * `recurring.price_increase`).
 *
 * Matching on substring rather than prefix on purpose: `kind` is a plain
 * `text` column with no constraint, so rows written before the namespacing
 * convention — or by a future generator that names things slightly
 * differently — still classify sensibly instead of all collapsing into the
 * lowest severity. Anything genuinely unrecognised falls through to
 * "Observation", which is the honest reading of an insight we cannot rank.
 */
function classify(kind: string): { severity: Severity; category: string } {
  const k = kind.toLowerCase();
  if (k.includes("invoice") || k.includes("overdue") || k.includes("receivable")) return { severity: "urgent", category: "Receivables" };
  if (k.includes("recurring") || k.includes("subscription")) return { severity: "attention", category: "Recurring spend" };
  if (k.includes("anomaly") || k.includes("unusual") || k.includes("spike")) return { severity: "attention", category: "Anomaly" };
  return { severity: "info", category: "Analysis" };
}

/** `data` is `Json`, so every read out of it is checked rather than cast. */
interface InsightEvidence {
  amountMinor: number | null;
  confidence: number | null;
  transactionId: string | null;
  invoiceId: string | null;
}

const NO_EVIDENCE: InsightEvidence = { amountMinor: null, confidence: null, transactionId: null, invoiceId: null };

function readData(data: Insight["data"]): InsightEvidence {
  if (!data || typeof data !== "object" || Array.isArray(data)) return NO_EVIDENCE;
  const record = data as Record<string, unknown>;
  return {
    amountMinor: typeof record.amountMinor === "number" ? record.amountMinor : null,
    confidence: typeof record.confidence === "number" ? record.confidence : null,
    transactionId: typeof record.transactionId === "string" ? record.transactionId : null,
    invoiceId: typeof record.invoiceId === "string" ? record.invoiceId : null,
  };
}

const SEVERITY_RANK: Record<Severity, number> = { urgent: 0, attention: 1, info: 2 };

export function InsightsPanel({
  organizationId,
  initialInsights,
  currency,
}: {
  organizationId: string;
  initialInsights: Insight[];
  currency: CurrencyCode;
}) {
  const [insights, setInsights] = useState(initialInsights);
  const [pending, startTransition] = useTransition();

  const dismiss = (id: string) => {
    setInsights((prev) => prev.filter((i) => i.id !== id));
    startTransition(() => dismissInsightAction(organizationId, id));
  };

  const refresh = () => {
    startTransition(async () => {
      await refreshInsights(organizationId);
      window.location.reload();
    });
  };

  const ordered = [...insights].sort(
    (a, b) => SEVERITY_RANK[classify(a.kind).severity] - SEVERITY_RANK[classify(b.kind).severity] || b.generatedAt.localeCompare(a.generatedAt),
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border-subtle pb-2.5">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">Active insights</h2>
          <p className="text-[13px] text-text-secondary">
            {insights.length === 0 ? "Nothing flagged right now." : `${insights.length} ${insights.length === 1 ? "finding" : "findings"}, most urgent first`}
          </p>
        </div>
        <Button size="sm" variant="secondary" disabled={pending} onClick={refresh}>
          <ArrowClockwise size={14} className={pending ? "animate-spin motion-reduce:animate-none" : ""} />
          {pending ? "Analyzing…" : "Re-analyze"}
        </Button>
      </div>

      {ordered.length === 0 ? (
        <EmptyState
          title="No insights yet"
          description="Run an analysis once you have some transaction history — Countorra looks for anomalies, recurring payment changes, and overdue invoices."
          icon={<MagnifyingGlass size={24} />}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {ordered.map((insight) => {
            const { severity, category } = classify(insight.kind);
            const { Icon, tone, rail, label } = SEVERITY[severity];
            const { amountMinor, confidence, transactionId, invoiceId } = readData(insight.data);
            const href = invoiceId
              ? `/app/${organizationId}/invoices/${invoiceId}`
              : transactionId
                ? `/app/${organizationId}/transactions/${transactionId}`
                : null;

            return (
              <li
                key={insight.id}
                className={cn("flex gap-3 rounded-md border border-border-subtle border-l-2 bg-surface p-4", rail)}
              >
                <Icon size={16} weight={severity === "info" ? "fill" : "regular"} aria-hidden="true" className={cn("mt-0.5 shrink-0", tone)} />

                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  {/* What kind of thing this is, before what it says. */}
                  <p className="flex flex-wrap items-center gap-x-2 text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">
                    <span className={tone}>{label}</span>
                    <span aria-hidden="true">·</span>
                    <span>{category}</span>
                  </p>

                  <p className="text-[15px] font-medium text-text-primary">{insight.title}</p>
                  {insight.body && <p className="max-w-[70ch] text-[13px] text-text-secondary">{insight.body}</p>}

                  {/* Evidence: the figure, how sure the detector was, and the
                      record it came from. An assertion in a finance product
                      should always be traceable back to a row. */}
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-text-tertiary">
                    {amountMinor !== null && (
                      <span className="flex items-baseline gap-1.5">
                        <span>Amount</span>
                        <Amount value={money(amountMinor, currency)} size="small" tone="neutral" />
                      </span>
                    )}
                    {confidence !== null && <span className="font-numeric">{Math.round(confidence * 100)}% confidence</span>}
                    <span className="font-numeric">{insight.generatedAt.slice(0, 10)}</span>
                    {href && (
                      <Link
                        href={href}
                        className="flex items-center gap-1 rounded-sm text-accent transition-opacity duration-[var(--duration-fast)] ease-out hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {invoiceId ? "Open invoice" : "Open transaction"}
                        <ArrowRight size={11} />
                      </Link>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => dismiss(insight.id)}
                  className={cn(
                    "-mt-1 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-sm text-text-tertiary",
                    "transition-colors duration-[var(--duration-fast)] ease-out hover:bg-surface-sunken hover:text-text-primary",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                  )}
                  aria-label={`Dismiss: ${insight.title}`}
                >
                  <X size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
