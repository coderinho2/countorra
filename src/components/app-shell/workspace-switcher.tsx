"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CaretUpDown } from "@phosphor-icons/react/dist/ssr/CaretUpDown";
import { Check } from "@phosphor-icons/react/dist/ssr/Check";
import { Plus } from "@phosphor-icons/react/dist/ssr/Plus";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// Personal only at launch; the layout passes every workspace as personal.
const ENTITY_LABEL: Record<string, string> = {
  personal: "Personal finances",
};

export interface WorkspaceOption {
  id: string;
  name: string;
  entityType: string;
}

/**
 * The workspace the user is currently inside, and the way to leave it.
 *
 * The sidebar previously opened with a link back to the marketing site,
 * which is the one destination a signed-in user almost never wants and the
 * one piece of information they always need — *which* set of books am I
 * looking at — was rendered as plain text in the top bar. A user with a
 * personal workspace and a business workspace could read the same numbers
 * in either and not immediately know which.
 *
 * The identity mark is DESIGN.md §14's treatment for the assistant applied
 * to the workspace: a solid ink square with a single letter. No gradient, no
 * generated avatar, no colour-hashed circle.
 */
export function WorkspaceSwitcher({ current, organizations }: { current: WorkspaceOption; organizations: WorkspaceOption[] }) {
  const router = useRouter();
  const others = organizations.filter((o) => o.id !== current.id);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "group flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-left",
            "hover:bg-surface-sunken transition-colors duration-[var(--duration-fast)] ease-out",
            "focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-2",
          )}
        >
          <span
            aria-hidden="true"
            className="bg-ink text-paper flex size-7 shrink-0 items-center justify-center rounded-sm text-[13px] font-semibold"
          >
            {current.name.trim().charAt(0).toUpperCase() || "A"}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-ink truncate text-[14px] leading-[18px] font-medium">{current.name}</span>
            <span className="text-text-tertiary truncate text-[11px] leading-[14px]">{ENTITY_LABEL[current.entityType] ?? current.entityType}</span>
          </span>
          <CaretUpDown
            size={14}
            className="text-text-tertiary group-hover:text-text-secondary ml-auto shrink-0 transition-colors duration-[var(--duration-fast)] ease-out"
          />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-60">
        <p className="text-text-tertiary px-2.5 py-1.5 text-[11px] font-semibold tracking-[0.02em] uppercase">Workspaces</p>
        <DropdownMenuItem className="gap-2 text-[14px]" onSelect={() => router.push(`/app/${current.id}/dashboard`)}>
          <Check weight="bold" className="text-accent size-3.5 shrink-0" />
          <span className="truncate">{current.name}</span>
        </DropdownMenuItem>
        {others.map((organization) => (
          <DropdownMenuItem key={organization.id} className="gap-2 text-[14px]" onSelect={() => router.push(`/app/${organization.id}/dashboard`)}>
            <span className="size-3.5 shrink-0" />
            <span className="truncate">{organization.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="gap-2 text-[14px]">
          <Link href="/onboarding">
            <Plus className="text-text-tertiary size-3.5 shrink-0" />
            New workspace
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
