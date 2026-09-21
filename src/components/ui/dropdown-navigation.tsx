"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { CaretDown } from "@phosphor-icons/react/dist/ssr/CaretDown";
import type { Icon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/**
 * The public site's primary navigation: a row of items, some of which open a
 * mega menu on hover or focus.
 *
 * ADAPTED, NOT COPIED. The reference component supplied the interaction that
 * makes this feel like a modern product header — one hover pill that SLIDES
 * between items via a shared `layoutId`, a panel that morphs when you move
 * from one menu to the next, a chevron that flips, and rows built as an icon
 * tile beside a label and a description. All of that is kept.
 *
 * What changed, and why:
 *   - Every destination is supplied by the caller. The reference shipped
 *     Vercel's menu with `href="#"` on every row; nothing here points at a
 *     placeholder.
 *   - It is a `<nav>` with real `<Link>`s and `aria-current`, not a `<main>`
 *     full of buttons and anchors to nowhere. The whole row is tabbable and
 *     each menu opens on focus as well as hover.
 *   - Countorra's own tokens replace `bg-primary/10`, `text-muted-foreground`
 *     and `rounded-[99px]`: accent-subtle pill, `--color-text-secondary`,
 *     `radius-sm`, hairline borders, Level 2 shadow. DESIGN.md §26 caps
 *     radius at 14px, so the pill is a rounded rect, not a capsule.
 *   - Motion is 120–180ms and honours `prefers-reduced-motion`, which
 *     switches the pill and the panel to a plain show/hide (§22).
 *   - The panel closes on Escape, on outside pointerdown, and after a short
 *     delay when the pointer leaves — the delay is what lets the cursor
 *     travel diagonally from the trigger down into the panel.
 */

export interface DropdownNavLeaf {
  label: string;
  description: string;
  href: string;
  icon: Icon;
}

export interface DropdownNavCategory {
  label: string;
  items: DropdownNavLeaf[];
}

export interface DropdownNavItem {
  label: string;
  href: string;
  /** Present on a mega-menu item, absent on a direct link. */
  categories?: DropdownNavCategory[];
  /** Rendered before the label on a direct link (the lock beside Security). */
  adornment?: React.ReactNode;
}

const PANEL_TRANSITION = { duration: 0.16, ease: [0.16, 1, 0.3, 1] } as const;
const PILL_TRANSITION = { type: "spring", stiffness: 420, damping: 38, mass: 0.6 } as const;

export function DropdownNavigation({
  items,
  isActive,
  className,
}: {
  items: DropdownNavItem[];
  /** Section membership lives with the caller — a nav item stays lit for its
   *  whole section, and only the caller knows that rule. */
  isActive: (href: string) => boolean;
  className?: string;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  /* Where the open menu's trigger sits inside the nav, so the panel hangs
     under the item it belongs to instead of under the row's left edge.
     Clamped on render so the widest menu cannot run off the container. */
  const [panelLeft, setPanelLeft] = useState(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const rootRef = useRef<HTMLElement>(null);
  const reduceMotion = useReducedMotion();

  const openNow = (label: string | null) => {
    clearTimeout(closeTimer.current);
    setOpenMenu(label);
  };
  const closeSoon = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpenMenu(null), 180);
  };

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!openMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearTimeout(closeTimer.current);
        setOpenMenu(null);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        clearTimeout(closeTimer.current);
        setOpenMenu(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [openMenu]);

  return (
    <nav ref={rootRef} aria-label="Primary" className={cn("relative", className)} onMouseLeave={closeSoon}>
      <LayoutGroup id="marketing-nav">
        <ul className="flex items-center">
          {items.map((item) => {
            const active = isActive(item.href);
            const open = openMenu === item.label;
            const showPill = hovered === item.label || open;

            return (
              <li
                key={item.label}
                className="relative"
                onMouseEnter={(event) => {
                  setHovered(item.label);
                  if (item.categories) setPanelLeft(event.currentTarget.offsetLeft);
                  openNow(item.categories ? item.label : null);
                }}
                onMouseLeave={() => setHovered(null)}
              >
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  aria-expanded={item.categories ? open : undefined}
                  onFocus={(event) => {
                    if (item.categories) setPanelLeft(event.currentTarget.parentElement?.offsetLeft ?? 0);
                    openNow(item.categories ? item.label : null);
                  }}
                  className={cn(
                    "group relative flex h-16 items-center gap-1.5 px-3 text-[14px] whitespace-nowrap",
                    "transition-colors duration-100 ease-out",
                    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                    active ? "font-medium text-ink" : "text-text-secondary hover:text-text-primary",
                  )}
                >
                  {/* The sliding pill. One element shared across every item:
                      `layoutId` is what makes it travel rather than blink. */}
                  {showPill && (
                    <motion.span
                      layoutId={reduceMotion ? undefined : "marketing-nav-hover"}
                      transition={reduceMotion ? { duration: 0 } : PILL_TRANSITION}
                      aria-hidden="true"
                      className="bg-accent-subtle absolute inset-x-0 inset-y-3 -z-10 rounded-sm"
                    />
                  )}
                  {/* A flex sibling, not nested in the label: inside the span
                      the lock pushed "Security" onto a second line. */}
                  {item.adornment}
                  <span className="relative">{item.label}</span>
                  {item.categories && (
                    <CaretDown
                      size={12}
                      aria-hidden="true"
                      className={cn("transition-transform duration-150 ease-out motion-reduce:transition-none", open && "rotate-180")}
                    />
                  )}
                  {/* Active marker: DESIGN.md §7's leading rail, rotated for a
                      horizontal bar so it lands on the header's own hairline. */}
                  <span
                    aria-hidden="true"
                    className={cn("bg-gold absolute inset-x-0 bottom-0 h-0.5", active ? "opacity-100" : "opacity-0")}
                  />
                </Link>
              </li>
            );
          })}
        </ul>

        <AnimatePresence>
          {items.map((item) =>
            item.categories && openMenu === item.label ? (
              <motion.div
                key={item.label}
                layoutId={reduceMotion ? undefined : "marketing-nav-panel"}
                initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                transition={PANEL_TRANSITION}
                onMouseEnter={() => openNow(item.label)}
                style={{ left: panelLeft }}
                /* `w-max`: the panel is absolutely positioned inside the nav, so without
                   it shrink-to-fit clamps it to whatever nav width remains to the
                   right of the trigger and every description wraps. */
                className="absolute top-full z-50 w-max max-w-[min(100vw-3rem,1100px)] pt-2"
              >
                {/* Columns wrap instead of running off the screen: four
                    categories side by side is ~960px, which overflowed the
                    viewport (and forced horizontal page scroll) at 1024px and
                    1280px. Below 2xl they lay out two-up. */}
                <div
                  className={cn(
                    "border-border-subtle bg-surface grid gap-x-8 gap-y-6 rounded-md border p-5 shadow-[var(--shadow-level-2)]",
                    item.categories.length >= 3 ? "grid-cols-2 2xl:grid-cols-4" : item.categories.length === 2 ? "grid-cols-2" : "grid-cols-1",
                  )}
                >
                  {item.categories.map((category) => (
                    <div key={category.label} className="flex min-w-[200px] flex-col gap-3">
                      <p className="text-text-tertiary text-[11px] font-semibold tracking-wide uppercase">{category.label}</p>
                      <ul className="flex flex-col gap-1">
                        {category.items.map((leaf) => {
                          const LeafIcon = leaf.icon;
                          return (
                            <li key={leaf.label}>
                              <Link
                                href={leaf.href}
                                onClick={() => setOpenMenu(null)}
                                className={cn(
                                  "group flex items-start gap-3 rounded-sm p-2",
                                  "transition-colors duration-100 ease-out hover:bg-surface-sunken",
                                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                                )}
                              >
                                <span className="border-border-subtle text-text-secondary group-hover:border-accent group-hover:text-accent flex size-9 shrink-0 items-center justify-center rounded-sm border transition-colors duration-100 ease-out">
                                  <LeafIcon size={18} aria-hidden="true" />
                                </span>
                                <span className="leading-5">
                                  <span className="text-text-primary block text-[13px] font-medium">{leaf.label}</span>
                                  <span className="text-text-secondary block text-[12px]">{leaf.description}</span>
                                </span>
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              </motion.div>
            ) : null,
          )}
        </AnimatePresence>
      </LayoutGroup>
    </nav>
  );
}
