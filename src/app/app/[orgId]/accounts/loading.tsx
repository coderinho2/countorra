import { PageSkeleton, Skeleton, SkeletonCard } from "@/components/ui/skeleton";

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

export default function AccountsLoading() {
  return (
    <PageSkeleton label="Loading accounts">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-9 w-32 rounded-sm" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} lines={2} />
        ))}
      </div>
    </PageSkeleton>
  );
}
