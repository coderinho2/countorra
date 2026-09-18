"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check } from "@phosphor-icons/react/dist/ssr/Check";
import { cn } from "@/lib/utils";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

/**
 * DESIGN.md §21 Level 2 (hairline border + soft shadow).
 *
 * `overlay-enter` (globals.css) scales the panel out of its trigger rather
 * than out of its own centre — Radix publishes the trigger-relative origin
 * as `--radix-popper-transform-origin`, and using it is the difference
 * between a menu that belongs to the button and a panel that happens to
 * appear near it. Entry starts at 0.96 rather than 0, because nothing in
 * the real world appears from nothing.
 */
export const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "overlay-enter z-50 min-w-40 rounded-md border border-border-subtle bg-surface p-1 shadow-[var(--shadow-level-2)]",
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "flex cursor-pointer items-center rounded-sm px-2.5 py-2 text-[15px] text-text-primary outline-none",
      "transition-colors duration-[var(--duration-fast)] ease-out",
      "data-[highlighted]:bg-surface-sunken",
      "data-[disabled]:pointer-events-none data-[disabled]:text-text-tertiary",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      "flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-2 text-[15px] text-text-primary outline-none",
      "data-[highlighted]:bg-surface-sunken",
      className,
    )}
    {...props}
  >
    <span className="flex size-4 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Check weight="bold" className="size-3.5 text-accent" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem";

export const DropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator ref={ref} className={cn("my-1 h-px bg-border-subtle", className)} {...props} />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";
