import type { ReactNode } from "react";
import { WarningCircle } from "@phosphor-icons/react/dist/ssr/WarningCircle";
import { cn } from "@/lib/utils";

/** DESIGN.md §18: calm, not alarming — a bordered panel, not a full-bleed
 *  red screen. One-sentence explanation, single recovery action. */
export function ErrorState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-start gap-2 rounded-md border border-negative/30 bg-negative-subtle p-4",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-negative">
        <WarningCircle weight="bold" className="size-4" />
        <span className="text-[15px] font-semibold">{title}</span>
      </div>
      {description && <p className="text-[13px] text-text-secondary">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
