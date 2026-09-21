"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { ArrowsLeftRight } from "@phosphor-icons/react/dist/ssr/ArrowsLeftRight";
import { FileText } from "@phosphor-icons/react/dist/ssr/FileText";
import { UsersThree } from "@phosphor-icons/react/dist/ssr/UsersThree";
import { FolderOpen } from "@phosphor-icons/react/dist/ssr/FolderOpen";
import { ChatCircleText } from "@phosphor-icons/react/dist/ssr/ChatCircleText";
import { globalSearch, type SearchResults, type SearchResultItem } from "@/server/search/actions";
import { visibleNavItems, AI_NAV_ITEM } from "./nav-items";
import { cn } from "@/lib/utils";
import type { UserEntityType } from "@/domain/organizations/types";

const EMPTY_RESULTS: SearchResults = {
  transactions: [],
  invoices: [],
  customers: [],
  documents: [],
};

const GROUP_ICON = {
  Transactions: ArrowsLeftRight,
  Invoices: FileText,
  Customers: UsersThree,
  Documents: FolderOpen,
} as const;

/**
 * DESIGN.md's dialog spec (border + Level-3 shadow, radius-lg) applied to
 * cmdk's unstyled primitives — cmdk supplies keyboard nav and filtering
 * mechanics only, none of its own visual opinion, so nothing here reads as a
 * third-party widget dropped into the product.
 *
 * Three things changed in the Phase 2 pass:
 *
 * 1. It is a real Radix Dialog. The previous shape was `open && <div>` with
 *    an outside-click handler and a hand-rolled Escape listener: no focus
 *    trap, no scroll lock, and focus was never returned to the trigger, so a
 *    keyboard user who opened the palette and closed it landed back at the
 *    top of the document.
 * 2. Empty is no longer a dead end. With nothing typed it offers the places
 *    you can go, so Cmd-K is a navigator as well as a search box — that is
 *    the difference between a search modal and a command palette.
 * 3. The trigger shrank to fit beside the other top-bar controls. It used to
 *    be a 256px field in the centre of the bar, which gave search more
 *    visual weight than anything on the page beneath it.
 */
