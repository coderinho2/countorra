"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { desktopNavItemClass } from "./nav-active";
import type { NavGroup } from "./nav-data";

/**
 * Desktop mega-menu trigger + panel. A disclosure pattern (button +
 * aria-expanded/aria-controls), not a full ARIA menu widget — every item
 * is a real link a user can Tab to directly. The panel renders through a
 * portal into document.body rather than as a positioned descendant of
 * the sticky header: a header combining `position: sticky` with
 * `backdrop-filter` establishes its own compositing layer in some
 * browser engines, which can paint an absolutely-positioned descendant
 * *behind* later normal-flow content instead of above it, even with a
 * higher effective z-index. Portalling sidesteps that stacking-context
 * ambiguity entirely instead of chasing z-index numbers.
 *
 * Hover corridor: because the panel is portalled, it is not a DOM
 * descendant of the trigger, so a plain onMouseLeave on the trigger
 * fires the instant the cursor leaves it — long before it reaches the
 * panel across the gap below. Both the trigger and the panel share one
 * debounced open/close timer instead: entering either cancels any
 * pending close and opens immediately; leaving either starts a short
 * close delay that the other side's onMouseEnter can still cancel. That
 * delay (not a giant invisible hitbox) is what lets the pointer travel
 * diagonally from trigger to panel without the menu closing underneath it.
 */
export function NavDropdown({ group, active = false }: { group: NavGroup; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const panelId = useId();

  const updateRect = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, bottom: r.bottom, width: r.width });
  };

  const openNow = () => {
    clearTimeout(closeTimer.current);
    updateRect();
    setOpen(true);
  };
  const closeSoon = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 250);
  };
  const closeNow = () => {
    clearTimeout(closeTimer.current);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNow();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) closeNow();
    };
    const onReposition = () => updateRect();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onReposition, { passive: true });
    window.addEventListener("resize", onReposition);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onReposition);
      window.removeEventListener("resize", onReposition);
    };
  }, [open]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const columns = group.categories.length;

  return (
    <div className="relative">
      <Link
        ref={triggerRef}
        href={group.href}
        aria-expanded={open}
        aria-controls={panelId}
        aria-current={active ? "page" : undefined}
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
        onFocus={openNow}
        onClick={(e) => {
          if (open) return;
          e.preventDefault();
          openNow();
        }}
        /* The open-state color lift only applies at rest — an active item is
           already at full ink, and letting the variant win would darken it
           *down* to text-primary the moment its own menu opened. */
        className={cn("gap-1", desktopNavItemClass(active), !active && "aria-expanded:text-text-primary")}
      >
        {group.label}
        <svg width="10" height="10" viewBox="0 0 10 10" className={cn("transition-transform duration-150 ease-out", open && "rotate-180")} aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Link>

      {rect &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            style={{ position: "fixed", left: rect.left, top: rect.bottom + 12, minWidth: Math.max(rect.width, 560) }}
            className={cn(
              "z-50 transition-[opacity,transform] duration-150 ease-[var(--ease-out)]",
              open ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
            )}
            onMouseEnter={openNow}
            onMouseLeave={closeSoon}
            onFocus={openNow}
            onBlur={(e) => {
              if (!panelRef.current?.contains(e.relatedTarget as Node) && e.relatedTarget !== triggerRef.current) closeSoon();
            }}
          >
            <div
              className="grid gap-6 rounded-md border border-border-subtle bg-surface p-5 shadow-[var(--shadow-level-2)]"
              style={{ gridTemplateColumns: `repeat(${Math.min(columns, 4)}, minmax(0, 1fr))` }}
            >
              {group.categories.map((category) => (
                <div key={category.label} className="flex flex-col gap-2">
                  <p className="text-[11px] font-semibold tracking-wide text-text-tertiary uppercase">{category.label}</p>
                  <div className="flex flex-col gap-0.5">
                    {category.items.map((item) => (
                      <Link key={item.label} href={item.href} onClick={close} className="rounded-sm px-2 py-1.5 transition-colors duration-100 ease-out hover:bg-surface-sunken">
                        <p className="text-[13px] font-medium text-text-primary">{item.label}</p>
                        <p className="text-[12px] text-text-secondary">{item.description}</p>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
