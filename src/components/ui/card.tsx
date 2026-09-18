import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * DESIGN.md §10: hairline border, no shadow at rest, radius-md. Elevation is
 * a border property here, not a shadow property.
 *
 * `interactive` is for a card that is genuinely clickable. It darkens the
 * hairline on hover and nothing else — §10 is explicit that an interactive
 * card never gets a shadow, a scale, or a background shift, because those
 * read as "playful startup" and this product is neither. The border darkening
 * is enough: it is the same signal the resting border already uses, just
 * turned up.
 */
export function Card({
  className,
  interactive,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-md border border-border-subtle bg-surface p-6",
        interactive &&
          "transition-colors duration-[var(--duration-fast)] ease-out hover:border-border focus-within:border-border",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-4 flex flex-col gap-1", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h4 className={cn("text-base font-semibold text-ink", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-[13px] text-text-secondary", className)} {...props} />;
}
