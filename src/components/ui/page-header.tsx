import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The page frame every authenticated screen sits in.
 *
 * Before this existed, every page hand-rolled
 * `<div class="flex items-center justify-between"><h1 class="text-lg …">`,
 * which produced two problems at once: the title was 18px — a size that
 * appears nowhere in DESIGN.md §4's scale — and Transactions, Customers,
 * Documents and Invoices were visually indistinguishable above the fold.
 * A page's identity has to come from its header, because that is the only
 * part of the screen the user reads before deciding where to look.
 *
 * `PageShell` also supplies the 1440px inner max-width DESIGN.md §6
 * specifies for the content area. Without it, a dashboard on a wide display
 * stretched a three-column grid across 2500px and every row of numbers drifted
 * apart from its own label.
 */
export function PageShell({
  className,
  wide,
  children,
}: {
  className?: string;
  /** Documents (an invoice, a report) sit in a narrower measure than a data
   *  table does; `wide` is the default table/dashboard width. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mx-auto flex w-full flex-col px-4 py-6 lg:px-8 lg:py-8", wide === false ? "max-w-3xl" : "max-w-[1440px]", className)}>
      {children}
    </div>
  );
}

/**
 * Title block. The eyebrow is the section's fixed name and the title is what
 * this particular view is showing — so a filtered transactions view can say
 * "Transactions / Unreviewed" without inventing a second heading level.
 *
 * The bottom hairline is load-bearing: DESIGN.md §2 makes borders, not
 * shadows or background shifts, the way surfaces separate. A page whose
 * header is only whitespace has no edge, and content below it reads as
 * floating rather than as sitting inside a frame.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /** Optional figures rail rendered under the title — see `PageMeta`. */
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("border-border flex flex-col gap-6 border-b pb-6", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          {eyebrow && <p className="font-numeric text-text-tertiary text-[11px] tracking-[0.14em] uppercase">{eyebrow}</p>}
          {/* H2 scale from DESIGN.md §4 — 28/36 at −0.01em. In-app screens
              never go to the 40px H1 scale; that is reserved for the hero
              *figure* on the dashboard, which should outweigh any heading. */}
          <h1 className="text-ink text-[32px] leading-[40px] font-semibold tracking-[-0.015em] sm:text-[40px] sm:leading-[48px]">{title}</h1>
          {description && <p className="text-text-secondary max-w-[70ch] text-[15px]">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {meta}
    </header>
  );
}

/**
 * A rail of small figures under a page title — count, totals, date range.
 *
 * Separated by hairline rules rather than by dots or pipes, so the rail
 * reads as part of the same ruled system as the tables below it. Wraps by
 * design; the separator is suppressed on the first item of each visual row
 * only in the sense that it never leads, which is enough at this density.
 */
export function PageMeta({ children, className }: { children: React.ReactNode; className?: string }) {
  return <dl className={cn("flex flex-wrap items-center gap-x-6 gap-y-2", className)}>{children}</dl>;
}

export function PageMetaItem({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  tone?: "neutral" | "positive" | "negative" | "warning";
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="font-numeric text-text-tertiary text-[10px] tracking-[0.08em] uppercase">{label}</dt>
      <dd
        className={cn(
          "font-numeric text-[13px] font-medium",
          tone === "positive" && "text-positive",
          tone === "negative" && "text-negative",
          tone === "warning" && "text-warning",
          tone === "neutral" && "text-text-primary",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
