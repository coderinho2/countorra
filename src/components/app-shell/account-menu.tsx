"use client";

import { useRef } from "react";
import Link from "next/link";
import { CaretDown } from "@phosphor-icons/react/dist/ssr/CaretDown";
import { Gear } from "@phosphor-icons/react/dist/ssr/Gear";
import { SignOut } from "@phosphor-icons/react/dist/ssr/SignOut";
import { ArrowSquareOut } from "@phosphor-icons/react/dist/ssr/ArrowSquareOut";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Account identity and the actions attached to it.
 *
 * The top bar previously printed the signed-in email as loose text beside a
 * "Sign out" button. That gave the least-used action in the product the same
 * visual weight as the search field, and on a narrow window the email was
 * simply dropped, leaving a bare Sign out button as the only thing on the
 * right — which reads as the primary action of the page.
 *
 * Sign-out is a real `<form action={signOut}>`, so it is still a POST to a
 * Server Action. The form deliberately lives OUTSIDE the menu. Selecting a
 * Radix menu item closes the menu synchronously (flushSync), which unmounts
 * everything inside it before the browser performs a submit button's default
 * action — a form rendered inside the item is already disconnected by then,
 * and the browser cancels the submission ("Form submission canceled because
 * the form is not connected"): the user stays signed in. Keyboard selection
 * never worked either, because Radix activates an item by calling click() on
 * it, and clicking a <form> element does not submit it. So the item submits
 * the outside form from onSelect, which runs for pointer and keyboard alike.
 */
export function AccountMenu({ userEmail, settingsHref, signOutAction }: { userEmail: string; settingsHref: string; signOutAction: () => void }) {
  const initial = userEmail.trim().charAt(0).toUpperCase() || "?";
  const signOutFormRef = useRef<HTMLFormElement>(null);

  return (
    <>
    <form ref={signOutFormRef} action={signOutAction} hidden />
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className={cn(
            "group flex items-center gap-1.5 rounded-sm py-1 pr-1 pl-1",
            "hover:bg-surface-sunken transition-colors duration-[var(--duration-fast)] ease-out",
            "focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-2",
          )}
        >
          <span
            aria-hidden="true"
            className="border-border-subtle bg-surface-sunken text-text-secondary flex size-7 items-center justify-center rounded-sm border text-[12px] font-semibold"
          >
            {initial}
          </span>
          <CaretDown
            size={12}
            className="text-text-tertiary shrink-0 transition-transform duration-[var(--duration-fast)] ease-out group-data-[state=open]:rotate-180"
          />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        <div className="border-border-subtle border-b px-2.5 pt-1.5 pb-2.5">
          <p className="text-text-tertiary text-[11px] font-semibold tracking-[0.02em] uppercase">Signed in as</p>
          <p className="text-text-primary mt-0.5 truncate text-[13px]">{userEmail}</p>
        </div>
        <DropdownMenuItem asChild className="mt-1 gap-2 text-[14px]">
          <Link href={settingsHref}>
            <Gear className="text-text-tertiary size-4 shrink-0" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className="gap-2 text-[14px]">
          <Link href="/">
            <ArrowSquareOut className="text-text-tertiary size-4 shrink-0" />
            Back to website
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2 text-[14px]" onSelect={() => signOutFormRef.current?.requestSubmit()}>
          <SignOut className="text-text-tertiary size-4 shrink-0" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}
