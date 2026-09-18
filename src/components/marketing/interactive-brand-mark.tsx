"use client";

import { useEffect, useRef } from "react";

const ROW_Y_NORM = [59, 110, 161].map((y) => (y / 220) * 2 - 1);

/** Resolves any CSS color string (hex, var(), etc.) to an [r,g,b] triple
 *  via a throwaway element — the only reliable cross-browser way to
 *  normalize an arbitrary color value, and the only way to read the
 *  theme-correct resolved value of a custom property without hardcoding
 *  light/dark hex pairs in this file. */
function resolveRgb(colorValue: string): [number, number, number] {
  const probe = document.createElement("span");
  probe.style.color = colorValue;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  const match = resolved.match(/[\d.]+/g);
  if (!match || match.length < 3) return [0, 0, 0];
  return [Number(match[0]), Number(match[1]), Number(match[2])];
}

function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/**
 * Hero-scale, pointer-reactive version of BrandMark (same ledger-rows →
 * total-bar geometry, DESIGN.md §22 motion budget). At rest the mark is
 * monochrome ink, matching the static BrandMark used in the header and
 * footer. As the pointer approaches, the row nearest the pointer's
 * vertical position "wakes up" — its fill sweeps from ink toward the
 * accent color, neighboring rows wake more faintly, and the total bar
 * (already accent-colored) becomes visibly larger and more saturated.
 * Leaving the mark sweeps everything back to monochrome. Colors are
 * read from the live `--color-ink` / `--color-accent` custom properties
 * (see resolveRgb above) so the effect is correct in both themes without
 * hardcoding hex values here.
 *
 * Writes directly on pointermove/leave rather than through
 * requestAnimationFrame — an rAF callback only fires while the page is
 * actually painting, so on a backgrounded tab it silently never runs and
 * the interaction looks dead. A direct write plus the CSS `transition`
 * already on each element produces the same smoothed motion without
 * that dependency. `prefers-reduced-motion` visitors get the static
 * mark with no listeners attached at all.
 */
export function InteractiveBrandMark({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(SVGRectElement | null)[]>([]);
  const totalRef = useRef<SVGRectElement>(null);
  const colors = useRef<{ ink: [number, number, number]; accent: [number, number, number] } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    colors.current = {
      ink: resolveRgb(getComputedStyle(container).getPropertyValue("--color-ink") || "var(--color-ink)"),
      accent: resolveRgb(getComputedStyle(container).getPropertyValue("--color-accent") || "var(--color-accent)"),
    };

    const apply = (nx: number, ny: number, active: boolean) => {
      const c = colors.current;
      if (!c) return;
      const spreads = [12, 8, 5];
      rowRefs.current.forEach((row, i) => {
        if (!row) return;
        const distance = Math.abs(ny - ROW_Y_NORM[i]);
        const activation = active ? Math.max(0, 1 - distance * 1.3) : 0;
        row.style.transform = `translateX(${nx * spreads[i]}px)`;
        row.style.fill = mix(c.ink, c.accent, activation);
      });
      if (totalRef.current) {
        const totalActivation = active ? 0.35 : 0;
        totalRef.current.style.transform = `scaleY(${1 + ny * -0.08 + totalActivation * 0.04}) scaleX(${1 - Math.abs(ny) * 0.12 + totalActivation * 0.1})`;
        totalRef.current.style.fill = mix(c.accent, [255, 255, 255], totalActivation * 0.3);
      }
    };

    const onMove = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const nx = Math.max(-1, Math.min(1, ((e.clientX - rect.left) / rect.width - 0.5) * 2));
      const ny = Math.max(-1, Math.min(1, ((e.clientY - rect.top) / rect.height - 0.5) * 2));
      apply(nx, ny, true);
    };

    const onLeave = () => apply(0, 0, false);

    container.addEventListener("pointermove", onMove);
    container.addEventListener("pointerleave", onLeave);
    return () => {
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  const rowStyle = { transition: "transform 380ms var(--ease-out), fill 380ms var(--ease-out)" };

  return (
    <div ref={containerRef} className={className}>
      <svg width="100%" height="100%" viewBox="0 0 220 220" fill="none" role="img" aria-label="Countorra">
        <rect
          ref={(el) => {
            rowRefs.current[0] = el;
          }}
          x="24"
          y="52"
          width="120"
          height="14"
          rx="7"
          fill="var(--color-ink)"
          style={rowStyle}
        />
        <rect
          ref={(el) => {
            rowRefs.current[1] = el;
          }}
          x="24"
          y="103"
          width="84"
          height="14"
          rx="7"
          fill="var(--color-ink)"
          style={rowStyle}
        />
        <rect
          ref={(el) => {
            rowRefs.current[2] = el;
          }}
          x="24"
          y="154"
          width="48"
          height="14"
          rx="7"
          fill="var(--color-ink)"
          style={rowStyle}
        />
        <rect
          ref={totalRef}
          x="176"
          y="34"
          width="16"
          height="152"
          rx="8"
          fill="var(--color-accent)"
          style={{ transition: "transform 380ms var(--ease-out), fill 380ms var(--ease-out)", transformOrigin: "184px 110px" }}
        />
      </svg>
    </div>
  );
}
