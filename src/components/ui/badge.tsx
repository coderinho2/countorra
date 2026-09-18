import * as React from "react";
import { cn } from "@/lib/utils";

/** Status pills (DESIGN.md §3, §11, §13): subtle-tint background, solid-tone
 *  text — never a loud solid fill. Used for invoice/transaction/document
 *  status, always paired with the status word itself, never color alone. */
const VARIANT_CLASSES = {
  neutral: "bg-surface-sunken text-text-secondary",
  positive: "bg-positive-subtle text-positive",
  negative: "bg-negative-subtle text-negative",
  warning: "bg-warning-subtle text-warning",
  info: "bg-info-subtle text-info",
} as const;

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: keyof typeof VARIANT_CLASSES;
}

export function Badge({ className, variant = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[13px] font-medium",
        VARIANT_CLASSES[variant],
        className,
      )}
      {...props}
    />
  );
}
