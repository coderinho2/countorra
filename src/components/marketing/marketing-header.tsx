"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { List } from "@phosphor-icons/react/dist/ssr/List";
import { X } from "@phosphor-icons/react/dist/ssr/X";
import { CaretDown } from "@phosphor-icons/react/dist/ssr/CaretDown";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { signOut } from "@/server/auth/actions";
import type { PublicIdentity } from "@/lib/identity";
import { BrandMark } from "./brand-mark";
import { LockMark } from "./lock-mark";
import { NAV_GROUPS, DIRECT_LINKS } from "./nav-data";
import { isNavItemActive, mobileNavItemClass } from "./nav-active";
import { DropdownNavigation, type DropdownNavItem } from "@/components/ui/dropdown-navigation";
import { ThemeSwitcher } from "@/components/ui/theme-switcher";

/** DESIGN.md §14's identity-mark language ("a small solid-color initial
 *  mark — a 24px square, radius-sm, ink background, single-letter glyph
 *  in paper") reused here so the account menu reads as the same product,
 *  not a bolted-on generic account widget. */
function IdentityMark({ initials }: { initials: string }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-ink text-[11px] font-semibold text-paper" aria-hidden="true">
      {initials}
    </span>
  );
}

/**
 * DESIGN.md §7 marketing header, extended with a real information
 * architecture (product spec): wordmark + original brand mark, three
 * categorized mega menus, two direct links (Pricing, Security), and an
 * auth-aware account area — sticky, 64px, frosted, bottom hairline appears
 * only past an 8px scroll. The one sanctioned use of glassmorphism in
 * this document (§26 bans it everywhere else).
 *
 * `identity` comes from a real server-side session + profile lookup
 * (MarketingShell → src/server/auth/session.ts#getSession +
 * src/lib/identity.ts) — never guessed or stored client-side — so a
 * signed-in visitor sees their own name/initials and a small menu
 * ("Open Countorra" / "Settings" / "Log out") instead of "Sign in" /
 * "Get started". Logging out reuses the exact same
 * src/server/auth/actions.ts#signOut Server Action the authenticated
 * app's topbar uses; there is only one sign-out path.
 */
