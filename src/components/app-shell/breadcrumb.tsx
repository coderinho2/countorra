"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CaretRight } from "@phosphor-icons/react/dist/ssr/CaretRight";
import { NAV_ITEMS, SETTINGS_ITEM } from "./nav-items";

/**
 * DESIGN.md §7: the top bar carries the breadcrumb/page title on the left.
 * It previously carried the organization name — which is the sidebar's job
 * now — leaving the top bar saying nothing about where you actually were.
 *
 * Deliberately shallow. On a section route it shows the section; on a child
 * route it shows the section as a link back plus what the child is. It does
 * not attempt to name the record: the URL segment there is a UUID, and the
 * record's real name is already the page's own heading. A breadcrumb that
 * renders "Invoices / 8f2c1b04-…" is worse than one that renders
 * "Invoices / Invoice".
 */
const CHILD_LABEL: Record<string, string> = {
  new: "New",
};

export function Breadcrumb() {
  const pathname = usePathname();
  // /app/{orgId}/{section}/{child?}
  const segments = pathname.split("/").filter(Boolean);
  const section = segments[2];
  const child = segments[3];
  if (!section) return null;

  const item = [...NAV_ITEMS, SETTINGS_ITEM].find((navItem) => navItem.href("_").endsWith(`/${section}`));
  const sectionLabel = item?.label ?? section.charAt(0).toUpperCase() + section.slice(1);
  const sectionHref = `/${segments.slice(0, 3).join("/")}`;
  // A UUID segment means "one of these", so name the singular thing rather
  // than echoing the identifier.
  const childLabel = child ? (CHILD_LABEL[child] ?? sectionLabel.replace(/s$/, "")) : null;

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[14px]">
      {childLabel ? (
        <>
          <Link
            href={sectionHref}
            className="text-text-secondary hover:text-text-primary focus-visible:outline-accent rounded-sm transition-colors duration-[var(--duration-fast)] ease-out focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {sectionLabel}
          </Link>
          <CaretRight size={12} aria-hidden="true" className="text-text-tertiary shrink-0" />
          <span aria-current="page" className="text-ink truncate font-medium">
            {childLabel}
          </span>
        </>
      ) : (
        <span aria-current="page" className="text-ink truncate font-medium">
          {sectionLabel}
        </span>
      )}
    </nav>
  );
}
