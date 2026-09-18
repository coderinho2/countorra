"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 rounded-sm bg-ink px-2.5 py-1.5 text-[13px] text-paper shadow-[var(--shadow-level-2)]",
        // Origin-aware and quick: a tooltip is a hint, so 125ms with the
        // panel growing out of the element it describes. `delayed-open`
        // means the provider's delay already elapsed and the user is moving
        // along a row of controls — animating again there makes a toolbar
        // feel sluggish, so subsequent tooltips appear instantly.
        "origin-(--radix-tooltip-content-transform-origin)",
        "transition-[opacity,transform] duration-[125ms] ease-out",
        "data-[state=closed]:scale-[0.97] data-[state=closed]:opacity-0 data-[state=closed]:duration-[var(--duration-exit)]",
        "data-[state=instant-open]:duration-0 data-[state=delayed-open]:duration-0",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = "TooltipContent";
