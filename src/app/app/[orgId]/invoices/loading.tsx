import { PageSkeleton, Skeleton, SkeletonTable } from "@/components/ui/skeleton";

/**
 * Route-level loading UI (DESIGN.md §17). Next renders this the instant a
 * navigation starts, so moving between sections shows this page's own
 * geometry immediately instead of the previous page freezing until the
 * server responds.
 *
 * Each skeleton mirrors the real layout closely enough that nothing shifts
 * when the data arrives — that is the entire point of a skeleton, and a
 * generic spinner (banned by §17 outside app boot) cannot do it.
 */

export default function InvoicesLoading() {
  return (
    <PageSkeleton label="Loading invoices">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-9 w-32 rounded-sm" />
      </div>
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-20 rounded-sm" />
        ))}
      </div>
      <div className="rounded-md border border-border-subtle bg-surface">
        <SkeletonTable rows={6} columns={5} numericColumns={1} />
      </div>
    </PageSkeleton>
  );
}
