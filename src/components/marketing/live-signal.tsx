"use client";

import { useState } from "react";
import { CaretDown } from "@phosphor-icons/react/dist/ssr/CaretDown";
import { cn } from "@/lib/utils";

const FACTS = ["17 recurring charges", "8 merchants", "12-month comparison"];

/**
 * One small, real piece of the product surfaced on the marketing page —
 * not a tooltip, not a giant card. A real disclosure button (not a
 * hover-only reveal, which fails keyboard and touch entirely) that
 * expands via the CSS grid-rows technique — animating to `auto` height
 * with plain CSS transitions isn't possible, but animating a
 * `grid-template-rows` track from `0fr` to `1fr` is, and it settles
 * exactly at content height with no measurement in JS.
 */
export function LiveSignal() {
  const [open, setOpen] = useState(false);

  return (
    <div className="mx-auto max-w-sm rounded-md border border-border-subtle bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors duration-100 ease-out hover:bg-surface-sunken"
      >
        <div>
          <p className="text-[11px] font-semibold tracking-wide text-text-tertiary uppercase">Financial signal</p>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-[13px] text-text-secondary">Recurring spending</span>
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="font-numeric text-lg font-medium text-ink">$1,284.00</span>
            <span className="font-numeric text-[12px] text-text-secondary">/ year</span>
            <span className="font-numeric text-[12px] text-negative">+8.4% vs. average</span>
          </div>
        </div>
        <CaretDown size={14} className={cn("shrink-0 text-text-tertiary transition-transform duration-200 ease-[var(--ease-out)]", open && "rotate-180")} />
      </button>

      <div className="grid transition-[grid-template-rows] duration-200 ease-[var(--ease-out)]" style={{ gridTemplateRows: open ? "1fr" : "0fr" }}>
        <div className="overflow-hidden">
          <ul className="flex flex-col gap-1.5 border-t border-border-subtle px-4 py-3">
            {FACTS.map((fact) => (
              <li key={fact} className="text-[13px] text-text-secondary">
                {fact}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
