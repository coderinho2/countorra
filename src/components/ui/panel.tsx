import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A bordered region that holds a table or a list.
 *
 * `Card` (DESIGN.md §10) is a 24px-padded box for *content*. A table is not
 * content in that sense — it needs its rows to run edge to edge so the
 * header fill and the row dividers reach the container border, which is
 * what makes a financial table read as ruled rather than as a floating grid
 * of text. Putting a table inside a Card produced a 24px moat around every
 * row and left the sticky header (§11) floating on a white inset.
 *
 * So: same hairline border and radius as a Card, but zero padding, and
 * `overflow-hidden` so the header fill is clipped by the rounded corner
 * instead of squaring it off.
 */
export function Panel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border-border-subtle bg-surface overflow-hidden rounded-md border", className)} {...props} />;
}

/**
 * The strip above a panel's content: a title on the left, controls on the
 * right. Sits on `surface` (not the sunken fill the table header uses) so
 * the toolbar and the column headers stay visually distinct — one is chrome,
 * the other is data.
 */
export function PanelHeader({
  title,
  description,
  actions,
  className,
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("border-border-subtle flex flex-col gap-3 border-b px-4 py-3", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && <h2 className="text-ink text-[15px] font-semibold">{title}</h2>}
            {description && <p className="text-text-secondary text-[13px]">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * A closing rule under a table carrying the row count, a total, or
 * pagination. A table that simply stops at its last row leaves the reader
 * unsure whether they reached the end or the list was cut — in an accounting
 * tool that ambiguity is worth a line of chrome to remove.
 */
export function PanelFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "border-border-subtle bg-surface-sunken/50 text-text-secondary flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2.5 text-[13px]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A titled region that is *not* a box — a heading with a hairline rule
 * running to the edge of the content column, optionally with an action at
 * the far right.
 *
 * This is the alternative to wrapping everything in a Card. A page built
 * entirely from bordered boxes reads as a list of widgets; a page built from
 * ruled sections reads as a document, which is the register DESIGN.md §1
 * asks for. Boxes are then reserved for the things that genuinely are
 * discrete objects.
 */
export function SectionHeading({
  index,
  title,
  description,
  action,
  className,
}: {
  /**
   * Optional two-digit section number.
   *
   * A numbered, ruled section header is the difference between a page of
   * widgets and a document with a structure — it tells the reader the screen
   * was composed in an order rather than assembled from whatever fit. Set in
   * mono because it is a reference marker, not prose (DESIGN.md §4), and
   * `aria-hidden` because it is a visual index, not content a screen reader
   * needs to announce before every heading.
   */
  index?: number;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-border flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b pb-3", className)}>
      <div className="flex min-w-0 items-baseline gap-3">
        {index !== undefined && (
          <span aria-hidden="true" className="font-numeric text-text-tertiary text-[11px] tracking-[0.02em] tabular-nums">
            {String(index).padStart(2, "0")}
          </span>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-text-secondary text-[11px] font-semibold tracking-[0.08em] uppercase">{title}</h2>
          {description && <p className="text-text-tertiary text-[13px]">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}