export function MarketingHeader({
  identity,
  appHref,
  settingsHref,
}: {
  identity: PublicIdentity | null;
  appHref: string;
  settingsHref: string;
}) {
  /* Built from the same nav-data as before, so every destination is
     unchanged: the three mega menus, then Pricing and Security as direct
     links (Security keeps its lock mark). */
  const desktopNavItems: DropdownNavItem[] = [
    ...NAV_GROUPS.map((group) => ({ label: group.label, href: group.href, categories: group.categories })),
    ...DIRECT_LINKS.map((link) => ({
      label: link.label,
      href: link.href,
      adornment: link.label === "Security" ? <LockMark /> : undefined,
    })),
  ];

  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openAccordion, setOpenAccordion] = useState<string | null>(null);
  const [, startSignOut] = useTransition();
  const pathname = usePathname();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 h-16 bg-paper/85 transition-[border-color] duration-150 ease-out",
        scrolled ? "border-b border-border-subtle" : "border-b border-transparent",
      )}
      style={{ backdropFilter: "saturate(1.6) blur(16px)", WebkitBackdropFilter: "saturate(1.6) blur(16px)" }}
    >
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6 lg:px-10">
        <div className="flex items-center gap-9">
          <Link href="/" className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.005em] text-ink">
            <BrandMark size={20} />
            Countorra
          </Link>

          <DropdownNavigation
            className="hidden lg:block"
            items={desktopNavItems}
            isActive={(href) => isNavItemActive(pathname, href)}
          />
        </div>

        <div className="hidden items-center gap-2 lg:flex">
          {/* Leading the utility cluster, before anything that navigates: a
              preference, not a destination. */}
          <ThemeSwitcher className="mr-1" />

          {identity ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-sm py-1.5 pr-2 pl-1.5 text-[14px] text-text-primary transition-colors duration-100 ease-out hover:bg-surface-sunken"
                >
                  <IdentityMark initials={identity.initials} />
                  <span className="max-w-[140px] truncate">{identity.displayName}</span>
                  <CaretDown size={12} className="text-text-tertiary" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem asChild>
                  <Link href={settingsHref}>Settings</Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => startSignOut(() => signOut())}>Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {identity ? (
            /* The signed-out pair is a quiet action beside a primary one;
               signed in keeps that exact shape — identity in the quiet slot,
               the way back into the product in the primary one. "Open
               Countorra" is promoted out of the account menu because it
               is the only thing a logged-in visitor is likely to want from
               this page, and burying it one click deep is what made the
               return path hard to find in the first place. */
            <Button asChild variant="primary" size="sm">
              <Link href={appHref}>Open Countorra</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild variant="primary" size="sm">
                <Link href="/signup">Get started</Link>
              </Button>
            </>
          )}
        </div>

        <button
          type="button"
          className="flex size-10 items-center justify-center rounded-sm text-text-primary lg:hidden"
          aria-expanded={menuOpen}
          aria-controls="mobile-nav-panel"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {menuOpen ? <X size={22} /> : <List size={22} />}
        </button>
      </div>

      {menuOpen && (
        <div id="mobile-nav-panel" className="max-h-[calc(100dvh-64px)] overflow-y-auto border-y border-border-subtle bg-paper px-6 py-4 lg:hidden">
          <div className="flex flex-col">
            {NAV_GROUPS.map((group) => {
              const isOpen = openAccordion === group.label;
              const active = isNavItemActive(pathname, group.href);
              const items = group.categories.flatMap((c) => c.items);
              return (
                <div key={group.label} className="border-b border-border-subtle py-1">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setOpenAccordion(isOpen ? null : group.label)}
                    className={mobileNavItemClass(active)}
                  >
                    {group.label}
                    <CaretDown size={14} className={cn("transition-transform duration-150 ease-out", isOpen && "rotate-180")} />
                  </button>
                  {isOpen && (
                    <div className="flex flex-col gap-0.5 pb-2 pl-3">
                      {items.map((item) => (
                        <Link
                          key={item.label}
                          href={item.href}
                          onClick={() => setMenuOpen(false)}
                          className="rounded-sm px-2 py-2 text-[14px] text-text-secondary transition-colors duration-100 ease-out hover:bg-surface-sunken hover:text-text-primary"
                        >
                          {item.label}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {DIRECT_LINKS.map((link) => {
              const active = isNavItemActive(pathname, link.href);
              return (
                <Link
                  key={link.label}
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                  aria-current={active ? "page" : undefined}
                  className={cn("border-b border-border-subtle", mobileNavItemClass(active))}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
          <div className="mt-4 flex flex-col gap-2">
            <div className="mb-1 flex items-center justify-between rounded-sm border border-border-subtle px-3 py-2">
              <span className="text-[14px] text-text-secondary">Appearance</span>
              <ThemeSwitcher />
            </div>

            {identity ? (
              <>
                <div className="mb-1 flex items-center gap-2 rounded-sm border border-border-subtle px-3 py-2.5">
                  <IdentityMark initials={identity.initials} />
                  <span className="truncate text-[14px] font-medium text-text-primary">{identity.displayName}</span>
                </div>
                <Button asChild variant="primary" size="md" onClick={() => setMenuOpen(false)}>
                  <Link href={appHref}>Open Countorra</Link>
                </Button>
                <Button asChild variant="secondary" size="md" onClick={() => setMenuOpen(false)}>
                  <Link href={settingsHref}>Settings</Link>
                </Button>
                <form action={signOut}>
                  <Button type="submit" variant="ghost" size="md" className="w-full justify-center">
                    Log out
                  </Button>
                </form>
              </>
            ) : (
              <>
                <Button asChild variant="secondary" size="md">
                  <Link href="/login">Sign in</Link>
                </Button>
                <Button asChild variant="primary" size="md">
                  <Link href="/signup">Get started</Link>
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
