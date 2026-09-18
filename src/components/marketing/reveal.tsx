"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Marketing-only entrance animation (DESIGN.md §22: "Page content entrance
 * — 240ms ease-out, 8px rise + fade, once per view"). Not used anywhere
 * in-app — dashboards get no entrance choreography, per §22's own scope.
 *
 * Ships visible by default so a failed/slow hydration or a crawler never
 * leaves content stuck at opacity 0. Reveal is checked on a throttled
 * scroll/resize listener rather than IntersectionObserver alone: an
 * instant scroll (anchor-link jump, "End" key, a fast trackpad flick)
 * can move an element from fully-below to fully-above the viewport
 * between two rendered frames, with no frame in between where it was
 * ever actually "intersecting" — IntersectionObserver never fires for
 * that element and it would stay invisible forever. Checking the
 * bounding rect directly on every scroll/resize (plus once on mount)
 * has no such gap. `prefers-reduced-motion` is handled globally in
 * globals.css (transition durations collapse to ~0).
 */
export function Reveal({
  children,
  className,
  delayMs = 0,
  as: Tag = "div",
  id,
}: {
  children: ReactNode;
  className?: string;
  delayMs?: number;
  as?: "div" | "li";
  id?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    setArmed(true);
    let done = false;
    let raf = 0;

    const reveal = () => {
      if (done) return;
      done = true;
      setVisible(true);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };

    const checkNow = () => {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.92) reveal();
    };

    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(checkNow);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    checkNow();

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <Tag
      ref={ref as never}
      id={id}
      className={cn(
        "transition-[opacity,transform] duration-[240ms] ease-[var(--ease-out)]",
        armed && !visible ? "translate-y-2 opacity-0" : "translate-y-0 opacity-100",
        className,
      )}
      style={delayMs ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}
