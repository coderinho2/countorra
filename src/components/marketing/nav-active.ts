/**
 * Which public navigation item the current route belongs to.
 *
 * Kept as a pure function rather than inlined into the header because the
 * rule it encodes is not obvious: a nav item stays active for its whole
 * *section*, not just its own page. A page below a nav item's route has no
 * nav item of its own, so the item it belongs to must remain lit — otherwise
 * the header goes blank the moment a visitor drills into it and stops telling
 * them where they are.
 *
 * Section membership is a path-*segment* prefix, never a string prefix. A
 * naive `startsWith` would light "Product" on a hypothetical `/products`
 * route, which is a different section entirely.
 */

import { cn } from "@/lib/utils";

/** Strips a hash or query and any trailing slash, so `/product#accounting`,
 *  `/product/` and `/product` all compare as the same section root. */
function normalize(path: string): string {
  const withoutFragment = path.split(/[?#]/)[0] ?? "";
  if (withoutFragment.length > 1 && withoutFragment.endsWith("/")) {
    return withoutFragment.slice(0, -1);
  }
  return withoutFragment;
}

export function isNavItemActive(pathname: string, href: string): boolean {
  const current = normalize(pathname);
  const target = normalize(href);

  if (!target || !current) return false;

  // The wordmark's "/" is the whole site's prefix; it can only ever match
  // the homepage exactly, or every item would be active everywhere.
  if (target === "/") return current === "/";

  return current === target || current.startsWith(`${target}/`);
}

/**
 * Desktop nav item chrome, shared by the mega-menu triggers and the direct
 * links so both sit on one baseline and both mark "you are here" the same
 * way.
 *
 * DESIGN.md §7 specifies the *app shell's* active state — an accent-subtle
 * fill plus a 2px accent rail on the row's leading edge — and is silent on
 * the marketing header. Rather than invent a second visual idea, this is
 * that same rail rotated for a horizontal bar: a 2px accent rule on the
 * item's bottom edge. Because the item spans the header's full 64px height,
 * that rule lands exactly on the header's own bottom hairline, the way the
 * sidebar's rail lands on the sidebar's edge.
 *
 * The accent-subtle fill is deliberately dropped: a filled block inside a
 * frosted 64px bar reads as a browser tab, not as a marker. The weight step
 * to medium in `--color-ink` carries that job instead, which is what makes
 * the state unmistakable at a glance without raising its voice.
 */
export function desktopNavItemClass(active: boolean): string {
  return cn(
    "flex h-16 items-center border-b-2 text-[14px] transition-colors duration-100 ease-out",
    active ? "border-accent font-medium text-ink" : "border-transparent text-text-secondary hover:text-text-primary",
  );
}

/**
 * The mobile panel is a vertical list, so here DESIGN.md §7's rail applies
 * literally — 2px of accent on the leading edge — with the same weight and
 * ink step. Inactive rows keep a transparent rail of the same width so
 * nothing shifts horizontally when the active item changes.
 */
export function mobileNavItemClass(active: boolean): string {
  return cn(
    "flex w-full items-center justify-between border-l-2 py-2.5 pr-2 pl-3 text-[15px] transition-colors duration-100 ease-out",
    active ? "border-accent font-semibold text-ink" : "border-transparent font-medium text-text-primary",
  );
}
