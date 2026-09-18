"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/**
 * Route-change entrance for the public site only (mounted inside
 * MarketingShell — /app/[orgId]/... and /login/signup never render
 * this). `key={pathname}` forces the div to remount on every marketing
 * navigation; the `.page-enter` class (globals.css) uses native
 * `@starting-style` to play the entrance on that fresh mount — no
 * custom router, no fragile navigation interception, no JS mounted-state
 * bookkeeping.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="page-enter">
      {children}
    </div>
  );
}
