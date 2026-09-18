import * as React from "react";
import { cn } from "@/lib/utils";

/** DESIGN.md §9. Numeric fields (amount, quantity) should pass
 *  `numeric` to right-align and render in Geist Mono with tabular figures. */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  numeric?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, numeric, ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid}
      className={cn(
        "h-10 w-full rounded-sm border bg-surface px-3 py-2.5 text-[15px] text-text-primary outline-none",
        "placeholder:text-text-tertiary",
        "border-border focus:border-accent focus:ring-2 focus:ring-accent/20 focus:ring-offset-2 focus:ring-offset-paper",
        invalid && "border-negative focus:border-negative focus:ring-negative/20",
        numeric && "font-numeric text-right",
        "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-tertiary",
        "transition-colors duration-100 ease-out",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
