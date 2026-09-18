"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useRef, useTransition } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { X } from "@phosphor-icons/react/dist/ssr/X";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Category } from "@/server/db/repositories/categories";

/**
 * Debounced search + dropdown filters, all reflected in the URL (product spec
 * §9, §41) so a filtered view is shareable/bookmarkable and survives a
 * refresh — no client-only filter state.
 *
 * Sized as a toolbar rather than as a form: 32px controls, the search field
 * carrying its own icon, and a "Clear" affordance that only exists when
 * something is actually filtered. The previous 40px inputs at full width made
 * the filter row heavier than the table it filters, which is the wrong way
 * round — controls are chrome, the ledger is the content.
 */
export function TransactionFilters({ categories }: { categories: Category[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const setParam = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete("page");
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  };

  const searchTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onSearchChange = (value: string) => {
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => setParam("search", value || null), 300);
  };

  const active = ["kind", "categoryId", "reviewed", "search"].filter((key) => searchParams.get(key));

  const clearAll = () => {
    if (inputRef.current) inputRef.current.value = "";
    clearTimeout(searchTimeout.current);
    startTransition(() => router.push(pathname));
  };

  const triggerClass = "h-8 text-[13px]";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <MagnifyingGlass size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-tertiary" />
        <input
          ref={inputRef}
          type="search"
          aria-label="Search transactions"
          placeholder="Search description or memo"
          defaultValue={searchParams.get("search") ?? ""}
          onChange={(e) => onSearchChange(e.target.value)}
          className={cn(
            "h-8 w-56 rounded-sm border border-border bg-surface pr-2.5 pl-7 text-[13px] text-text-primary outline-none",
            "placeholder:text-text-tertiary",
            "transition-[border-color,box-shadow] duration-[var(--duration-fast)] ease-out",
            "hover:border-border-strong focus:border-accent focus:ring-2 focus:ring-accent/20 focus:ring-offset-2 focus:ring-offset-surface",
          )}
        />
      </div>

      <Select value={searchParams.get("kind") ?? "all"} onValueChange={(v) => setParam("kind", v === "all" ? null : v)}>
        <SelectTrigger className={cn(triggerClass, "w-32")} aria-label="Type">
          <SelectValue placeholder="All types" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All types</SelectItem>
          <SelectItem value="income">Income</SelectItem>
          <SelectItem value="expense">Expense</SelectItem>
          <SelectItem value="transfer">Transfer</SelectItem>
        </SelectContent>
      </Select>

      <Select value={searchParams.get("categoryId") ?? "all"} onValueChange={(v) => setParam("categoryId", v === "all" ? null : v)}>
        <SelectTrigger className={cn(triggerClass, "w-44")} aria-label="Category">
          <SelectValue placeholder="All categories" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All categories</SelectItem>
          {categories.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={searchParams.get("reviewed") ?? "all"} onValueChange={(v) => setParam("reviewed", v === "all" ? null : v)}>
        <SelectTrigger className={cn(triggerClass, "w-36")} aria-label="Review status">
          <SelectValue placeholder="Review status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          <SelectItem value="false">Unreviewed</SelectItem>
          <SelectItem value="true">Reviewed</SelectItem>
        </SelectContent>
      </Select>

      {active.length > 0 && (
        <button
          type="button"
          onClick={clearAll}
          className={cn(
            "flex h-8 items-center gap-1 rounded-sm px-2 text-[13px] text-text-secondary",
            "transition-colors duration-[var(--duration-fast)] ease-out hover:bg-surface-sunken hover:text-text-primary",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          )}
        >
          <X size={12} />
          Clear {active.length}
        </button>
      )}
    </div>
  );
}
