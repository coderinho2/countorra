"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A segmented control — the period/status selector DESIGN.md §15 item 2
 * specifies for the dashboard chart, and which §26 requires wherever a
 * dropdown-only period selector would otherwise be used.
 *
 * Built as a real radiogroup rather than a row of buttons: the whole control
 * is one tab stop and arrow keys move between options, which is how a native
 * segmented control behaves and what a keyboard user will try. A row of
 * buttons makes the user tab through every period one at a time.
 *
 * The active indicator is a single absolutely-positioned element that slides
 * between segments instead of a background toggling on each one. That is the
 * whole reason this component exists as JS rather than as links: the movement
 * carries the change. It is a transform, so it costs nothing, and it collapses
 * to instant under reduced motion via the global rule in globals.css.
 */
export interface SegmentedOption {
  value: string;
  label: string;
}

export function Segmented({
  options,
  value,
  onValueChange,
  ariaLabel,
  className,
  size = "md",
}: {
  options: SegmentedOption[];
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (activeIndex + delta + options.length) % options.length;
    onValueChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn("border-border-subtle bg-surface-sunken relative inline-flex rounded-sm border p-0.5", className)}
    >
      {/* The indicator is laid out in fractions of the track rather than
          measured from the DOM, so it is correct on first paint — a measured
          indicator flashes at the wrong position before its effect runs. */}
      <span
        aria-hidden="true"
        className="border-border-subtle bg-surface absolute top-0.5 bottom-0.5 left-0.5 rounded-[4px] border transition-transform duration-[var(--duration-panel)] ease-[var(--ease-emphasized)]"
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          transform: `translateX(${activeIndex * 100}%)`,
        }}
      />
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onValueChange(option.value)}
            className={cn(
              "relative z-10 flex-1 rounded-[4px] whitespace-nowrap transition-colors duration-[var(--duration-fast)] ease-out",
              "focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-2",
              size === "sm" ? "px-2.5 py-1 text-[12px]" : "px-3 py-1.5 text-[13px]",
              active ? "text-ink font-medium" : "text-text-secondary hover:text-text-primary",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
