"use client";

import { useState } from "react";
import { House } from "@phosphor-icons/react/dist/ssr/House";
import { ArrowsLeftRight } from "@phosphor-icons/react/dist/ssr/ArrowsLeftRight";
import { Wallet } from "@phosphor-icons/react/dist/ssr/Wallet";
import { Calculator } from "@phosphor-icons/react/dist/ssr/Calculator";
import { FolderOpen } from "@phosphor-icons/react/dist/ssr/FolderOpen";
import { ChatCircleText } from "@phosphor-icons/react/dist/ssr/ChatCircleText";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { Bell } from "@phosphor-icons/react/dist/ssr/Bell";
import { Sparkle } from "@phosphor-icons/react/dist/ssr/Sparkle";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { CategoryBreakdown } from "@/components/charts/category-breakdown";
import { MonthlyBarChart } from "@/components/charts/monthly-bar-chart";
import { money, format } from "@/domain/money/money";
import { cn } from "@/lib/utils";

/** Mirrors the real application's grouped sidebar (see
 *  src/components/app-shell/nav-items.ts) so the preview is a picture of the
 *  product rather than of a product. */
const SIDEBAR_GROUPS = [
  { label: null, items: [{ label: "Overview", icon: House, active: true }] },
  {
    label: "Records",
    items: [
      { label: "Transactions", icon: ArrowsLeftRight },
      { label: "Accounts", icon: Wallet },
      { label: "Documents", icon: FolderOpen },
    ],
  },
  { label: "Analysis", items: [{ label: "Tax preparation", icon: Calculator }] },
];

interface Row {
  label: string;
  date: string;
  amountMinor: number;
  badge?: "overdue" | "recurring";
}

interface View {
  tab: string;
  pipeline: string;
  metricLabel: string;
  metricValueMinor: number;
  delta: string;
  deltaPositive: boolean;
  secondary: { label: string; valueMinor: number }[];
  insight: { text: string; confidence: string; support: string };
  rows: Row[];
}

const VIEWS: View[] = [
  {
    tab: "Overview",
    pipeline: "4,218 transactions → categorized → analyzed",
    metricLabel: "Available balance",
    metricValueMinor: 4218460,
    delta: "+6.2% vs. last month",
    deltaPositive: true,
    secondary: [
      { label: "Income", valueMinor: 918200 },
      { label: "Expenses", valueMinor: 412600 },
    ],
    insight: { text: "Dining spend is 18% above your 3-month average.", confidence: "High confidence", support: "Based on 14 transactions" },
    rows: [
      { label: "Paycheck — Northwind Co.", date: "Nov 21", amountMinor: 480000 },
      { label: "Grocery store", date: "Nov 19", amountMinor: -12480 },
      { label: "Streaming subscription", date: "Nov 3", amountMinor: -1599, badge: "recurring" },
    ],
  },
  {
    tab: "Spending",
    pipeline: "182 transactions → grouped by category → anomaly detected",
    metricLabel: "Total spending",
    metricValueMinor: 412600,
    delta: "-8% vs. last month",
    deltaPositive: true,
    secondary: [
      { label: "Dining", valueMinor: 84200 },
      { label: "Groceries", valueMinor: 112400 },
    ],
    insight: { text: "Dining spend is 18% above your 3-month average.", confidence: "High confidence", support: "Based on 14 transactions" },
    rows: [
      { label: "Rent", date: "Nov 1", amountMinor: -185000 },
      { label: "Grocery store", date: "Nov 19", amountMinor: -12480 },
      { label: "Electric utility", date: "Nov 15", amountMinor: -9620 },
    ],
  },
  {
    tab: "Cash Flow",
    pipeline: "4 months of activity → compared → trend confirmed",
    metricLabel: "Net cash flow",
    metricValueMinor: 505600,
    delta: "+6.2% vs. last month",
    deltaPositive: true,
    secondary: [
      { label: "Income", valueMinor: 918200 },
      { label: "Expenses", valueMinor: 412600 },
    ],
    insight: { text: "Cash flow has stayed positive for 4 consecutive months.", confidence: "Stable trend", support: "Based on the last 4 months" },
    rows: [
      { label: "Paycheck — Northwind Co.", date: "Nov 21", amountMinor: 480000 },
      { label: "Rent", date: "Nov 1", amountMinor: -185000 },
      { label: "Grocery store", date: "Nov 19", amountMinor: -12480 },
    ],
  },
  {
    // Subscriptions, not a "Forecast" view: the product forecasts through
    // the assistant (`forecastCashFlow`), and there is no forecast tab in the
    // dashboard. Recurring commitments are a surface that exists (Insights).
    // A preview that invents a screen is still a preview of something the
    // user will not find.
    tab: "Subscriptions",
    pipeline: "6 months of charges → recurring payments detected → 1 price change",
    metricLabel: "Recurring, per year",
    metricValueMinor: 216000,
    delta: "1 price increase",
    deltaPositive: false,
    secondary: [
      { label: "Bills", valueMinor: 151200 },
      { label: "Subscriptions", valueMinor: 64800 },
    ],
    insight: {
      text: "Your streaming subscription rose from $12.99 to $15.99 in October.",
      confidence: "High confidence",
      support: "Based on 6 months of charges",
    },
    rows: [
      { label: "Streaming subscription", date: "Nov 3", amountMinor: -1599, badge: "recurring" },
      { label: "Gym membership", date: "Nov 5", amountMinor: -4900, badge: "recurring" },
      { label: "Phone plan", date: "Nov 8", amountMinor: -6500, badge: "recurring" },
    ],
  },
];

