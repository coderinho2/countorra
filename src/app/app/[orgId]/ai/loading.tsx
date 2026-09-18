import { Skeleton, SkeletonText } from "@/components/ui/skeleton";

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

export default function AiLoading() {
  return (
    <div className="page-enter flex h-full flex-col gap-6 p-4 lg:p-8" aria-busy="true">
      <span className="sr-only" role="status">
        Loading the assistant
      </span>
      <Skeleton className="h-6 w-36" />
      <div className="flex flex-1 flex-col justify-end gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-2.5 w-24" />
          <SkeletonText w="3/4" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-2.5 w-28" />
          <SkeletonText />
          <SkeletonText w="1/2" />
        </div>
      </div>
      <Skeleton className="h-24 w-full rounded-md" />
    </div>
  );
}
