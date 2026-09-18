import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "@phosphor-icons/react/dist/ssr/Check";
import { cn } from "@/lib/utils";

export const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "flex size-4 items-center justify-center rounded-[4px] border border-border bg-surface",
      "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
      "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2",
      "transition-colors duration-100 ease-out",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator>
      <Check weight="bold" className="size-3 text-accent-contrast" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = "Checkbox";
