"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { List, X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { UserEntityType } from "@/domain/organizations/types";
import { SETTINGS_ITEM, visibleNavGroups, type NavItem } from "./nav-items";
import { BrandRow } from "./sidebar";

/**
 * DESIGN.md §23: the sidebar collapses to an overlay drawer below `lg`,
 * triggered from the top bar. Mobile is a real product surface here, not a
 * shrunk desktop layout.
 *
 * Built on Radix Dialog rather than a hand-rolled `open && <div>`: that
 * earlier shape mounted and unmounted with no transition (the drawer
 * appeared and vanished in a single frame, which reads as a glitch), and it
 * had none of the behaviour a modal overlay owes the user — Escape to
 * close, focus moved into the panel and trapped there, focus restored to
 * the trigger on close, the page behind it locked from scrolling, and the
 * rest of the app hidden from screen readers while it is open. Radix is
 * already a dependency for every other overlay in the product, so this
 * costs nothing and makes the drawer behave like the dialogs it sits
 * beside.
 *
 * Motion: the panel slides from its own left edge (`translateX(-100%)`, a
 * percentage so it is independent of the drawer's width) while the scrim
 * fades. Exit is faster than entry — the user has already decided to leave.
 */
function DrawerLink({ item, orgId, pathname, onNavigate }: { item: NavItem; orgId: string; pathname: string; onNavigate: () => void }) {
  const href = item.href(orgId);
  const active = pathname === href || pathname.startsWith(`${href}/`);
  const Icon = item.icon;
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex items-center gap-2.5 rounded-sm px-3 py-2.5 text-[15px]",
        "transition-colors duration-[var(--duration-fast)] ease-out",
        "focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-2",
        active ? "bg-accent-subtle text-accent" : "text-text-primary active:bg-surface-sunken",
      )}
    >
      {active && <span aria-hidden="true" className="bg-gold absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full" />}
      <Icon size={20} weight={active ? "fill" : "regular"} />
      {item.label}
    </Link>
  );
}

export function MobileNav({ orgId, entityType, orgName }: { orgId: string; entityType: UserEntityType; orgName: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const groups = visibleNavGroups(entityType);
  const close = () => setOpen(false);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            "text-text-secondary flex size-9 items-center justify-center rounded-sm lg:hidden",
            "transition-[background-color,transform] duration-[var(--duration-fast)] ease-out",
            "hover:bg-surface-sunken active:scale-95",
            "focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-2",
          )}
          aria-label="Open navigation"
        >
          <List size={20} />
        </button>
      </DialogPrimitive.Trigger>

      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "motion-fade bg-ink/40 fixed inset-0 z-50 lg:hidden",
            "transition-opacity duration-[var(--duration-modal)] ease-out",
            "data-[state=open]:opacity-100",
            "data-[state=closed]:opacity-0 data-[state=closed]:duration-[var(--duration-exit)]",
          )}
        />
        <DialogPrimitive.Content
          aria-label="Navigation"
          className={cn(
            "motion-drawer border-border-subtle bg-surface fixed top-0 left-0 z-50 flex h-full w-72 flex-col border-r lg:hidden",
            "transition-transform duration-[var(--duration-modal)] ease-[var(--ease-emphasized)]",
            "data-[state=open]:translate-x-0",
            "data-[state=closed]:-translate-x-full data-[state=closed]:duration-[var(--duration-exit)] data-[state=closed]:ease-[var(--ease-exit)]",
          )}
        >
          <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>

          <BrandRow onNavigate={close} />

          <div className="border-border-subtle flex h-14 items-center justify-between gap-2 border-b px-4">
            <span className="flex min-w-0 items-center gap-2.5">
              <span
                aria-hidden="true"
                className="bg-ink text-paper flex size-7 shrink-0 items-center justify-center rounded-sm text-[13px] font-semibold"
              >
                {orgName.trim().charAt(0).toUpperCase() || "A"}
              </span>
              <span className="text-ink truncate text-[14px] font-medium">{orgName}</span>
            </span>
            <DialogPrimitive.Close
              aria-label="Close navigation"
              className={cn(
                "text-text-tertiary flex size-9 items-center justify-center rounded-sm",
                "transition-[color,background-color,transform] duration-[var(--duration-fast)] ease-out",
                "hover:bg-surface-sunken hover:text-text-primary active:scale-95",
                "focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-2",
              )}
            >
              <X size={20} />
            </DialogPrimitive.Close>
          </div>

          <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-4">
            {groups.map((group, index) => (
              <div key={group.label ?? "primary"} className={cn("flex flex-col gap-0.5", index > 0 && "mt-5")}>
                {group.label && <p className="text-text-tertiary mb-1 px-3 text-[11px] font-semibold tracking-[0.02em] uppercase">{group.label}</p>}
                {group.items.map((item) => (
                  <DrawerLink key={item.label} item={item} orgId={orgId} pathname={pathname} onNavigate={close} />
                ))}
              </div>
            ))}
          </nav>

          <div className="border-border-subtle border-t px-3 py-3">
            <DrawerLink item={SETTINGS_ITEM} orgId={orgId} pathname={pathname} onNavigate={close} />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
