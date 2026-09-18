import * as React from "react";
import { cn } from "@/lib/utils";

/** DESIGN.md §11: sticky Small-scale header on surface-sunken, hairline row
 *  dividers (no zebra by default), numeric columns pass `numeric` to
 *  right-align in Geist Mono tabular figures. */

/**
 * `fixed` switches the table to `table-layout: fixed`.
 *
 * Under the browser's default auto layout a column's declared width is only a
 * suggestion — the widest cell content wins — so a long merchant name pushed
 * its column past `w-44` and squeezed the description column down to a few
 * characters plus an ellipsis, no matter what width the description column
 * asked for. Fixed layout makes the declared widths authoritative, which is
 * also what makes `truncate` behave: a cell can only clip its content once
 * the column has a width that does not depend on that content.
 *
 * It is opt-in because it is only correct for tables that actually declare
 * their columns; a table that doesn't would collapse to equal columns.
 */
export function Table({ className, fixed, ...props }: React.TableHTMLAttributes<HTMLTableElement> & { fixed?: boolean }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-[15px]", fixed && "table-fixed", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("sticky top-0 z-10 bg-surface-sunken", className)} {...props} />;
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

/**
 * A data row.
 *
 * `interactive` marks a row that actually does something when clicked, and
 * it is what earns the pointer cursor and the press response. Rows that are
 * merely displayed get the hover tint (so scanning across a wide financial
 * table is easier to track) but no affordance suggesting they are
 * clickable — a cursor that lies about what a row does is worse than no
 * cursor at all.
 *
 * `selected` uses accent-subtle per DESIGN.md §11 and is paired at every
 * call site with a checked checkbox, never carried by colour alone (§24).
 *
 * The hover transition is deliberately fast (§22 specifies 100ms for table
 * rows): the pointer moves down a long table quickly, and a slow fill turns
 * into a smear of half-lit rows trailing the cursor.
 */
export function TableRow({
  className,
  interactive,
  selected,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean; selected?: boolean }) {
  return (
    <tr
      data-selected={selected || undefined}
      className={cn(
        "border-b border-border-subtle last:border-0",
        "transition-colors duration-[100ms] ease-out",
        selected ? "bg-accent-subtle" : "hover:bg-surface-sunken",
        interactive && "cursor-pointer",
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({
  className,
  numeric,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        "h-11 px-3 text-left text-[13px] font-medium text-text-secondary",
        numeric && "text-right",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({
  className,
  numeric,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn("h-11 px-3 text-text-primary", numeric && "font-numeric text-right", className)}
      {...props}
    />
  );
}
