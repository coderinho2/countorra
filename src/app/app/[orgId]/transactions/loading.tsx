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

export default function TransactionsLoading() {
  return (
    <PageSkeleton label="Loading transactions">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-9 w-36 rounded-sm" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-56 rounded-sm" />
        <Skeleton className="h-9 w-32 rounded-sm" />
        <Skeleton className="h-9 w-32 rounded-sm" />
        <Skeleton className="h-9 w-28 rounded-sm" />
      </div>
      <div className="rounded-md border border-border-subtle bg-surface">
        <SkeletonTable rows={8} columns={5} numericColumns={1} />
      </div>
    </PageSkeleton>
  );
}
