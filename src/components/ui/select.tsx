"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { CaretDown, Check } from "@phosphor-icons/react/dist/ssr";
import { cn } from "@/lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "group flex h-10 w-full items-center justify-between gap-2 rounded-sm border border-border bg-surface px-3 text-[15px] text-text-primary outline-none",
      // Radix's SelectValue renders its own span and does not forward
      // className, so the value is truncated from here. Without this a long
      // option ("Software & Subscriptions") wraps onto a second line and,
      // where a select sits inside a table cell, drags that row taller than
      // the 44px rhythm DESIGN.md §11 specifies — one ragged row in an
      // otherwise ruled financial table is very visible.
      "[&>span]:min-w-0 [&>span]:truncate",
      "transition-[border-color,box-shadow] duration-[var(--duration-fast)] ease-out",
      "hover:border-border-strong",
      "focus:border-accent focus:ring-2 focus:ring-accent/20 focus:ring-offset-2 focus:ring-offset-paper",
      "data-[placeholder]:text-text-tertiary",
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      {/* The caret rotating to point up is the cheapest possible signal that
          the control is open, and it costs one transform. */}
      <CaretDown className="size-4 shrink-0 text-text-tertiary transition-transform duration-[var(--duration-panel)] ease-[var(--ease-emphasized)] group-data-[state=open]:-rotate-180" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";

export const SelectContent = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      sideOffset={6}
      className={cn(
        "overlay-enter z-50 min-w-(--radix-select-trigger-width) rounded-md border border-border-subtle bg-surface p-1 shadow-[var(--shadow-level-2)]",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = "SelectContent";

export const SelectItem = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-pointer items-center rounded-sm py-2 pr-8 pl-2.5 text-[15px] text-text-primary outline-none",
      "transition-colors duration-[var(--duration-fast)] ease-out",
      "data-[highlighted]:bg-surface-sunken",
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="absolute right-2.5 flex items-center">
      <Check weight="bold" className="size-3.5 text-accent" />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
));
SelectItem.displayName = "SelectItem";
