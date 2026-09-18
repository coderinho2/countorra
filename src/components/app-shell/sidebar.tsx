"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr/ArrowUpRight";
import { cn } from "@/lib/utils";
import { BrandMark } from "@/components/marketing/brand-mark";
import type { UserEntityType } from "@/domain/organizations/types";
import { SETTINGS_ITEM, visibleNavGroups, type NavItem } from "./nav-items";
import { WorkspaceSwitcher, type WorkspaceOption } from "./workspace-switcher";

/**
 * A nav row (DESIGN.md §7): accent-subtle fill plus a 2px accent rail on the
 * left edge when active, surface-sunken on hover.
 *
 * The rail is always rendered and scaled to zero height when inactive rather
 * than mounted only on the active row. That is what lets it *grow* into place
 * on navigation instead of blinking — and because `scaleY` is a transform it
 * costs nothing to animate. Growth is anchored to the row's centre so it
 * opens outward from the middle rather than unrolling from one end, which
 * reads as deliberate rather than as a loading bar.
 *
 * The icon's weight change (regular → fill) is the second signal, so active
 * state is never carried by colour alone (DESIGN.md §24).
 */
export function NavLink({ item, orgId, pathname }: { item: NavItem; orgId: string; pathname: string }) {
  const href = item.href(orgId);
  const active = pathname === href || pathname.startsWith(`${href}/`);
  const Icon = item.icon;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-sm px-3 py-1.5 text-[14px]",
        "transition-[color,background-color] duration-[var(--duration-fast)] ease-out",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        active ? "bg-accent-subtle text-accent font-medium" : "text-text-secondary hover:bg-surface-sunken hover:text-text-primary",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "bg-accent absolute top-1 bottom-1 left-0 w-0.5 origin-center rounded-full",
          "transition-transform duration-[var(--duration-panel)] ease-[var(--ease-emphasized)]",
          active ? "scale-y-100" : "scale-y-0",
        )}
      />
      <Icon
        size={18}
        weight={active ? "fill" : "regular"}
        className="shrink-0 transition-transform duration-[var(--duration-fast)] ease-out group-active:scale-95"
      />
      {item.label}
    </Link>
  );
}

/**
 * The route back to the public site.
 *
 * This exists because removing it was a real product bug. When the workspace
 * switcher took over the top of the sidebar it displaced the brand link, and
 * a signed-in user was left with no way back to `/` at all — the marketing
 * site became unreachable from inside the product without editing the URL.
 *
 * It is a plain `<Link href="/">`, so it is an ordinary client-side
 * navigation: no sign-out, no session change, no second auth path. The
 * session cookie is untouched and the user stays logged in, which is what
 * makes returning cheap — they can come straight back.
 *
 * The outward arrow is the affordance that distinguishes "leaves the
 * application" from the navigation below it, which all stays inside.
 */
function BrandRow({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      href="/"
      onClick={onNavigate}
      title="Back to the public Countorra website"
      className={cn(
        "group flex h-11 shrink-0 items-center gap-2 px-3",
        "border-border-subtle border-b",
        "transition-colors duration-[var(--duration-fast)] ease-out hover:bg-surface-sunken",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
      )}
    >
      <BrandMark size={16} className="text-ink shrink-0" />
      <span className="text-ink truncate text-[13px] font-semibold">Countorra</span>
      <ArrowUpRight
        size={12}
        aria-hidden="true"
        className="text-text-tertiary ml-auto shrink-0 transition-transform duration-[var(--duration-fast)] ease-out group-hover:-translate-y-px group-hover:translate-x-px"
      />
    </Link>
  );
}

export { BrandRow };

/**
 * Desktop sidebar (DESIGN.md §7).
 *
 * Read top to bottom it states three things in descending scope: the product,
 * the workspace, then where you are inside it. Group labels are set in mono
 * micro-caps so they read as instrument dividers rather than as headings
 * competing with the nav items under them — the same voice as the context bar
 * and the numbered section rules, which is what keeps the shell and the
 * content feeling like one environment.
 */
export function Sidebar({
  orgId,
  entityType,
  organization,
  organizations,
}: {
  orgId: string;
  entityType: UserEntityType;
  organization: WorkspaceOption;
  organizations: WorkspaceOption[];
}) {
  const pathname = usePathname();
  const groups = visibleNavGroups(entityType);

  return (
    <aside className="border-border-subtle bg-surface hidden w-64 shrink-0 flex-col border-r lg:flex">
      <BrandRow />

      <div className="border-border-subtle flex h-14 items-center border-b px-3">
        <WorkspaceSwitcher current={organization} organizations={organizations} />
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-4">
        {groups.map((group, index) => (
          <div key={group.label ?? "primary"} className={cn("flex flex-col gap-0.5", index > 0 && "mt-6")}>
            {group.label && (
              <p className="font-numeric text-text-tertiary mb-1.5 flex items-center gap-2 px-3 text-[10px] tracking-[0.14em] uppercase">
                {group.label}
                <span aria-hidden="true" className="bg-border-subtle h-px flex-1" />
              </p>
            )}
            {group.items.map((item) => (
              <NavLink key={item.label} item={item} orgId={orgId} pathname={pathname} />
            ))}
          </div>
        ))}
      </nav>

      <div className="border-border-subtle border-t px-3 py-3">
        <NavLink item={SETTINGS_ITEM} orgId={orgId} pathname={pathname} />
      </div>
    </aside>
  );
}
