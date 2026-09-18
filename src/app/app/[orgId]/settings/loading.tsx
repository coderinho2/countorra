import { Skeleton } from "@/components/ui/skeleton";

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

export default function SettingsLoading() {
  return (
    <div className="page-enter mx-auto flex w-full max-w-2xl flex-col gap-8 p-4 lg:p-8" aria-busy="true">
      <span className="sr-only" role="status">
        Loading settings
      </span>
      <Skeleton className="h-6 w-28" />
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-md border border-border-subtle bg-surface p-6">
          <Skeleton className="mb-4 h-4 w-32" />
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-9 w-full rounded-sm" />
            </div>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-9 w-full rounded-sm" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