const RECURRING_BREAKDOWN = [
  { categoryId: "bills", categoryName: "Bills", total: money(151200, "USD") },
  { categoryId: "subscriptions", categoryName: "Subscriptions", total: money(64800, "USD") },
];

const SPENDING_CATEGORIES = [
  { categoryId: "software", categoryName: "Software", total: money(112400, "USD") },
  { categoryId: "dining", categoryName: "Dining", total: money(84200, "USD") },
  { categoryId: "travel", categoryName: "Travel", total: money(52100, "USD") },
];

const CASH_FLOW_MONTHS = [
  { label: "Aug", income: money(880000, "USD"), expense: money(510000, "USD") },
  { label: "Sep", income: money(910000, "USD"), expense: money(470000, "USD") },
  { label: "Oct", income: money(870000, "USD"), expense: money(560000, "USD") },
  { label: "Nov", income: money(918200, "USD"), expense: money(412600, "USD") },
];

function Sparkline() {
  return (
    <svg viewBox="0 0 400 56" className="w-full" role="presentation" aria-hidden="true">
      <polyline
        points="0,42 40,38 80,40 120,26 160,30 200,16 240,20 280,10 320,14 360,4 400,8"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polygon points="0,42 40,38 80,40 120,26 160,30 200,16 240,20 280,10 320,14 360,4 400,8 400,56 0,56" fill="var(--color-accent)" opacity="0.1" />
    </svg>
  );
}

function Visual({ tab }: { tab: string }) {
  if (tab === "Spending") return <CategoryBreakdown items={SPENDING_CATEGORIES} />;
  if (tab === "Cash Flow") return <MonthlyBarChart data={CASH_FLOW_MONTHS} />;
  if (tab === "Subscriptions") return <CategoryBreakdown items={RECURRING_BREAKDOWN} />;
  return <Sparkline />;
}

/**
 * The signature homepage interaction (product spec §4). One product
 * surface — sidebar, topbar, hero metric, chart, intelligence callout,
 * activity rows — that morphs between four real dashboard views rather
 * than four static screenshots or a carousel: the segmented control
 * swaps the underlying data and visual for the *same* layout, with a
 * short crossfade (opacity only, DESIGN.md §22 timing) tying the states
 * together. Every figure is static illustrative preview data; nothing
 * here reads from or writes to the database.
 */
