import { cn } from "@/lib/utils";

/**
 * DESIGN.md §17: a 1.6s pulse between `--color-surface-sunken` and
 * `--color-border-subtle`, static fill under `prefers-reduced-motion` (both
 * handled by the `.skeleton` class in globals.css).
 *
 * Deliberately not Tailwind's `animate-pulse`, which fades opacity on
 * whatever colour it inherits — that reads as a grey ghost rather than a
 * placeholder belonging to this palette, and it fades the surrounding
 * border along with it.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton rounded-sm", className)} {...props} />;
}

/**
 * A skeleton sized to a currency figure rather than to its container.
 *
 * DESIGN.md §17 is specific about this: "numeric skeletons are sized to
 * plausible digit counts … so the layout doesn't jump when real data
 * arrives". A full-width bar standing in for `$1,240.00` guarantees a
 * reflow the moment the number loads, which is the exact jank the skeleton
 * was added to prevent.
 */
export function SkeletonAmount({ size = "md", className }: { size?: "md" | "lg" | "hero"; className?: string }) {
  const width = { md: "w-20", lg: "w-28", hero: "w-44" }[size];
  const height = { md: "h-5", lg: "h-7", hero: "h-10" }[size];
  return <Skeleton className={cn(width, height, className)} />;
}

/** A line of body text. `w` is a fraction of the container so a paragraph of
 *  these reads as ragged prose rather than a stack of identical bars. */
export function SkeletonText({ w = "full", className }: { w?: "full" | "3/4" | "1/2" | "1/3"; className?: string }) {
  const width = { full: "w-full", "3/4": "w-3/4", "1/2": "w-1/2", "1/3": "w-1/3" }[w];
  return <Skeleton className={cn("h-4", width, className)} />;
}

/**
 * Table placeholder matching the real geometry from DESIGN.md §11 — 44px
 * rows, hairline dividers, the same column count. Numeric columns get a
 * right-aligned short bar so the alignment that makes financial tables
 * readable is present before the data is.
 */
export function SkeletonTable({
  rows = 6,
  columns = 4,
  numericColumns = 1,
}: {
  rows?: number;
  columns?: number;
  numericColumns?: number;
}) {
  return (
    <div className="w-full" aria-hidden="true">
      <div className="flex h-11 items-center gap-3 rounded-t-md bg-surface-sunken px-3">
        {Array.from({ length: columns }).map((_, i) => (
          <div key={i} className={cn("flex-1", i >= columns - numericColumns && "flex justify-end")}>
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex h-11 items-center gap-3 border-b border-border-subtle px-3 last:border-0">
          {Array.from({ length: columns }).map((_, c) => {
            const numeric = c >= columns - numericColumns;
            return (
              <div key={c} className={cn("flex-1", numeric && "flex justify-end")}>
                <Skeleton className={cn("h-4", numeric ? "w-16" : c === 0 ? "w-40" : "w-24")} />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** The dashboard's asymmetric summary row (DESIGN.md §15) — one hero figure
 *  outweighing two or three secondary ones. Reproducing the asymmetry here
 *  matters: a row of equal placeholders would resolve into an unequal row
 *  and the whole header would shift. */
export function SkeletonStatRow({ secondary = 3 }: { secondary?: number }) {
  return (
    <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between" aria-hidden="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-28" />
        <SkeletonAmount size="hero" />
      </div>
      <div className="flex gap-8">
        {Array.from({ length: secondary }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-20" />
            <SkeletonAmount size="lg" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A resting card (DESIGN.md §10) with its hairline border already drawn, so
 *  only the contents resolve rather than the container appearing. */
export function SkeletonCard({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("rounded-md border border-border-subtle bg-surface p-6", className)} aria-hidden="true">
      <Skeleton className="mb-4 h-4 w-32" />
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: lines }).map((_, i) => (
          <SkeletonText key={i} w={i === lines - 1 ? "1/2" : "full"} />
        ))}
      </div>
    </div>
  );
}

/**
 * Wrapper for a route-level `loading.tsx`.
 *
 * Carries the same `.page-enter` entrance the real content uses, so the
 * skeleton doesn't snap in — and, more importantly, `aria-busy` plus a
 * polite live region so a screen-reader user is told the page is loading
 * instead of being read an empty document. The visual skeleton itself is
 * `aria-hidden`, because a list of placeholder bars is noise to a screen
 * reader.
 */
export function PageSkeleton({ label = "Loading", children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="page-enter flex flex-col gap-8 p-4 lg:p-8" aria-busy="true">
      <span className="sr-only" role="status">
        {label}
      </span>
      {children}
    </div>
  );
}