export function CommandPalette({ organizationId, entityType }: { organizationId: string; entityType?: UserEntityType }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    // Below the 2-character floor, the render below shows navigation
    // suggestions directly off `query` — no need to reset `results` here too.
    if (trimmed.length < 2) return;
    const timeout = setTimeout(() => {
      startTransition(async () => {
        setResults(await globalSearch(organizationId, trimmed));
      });
    }, 200); // debounced — product spec §41
    return () => clearTimeout(timeout);
  }, [query, open, organizationId]);

  const navigate = (href: string) => {
    setOpen(false);
    setQuery("");
    router.push(href);
  };

  const hasResults = results.transactions.length + results.invoices.length + results.customers.length + results.documents.length > 0;
  const navItems = entityType ? [...visibleNavItems(entityType), AI_NAV_ITEM] : [];

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label="Search"
          className={cn(
            "border-border-subtle bg-surface-sunken/60 text-text-tertiary flex h-9 items-center gap-2 rounded-sm border px-2",
            "hover:border-border hover:text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out",
            "focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-2",
            "md:w-52 md:justify-start md:pr-1.5 md:pl-2.5",
          )}
        >
          <MagnifyingGlass size={16} className="shrink-0" />
          <span className="hidden text-[13px] md:inline">Search</span>
          <kbd className="border-border-subtle bg-surface font-numeric ml-auto hidden rounded-[4px] border px-1.5 py-0.5 text-[11px] md:inline">
            &#8984;K
          </kbd>
        </button>
      </DialogPrimitive.Trigger>

      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "bg-ink/40 fixed inset-0 z-50",
            "transition-opacity duration-[var(--duration-modal)] ease-out",
            "data-[state=closed]:opacity-0 data-[state=closed]:duration-[var(--duration-exit)] data-[state=open]:opacity-100",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed top-[14vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2",
            "border-border-subtle bg-surface overflow-hidden rounded-lg border shadow-[var(--shadow-level-3)]",
            "transition-[opacity,transform] duration-[var(--duration-modal)] ease-[var(--ease-emphasized)]",
            "data-[state=open]:scale-100 data-[state=open]:opacity-100",
            "data-[state=closed]:scale-[0.98] data-[state=closed]:opacity-0 data-[state=closed]:duration-[var(--duration-exit)]",
          )}
        >
          <DialogPrimitive.Title className="sr-only">Search</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search transactions and documents, or jump to a section.
          </DialogPrimitive.Description>

          <Command shouldFilter={false} loop>
            <div className="border-border-subtle flex items-center gap-2.5 border-b px-4">
              <MagnifyingGlass size={16} className="text-text-tertiary shrink-0" />
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder="Search transactions, documents..."
                className="text-text-primary placeholder:text-text-tertiary h-12 w-full bg-transparent text-[15px] outline-none"
              />
              {isPending && <span aria-hidden="true" className="ai-thinking-dot bg-gold size-1.5 shrink-0 rounded-full" />}
            </div>

            <Command.List className="max-h-[min(24rem,50vh)] overflow-y-auto p-1.5">
              {query.trim().length < 2 ? (
                navItems.length > 0 ? (
                  <Command.Group heading="Go to" className={GROUP_HEADING}>
                    {navItems.map((item) => {
                      const Icon = item.icon;
                      return (
                        <Command.Item
                          key={item.label}
                          value={item.label}
                          onSelect={() => navigate(item.href(organizationId))}
                          className="text-text-primary data-[selected=true]:bg-surface-sunken flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-2 text-[14px]"
                        >
                          <Icon size={16} className="text-text-tertiary shrink-0" />
                          {item.label}
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ) : (
                  <p className="text-text-tertiary px-2 py-6 text-center text-[13px]">Type at least 2 characters to search.</p>
                )
              ) : !hasResults && !isPending ? (
                <Command.Empty className="flex flex-col items-center gap-2 px-2 py-8 text-center">
                  <span className="text-text-primary text-[14px]">No matches for &ldquo;{query.trim()}&rdquo;</span>
                  <span className="text-text-tertiary text-[13px]">Try a merchant, a file name, or an amount.</span>
                </Command.Empty>
              ) : (
                <>
                  <ResultGroup heading="Transactions" items={results.transactions} onSelect={navigate} />
                  <ResultGroup heading="Invoices" items={results.invoices} onSelect={navigate} />
                  <ResultGroup heading="Customers" items={results.customers} onSelect={navigate} />
                  <ResultGroup heading="Documents" items={results.documents} onSelect={navigate} />
                </>
              )}
            </Command.List>

            {/* Key hints, the way a keyboard-first surface tells you it is
                keyboard-first. Hidden on touch, where none of them apply. */}
            <div className="border-border-subtle bg-surface-sunken/50 text-text-tertiary hidden items-center gap-4 border-t px-4 py-2 text-[11px] sm:flex">
              <span className="flex items-center gap-1.5">
                <Key>&uarr;</Key>
                <Key>&darr;</Key>
                navigate
              </span>
              <span className="flex items-center gap-1.5">
                <Key>&crarr;</Key>
                open
              </span>
              <span className="flex items-center gap-1.5">
                <Key>esc</Key>
                close
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                <ChatCircleText size={12} />
                Ask your money for the rest
              </span>
            </div>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const GROUP_HEADING =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-[0.02em] [&_[cmdk-group-heading]]:text-text-tertiary [&_[cmdk-group-heading]]:uppercase";

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="border-border-subtle bg-surface font-numeric text-text-secondary rounded-[4px] border px-1 py-px text-[10px]">{children}</kbd>
  );
}

function ResultGroup({
  heading,
  items,
  onSelect,
}: {
  heading: keyof typeof GROUP_ICON;
  items: SearchResultItem[];
  onSelect: (href: string) => void;
}) {
  if (items.length === 0) return null;
  const Icon = GROUP_ICON[heading];
  return (
    <Command.Group heading={heading} className={GROUP_HEADING}>
      {items.map((item) => (
        <Command.Item
          key={item.id}
          value={item.id}
          onSelect={() => onSelect(item.href)}
          className={cn(
            "text-text-primary flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-2 text-[14px]",
            "data-[selected=true]:bg-surface-sunken",
          )}
        >
          <Icon size={16} className="text-text-tertiary mt-px shrink-0 self-start" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{item.title}</span>
            <span className="text-text-tertiary truncate text-[12px]">{item.subtitle}</span>
          </span>
        </Command.Item>
      ))}
    </Command.Group>
  );
}
