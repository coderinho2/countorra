import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** DESIGN.md §16: centered, max-width 360px, one small line icon, one
 *  headline, one line of body text, exactly one primary action. No
 *  illustrations or mascots. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto flex max-w-[360px] flex-col items-center gap-3 py-12 text-center", className)}>
      {icon && <div className="text-text-tertiary">{icon}</div>}
      <h4 className="text-base font-semibold text-ink">{title}</h4>
      {description && <p className="text-[13px] text-text-secondary">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
