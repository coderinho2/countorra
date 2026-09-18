import * as React from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, ...props }, ref) => (
    <textarea
      ref={ref}
      aria-invalid={invalid}
      className={cn(
        "min-h-24 w-full rounded-sm border bg-surface px-3 py-2.5 text-[15px] text-text-primary outline-none",
        "placeholder:text-text-tertiary",
        "border-border focus:border-accent focus:ring-2 focus:ring-accent/20 focus:ring-offset-2 focus:ring-offset-paper",
        invalid && "border-negative focus:border-negative focus:ring-negative/20",
        "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-tertiary",
        "transition-colors duration-100 ease-out",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
