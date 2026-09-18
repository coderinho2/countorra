"use client";

import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/utils";

/**
 * Radix Avatar primitive.
 *
 * Added as a dependency of the Hero 08 reference component (21st.dev), which
 * imports `@/components/ui/avatar` — no avatar existed in this project
 * before. Nothing in the Countorra product uses it today.
 *
 * Written against this project's own tokens rather than shadcn's
 * (`bg-muted`, `border-border`), because those tokens are not defined here —
 * see the note in the Phase-2 component install report. `radius-sm` keeps it
 * inside DESIGN.md §6's modest radius band rather than defaulting to a full
 * circle, which is the "consumer app" look §26 bans; call sites that want a
 * circle can pass `rounded-full`.
 */
export const Avatar = React.forwardRef<
  React.ComponentRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root ref={ref} className={cn("relative flex size-9 shrink-0 overflow-hidden rounded-full", className)} {...props} />
));
Avatar.displayName = AvatarPrimitive.Root.displayName;

export const AvatarImage = React.forwardRef<
  React.ComponentRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => <AvatarPrimitive.Image ref={ref} className={cn("aspect-square size-full object-cover", className)} {...props} />);
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

export const AvatarFallback = React.forwardRef<
  React.ComponentRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn("flex size-full items-center justify-center rounded-full bg-surface-sunken text-text-secondary", className)}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;
