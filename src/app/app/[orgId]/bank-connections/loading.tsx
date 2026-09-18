import { PageSkeleton, Skeleton, SkeletonTable } from "@/components/ui/skeleton";

/** DESIGN.md §17: the page's own geometry — header, notice, a ruled panel. */
export default function BankConnectionsLoading() {
  return (
    <PageSkeleton label="Loading bank connections">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-16 w-full rounded-md" />
      <div className="rounded-md border border-border-subtle bg-surface">
        <SkeletonTable rows={4} columns={5} numericColumns={1} />
      </div>
    </PageSkeleton>
  );
}
