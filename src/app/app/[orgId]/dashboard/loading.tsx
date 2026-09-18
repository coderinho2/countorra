import { PageSkeleton, Skeleton, SkeletonTable, SkeletonCard, SkeletonStatRow } from "@/components/ui/skeleton";

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

export default function DashboardLoading() {
  return (
    <PageSkeleton label="Loading your dashboard">
      <SkeletonStatRow />
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
      </div>
      <div className="rounded-md border border-border-subtle bg-surface p-6">
        <Skeleton className="mb-6 h-4 w-36" />
        <div className="flex h-40 items-end gap-2">
          {[38, 62, 45, 78, 54, 70].map((h, i) => (
            <Skeleton key={i} className="flex-1 rounded-t-sm" style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>
      <div className="rounded-md border border-border-subtle bg-surface">
        <SkeletonTable rows={5} columns={4} numericColumns={1} />
      </div>
    </PageSkeleton>
  );
}
