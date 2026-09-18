import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

/**
 * DESIGN.md §8. No box-shadow at rest for any variant, no scale/transform
 * on *hover* (that reads as "playful startup" — DESIGN.md §26) — hover is
 * a background/text-color change only, on the duration/easing DESIGN.md
 * §22 specifies for hover interactions. DESIGN.md is silent on the
 * *press* state, so a small `active:scale` lands here per
 * emil-design-eng's "buttons must feel responsive" — CLAUDE.md's
 * precedence lets the skill fill a gap DESIGN.md doesn't cover.
 */

const VARIANT_CLASSES = {
  primary: "bg-accent text-accent-contrast hover:bg-accent-hover",
  secondary: "border border-border bg-transparent text-text-primary hover:bg-surface-sunken",
  ghost: "bg-transparent text-text-primary hover:bg-surface-sunken",
  destructive: "border border-negative/40 bg-transparent text-negative hover:bg-negative-subtle",
  "destructive-solid": "bg-negative text-white hover:brightness-95",
} as const;

const SIZE_CLASSES = {
  sm: "h-8 gap-1.5 px-3 text-[13px]",
  md: "h-9 gap-2 px-4 text-[15px]",
  lg: "h-11 gap-2 px-5 text-[15px]",
} as const;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANT_CLASSES;
  size?: keyof typeof SIZE_CLASSES;
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-sm font-medium transition-[color,background-color,border-color,transform] duration-[120ms] ease-out active:scale-[0.98]",
          "disabled:pointer-events-none disabled:bg-surface-sunken disabled:text-text-tertiary disabled:active:scale-100",
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