export function HeroPreview() {
  const [active, setActive] = useState(0);
  const [fading, setFading] = useState(false);
  const view = VIEWS[active];

  const selectView = (index: number) => {
    if (index === active || fading) return;
    setFading(true);
    setTimeout(() => {
      setActive(index);
      setFading(false);
    }, 130);
  };

  return (
    <div className="w-full overflow-hidden rounded-lg border border-border-subtle bg-surface">
      {/* Topbar */}
      <div className="flex h-12 items-center justify-between border-b border-border-subtle px-4">
        <div className="flex items-center gap-2 rounded-sm border border-border-subtle px-2.5 py-1 text-[12px] text-text-tertiary">
          <MagnifyingGlass size={13} />
          Ask Countorra
          <span className="ml-2 rounded-[4px] border border-border-subtle px-1 font-numeric text-[10px] text-text-tertiary">⌘K</span>
        </div>
        <div className="flex items-center gap-3">
          <Bell size={16} className="text-text-tertiary" />
          <span className="hidden text-[13px] font-medium text-text-primary sm:inline">My Finances</span>
        </div>
      </div>

      <div className="flex">
        {/* Sidebar */}
        <aside className="hidden w-[176px] shrink-0 flex-col gap-0.5 border-r border-border-subtle p-2.5 sm:flex">
          {SIDEBAR_GROUPS.map((group, index) => (
            <div key={group.label ?? "primary"} className={cn("flex flex-col gap-0.5", index > 0 && "mt-3")}>
              {group.label && <p className="mb-0.5 px-2.5 text-[10px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">{group.label}</p>}
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = "active" in item && item.active;
                return (
                  <div
                    key={item.label}
                    className={cn(
                      "relative flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-[13px]",
                      active ? "bg-accent-subtle text-accent" : "text-text-secondary",
                    )}
                  >
                    {active && <span className="absolute top-1 bottom-1 left-0 w-0.5 rounded-full bg-accent" />}
                    <Icon size={15} weight={active ? "fill" : "regular"} />
                    {item.label}
                  </div>
                );
              })}
            </div>
          ))}
          <p className="mt-3 mb-0.5 px-2.5 text-[10px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">Assistant</p>
          <div className="flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-[13px] text-text-secondary">
            <ChatCircleText size={15} />
            Ask your money
          </div>
        </aside>

        {/* Main content */}
        <div className="min-w-0 flex-1 p-4 sm:p-5">
          {/* View switcher — the same surface morphs, not four screenshots */}
          <div
            role="tablist"
            aria-label="Dashboard view"
            className="mb-4 inline-flex max-w-full gap-0.5 overflow-x-auto rounded-sm border border-border-subtle bg-surface-sunken p-0.5"
          >
            {VIEWS.map((v, i) => (
              <button
                key={v.tab}
                type="button"
                role="tab"
                aria-selected={active === i}
                onClick={() => selectView(i)}
                className={cn(
                  "shrink-0 rounded-[3px] px-2.5 py-1 text-[12px] font-medium whitespace-nowrap transition-colors duration-100 ease-out",
                  active === i ? "bg-surface text-ink shadow-[var(--shadow-level-1)]" : "text-text-tertiary hover:text-text-secondary",
                )}
              >
                {v.tab}
              </button>
            ))}
          </div>

          <div className={cn("transition-opacity duration-150 ease-[var(--ease-out)]", fading ? "opacity-0" : "opacity-100")}>
            <p className="mb-3 font-numeric text-[11px] text-text-tertiary">{view.pipeline}</p>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-[13px] text-text-secondary">{view.metricLabel}</span>
                <span className="font-numeric text-[32px] leading-10 font-medium tracking-[-0.015em] text-ink sm:text-[40px] sm:leading-[48px]">
                  {format(money(view.metricValueMinor, "USD"))}
                </span>
                <span className={cn("text-[13px]", view.deltaPositive ? "text-positive" : "text-negative")}>{view.delta}</span>
              </div>
              <div className="flex border-t border-border-subtle pt-3 sm:divide-x sm:divide-border-subtle">
                {view.secondary.map((s, i) => (
                  <div key={s.label} className={cn("flex flex-1 flex-col gap-0.5", i === 0 ? "sm:pr-6" : "sm:pl-6")}>
                    <span className="text-[12px] text-text-tertiary">{s.label}</span>
                    <span className="font-numeric text-[20px] leading-7 font-medium tracking-[-0.01em] text-ink">{format(money(s.valueMinor, "USD"))}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-5">
              <Visual tab={view.tab} />
            </div>

            <div className="mt-4 flex items-start gap-2.5 rounded-md border border-border-subtle bg-surface-sunken p-3">
              <Sparkle size={14} weight="fill" className="mt-0.5 shrink-0 text-accent" />
              <div>
                <p className="text-[13px] text-text-primary">{view.insight.text}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-tertiary">
                  <span>{view.insight.confidence}</span>
                  <span>·</span>
                  <span>{view.insight.support}</span>
                </div>
              </div>
            </div>

            <div className="mt-4 border-t border-border-subtle pt-1">
              <Table>
                <TableBody>
                  {view.rows.map((row) => (
                    <TableRow key={row.label}>
                      <TableCell className="text-[13px]">
                        <div className="flex items-center gap-2 max-sm:flex-wrap max-sm:gap-y-1">
                          {row.label}
                          {row.badge === "overdue" && <Badge variant="negative">Overdue</Badge>}
                          {row.badge === "recurring" && <Badge variant="neutral">Recurring</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="hidden text-[13px] text-text-secondary sm:table-cell">{row.date}</TableCell>
                      <TableCell numeric className={cn("text-[13px]", row.amountMinor > 0 ? "text-positive" : "text-text-primary")}>
                        {row.amountMinor > 0 ? "+" : "-"}
                        {format(money(Math.abs(row.amountMinor), "USD"))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
