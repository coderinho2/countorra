"use client";

import * as React from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { CaretDown } from "@phosphor-icons/react/dist/ssr/CaretDown";
import { cn } from "@/lib/utils";

/**
 * shadcn's Accordion, fitted to DESIGN.md rather than to shadcn's defaults:
 *
 *   - Phosphor, the product's one icon family (§20), not lucide.
 *   - Hover is a text-colour change (§22), not an underline.
 *   - The stock `accordion-down` keyframes animate `height`, which §22 rules
 *     out. The panel opens at full height and its contents fade and settle
 *     instead (`animate-disclose`, globals.css); closing is immediate, which
 *     is the faster exit §22 asks for. Reduced motion is handled globally.
 */

const Accordion = AccordionPrimitive.Root;

const AccordionItem = React.forwardRef<
  React.ComponentRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({ className, ...props }, ref) => <AccordionPrimitive.Item ref={ref} className={cn("border-b border-border-subtle", className)} {...props} />);
AccordionItem.displayName = "AccordionItem";

const AccordionTrigger = React.forwardRef<
  React.ComponentRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      ref={ref}
      className={cn(
        "group flex flex-1 items-start justify-between gap-4 py-5 text-left text-[16px] leading-6 font-medium text-ink transition-colors duration-[120ms] ease-out hover:text-accent",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/40",
        className,
      )}
      {...props}
    >
      {children}
      <CaretDown
        size={16}
        aria-hidden="true"
        className="mt-1 shrink-0 text-text-tertiary transition-transform duration-[var(--duration-panel)] ease-[var(--ease-out)] group-data-[state=open]:rotate-180"
      />
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
));
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

const AccordionContent = React.forwardRef<
  React.ComponentRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Content ref={ref} className="overflow-hidden text-[15px] leading-[1.65] text-text-secondary" {...props}>
    {/* Radix unmounts closed content, so this only ever renders opening. */}
    <div className={cn("animate-disclose pb-5", className)}>{children}</div>
  </AccordionPrimitive.Content>
));
AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
