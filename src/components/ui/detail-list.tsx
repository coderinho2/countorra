import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A label/value list for detail views.
 *
 * Detail pages across the product were each hand-rolling a `flex justify-
 * between border-b` row, which meant the label column never lined up between
 * one row and the next: a two-word label and a nine-word label pushed their
 * values to different places, and a column of values that does not align is
 * the same defect as a column of figures that does not align.
 *
 * A real `<dl>` with a fixed label column fixes both the alignment and the
 * semantics — screen readers announce these as the term/definition pairs
 * they are, rather than as two unrelated runs of text.
 */
export function DetailList({ className, ...props }: React.HTMLAttributes<HTMLDListElement>) {
  return <dl className={cn("flex flex-col", className)} {...props} />;
}

export function DetailRow({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-baseline gap-4 border-b border-border-subtle px-4 py-3 last:border-0", className)}>
      <dt className="w-40 shrink-0 text-[13px] text-text-secondary">{label}</dt>
      <dd className="min-w-0 flex-1 text-[15px] text-text-primary">{children}</dd>
    </div>
  );
}
