import { PageSkeleton, Skeleton, SkeletonTable, SkeletonStatRow } from "@/components/ui/skeleton";

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

export default function ReportsLoading() {
  return (
    <PageSkeleton label="Loading report">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Skeleton className="h-6 w-44" />
        <div className="flex gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-24 rounded-sm" />
          ))}
        </div>
      </div>
      <SkeletonStatRow secondary={2} />
      <div className="rounded-md border border-border-subtle bg-surface">
        <SkeletonTable rows={7} columns={3} numericColumns={2} />
      </div>
    </PageSkeleton>
  );
}
