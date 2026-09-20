"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * A row that scrolls its children forever, seamlessly.
 *
 * ADAPTED. Three changes from the reference implementation:
 *
 *   - `react-use-measure` is not a dependency. The one thing it was used for
 *     — the content's width — is a `ResizeObserver` below, which is what that
 *     package wraps. A financial application does not need another package in
 *     its tree to read one number.
 *   - `motion/react` instead of `framer-motion`: this project already ships
 *     `motion`, which is the same library under its current name.
 *   - `prefers-reduced-motion` stops the loop entirely and leaves the row
 *     static and readable. DESIGN.md §22 requires that, and an endlessly
 *     moving strip is exactly what the setting exists to switch off.
 *
 * The seam: the children are rendered twice and the track is translated by
 * half its width, so the second copy is in position the instant the first
 * scrolls out. Width is measured rather than assumed, so the loop stays
 * seamless at any viewport.
 */

export function InfiniteSlider({
  children,
  gap = 16,
  duration = 25,
  durationOnHover,
  direction = "horizontal",
  reverse = false,
  className,
}: {
  children: React.ReactNode;
  gap?: number;
  duration?: number;
  durationOnHover?: number;
  direction?: "horizontal" | "vertical";
  reverse?: boolean;
  className?: string;
}) {
  const [currentDuration, setCurrentDuration] = useState(duration);
  const [size, setSize] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [key, setKey] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const translation = useMotionValue(0);
  /* The server cannot know `prefers-reduced-motion`, so switching markup on it
     during the first render makes the client disagree with the server's HTML
     and React throws the subtree away. Both sides render the animated markup;
     the static one takes over after hydration. */
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const prefersReducedMotion = useReducedMotion();
  const reduceMotion = mounted && prefersReducedMotion;

  // What `useMeasure` did, in the platform's own API.
  useEffect(() => {
    const element = trackRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setSize(direction === "horizontal" ? box.width : box.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [direction]);

  useEffect(() => {
    if (reduceMotion || size === 0) return;

    const contentSize = size + gap;
    const from = reverse ? -contentSize / 2 : 0;
    const to = reverse ? 0 : -contentSize / 2;

    const controls = isTransitioning
      ? animate(translation, [translation.get(), to], {
          ease: "linear",
          duration: currentDuration * Math.abs((translation.get() - to) / contentSize),
          onComplete: () => {
            setIsTransitioning(false);
            setKey((previous) => previous + 1);
          },
        })
      : animate(translation, [from, to], {
          ease: "linear",
          duration: currentDuration,
          repeat: Infinity,
          repeatType: "loop",
          repeatDelay: 0,
          onRepeat: () => translation.set(from),
        });

    return controls?.stop;
  }, [key, translation, currentDuration, size, gap, isTransitioning, direction, reverse, reduceMotion]);

  const hoverProps =
    durationOnHover && !reduceMotion
      ? {
          onHoverStart: () => {
            setIsTransitioning(true);
            setCurrentDuration(durationOnHover);
          },
          onHoverEnd: () => {
            setIsTransitioning(true);
            setCurrentDuration(duration);
          },
        }
      : {};

  return (
    <div className={cn("overflow-hidden", className)}>
      <motion.div
        ref={trackRef}
        className={cn("flex w-max", reduceMotion && "flex-wrap justify-center")}
        style={{
          ...(reduceMotion ? {} : direction === "horizontal" ? { x: translation } : { y: translation }),
          gap: `${gap}px`,
          flexDirection: direction === "horizontal" ? "row" : "column",
        }}
        {...hoverProps}
      >
        {children}
        {/* The second copy is what makes the loop seamless. It is hidden from
            assistive technology so the list is not announced twice. */}
        <div aria-hidden="true" className="flex shrink-0 items-center" style={{ gap: `${gap}px` }}>
          {reduceMotion ? null : children}
        </div>
      </motion.div>
    </div>
  );
}
