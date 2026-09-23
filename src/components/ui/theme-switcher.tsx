"use client";

import { useRef, useSyncExternalStore } from "react";
import { MoonStarIcon, SunIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

/**
 * Light / Dark, as a segmented pill.
 *
 * SHAPE
 *
 * Two options, never three. The provider still defaults to the operating
 * system (src/components/theme/theme-provider.tsx, DESIGN.md §25), but
 * "System" is not a thing a person wants to *say* — they want the product
 * light or dark. So the control reads `resolvedTheme`, which is the
 * appearance actually on screen, and shows that one as selected. Someone who
 * has never touched it sees their OS setting reflected honestly; touching it
 * writes an explicit choice that then wins everywhere.
 *
 * SURFACE
 *
 * The track is `paper` with a hairline, so it sits quietly on both the
 * frosted marketing header and the app topbar's `surface`. The thumb is
 * `surface-sunken`: against light paper that reads as an inset well, against
 * dark paper as a lifted tile — the correct direction for each mode, which a
 * single fixed colour cannot be. Gold is deliberately not used; in the
 * marketing header it would compete with the one gold CTA beside it
 * (DESIGN.md §3 — the accent is a precision detail, not a default).
 *
 * MOTION
 *
 * The thumb is the only animated thing: a shared-layout transform, 180ms on
 * DESIGN.md §22's emphasized curve, which is the "in place" tier. Icons only
 * change colour. `useReducedMotion` drops the slide to zero — the thumb still
 * moves, it just arrives instantly.
 *
 * HIT AREA
 *
 * Each option is 44px wide and its hit area is extended to 44px tall by a
 * pseudo-element, so DESIGN.md §24's minimum touch target is met without
 * making the header control visually bulky. The extension is vertical only;
 * widening both sides would overlap the neighbouring option.
 */

const OPTIONS = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonStarIcon },
] as const;

/** Matches the mounted control exactly, so nothing reflows on hydration. */
const SIZE = "h-[34px] w-[90px]";

/**
 * Whether we are past hydration. The server cannot know the visitor's theme,
 * so the first client render has to match the server's and only then swap in
 * the real control. `useSyncExternalStore` states that directly — one value
 * on the server, another on the client — instead of a mount effect that sets
 * state and re-renders.
 */
const NEVER_CHANGES = () => () => {};
const onClient = () => true;
const onServer = () => false;

export function ThemeSwitcher({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const reduceMotion = useReducedMotion();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const mounted = useSyncExternalStore(NEVER_CHANGES, onClient, onServer);

  // Reserving the exact footprint keeps the swap from being visible as a jump.
  if (!mounted) return <div className={cn(SIZE, className)} aria-hidden="true" />;

  const activeIndex = Math.max(
    0,
    OPTIONS.findIndex((option) => option.value === resolvedTheme),
  );

  // Roving tabindex: the group is one tab stop and the arrows move within it,
  // which is what `radiogroup` promises a screen reader.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (activeIndex + step + OPTIONS.length) % OPTIONS.length;
    setTheme(OPTIONS[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      onKeyDown={onKeyDown}
      className={cn("inline-flex items-center rounded-pill border border-border-subtle bg-paper p-px", className)}
    >
      {OPTIONS.map((option, index) => {
        const isActive = index === activeIndex;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={`${option.label} theme`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => setTheme(option.value)}
            className={cn(
              "relative flex h-8 w-11 items-center justify-center rounded-pill transition-colors duration-100 ease-out outline-none",
              "after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']",
              "focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-0",
              isActive ? "text-ink" : "text-text-tertiary hover:text-text-primary",
            )}
          >
            {isActive && (
              <motion.span
                layoutId="theme-switcher-thumb"
                aria-hidden="true"
                transition={reduceMotion ? { duration: 0 } : { type: "tween", duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="absolute inset-0 rounded-pill bg-surface-sunken"
              />
            )}
            <option.Icon aria-hidden="true" className="relative size-4" strokeWidth={1.5} />
          </button>
        );
      })}
    </div>
  );
}
