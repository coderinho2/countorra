"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/**
 * Route-change entrance for the authenticated product — the same mechanism
 * `PageTransition` gives the public site, so a user moving from the
 * marketing pages into the app never notices the interface change how it
 * behaves.
 *
 * `key` is the section, not the full pathname. Moving between sections
 * (Transactions → Invoices) replays the entrance, because that is a genuine
 * change of context. Moving *within* a section (a transaction list → that
 * transaction's detail, or the same list with a different filter in the
 * query string) does not, because re-animating there would make routine
 * work feel laggy — DESIGN.md §22 allows one subtle entrance per view, and
 * a filter change is not a new view.
 *
 * The entrance itself is CSS (`.page-enter`, native `@starting-style`), so
 * this component ships no animation logic, holds no state, and adds nothing
 * to the client bundle beyond a pathname read.
 */
function sectionKey(pathname: string): string {
  // /app/<orgId>/<section>/... → "<section>"
  return pathname.split("/").slice(0, 4).join("/");
}

export function ViewTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={sectionKey(pathname)} className="page-enter flex min-h-full flex-col">
      {children}
    </div>
  );
}
