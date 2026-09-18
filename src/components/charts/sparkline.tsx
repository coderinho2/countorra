import { cn } from "@/lib/utils";

/**
 * DESIGN.md §12: 1px stroke, no fill, no axes, sized to text line-height,
 * coloured by direction only when direction is the point.
 *
 * The spec asks for this beside the dashboard hero metric and nothing
 * implemented it. It matters more than its size suggests — a single figure
 * answers "how much do I have"; the same figure with twelve months of shape
 * behind it also answers "and is that normal", which is the question a
 * business owner actually opens the app with.
 *
 * `preserveAspectRatio="none"` is deliberate: the line is read for its shape
 * over time, not for its true angles, so letting it fill the box beats
 * letter-boxing a tiny centred graph.
 */
export function Sparkline({
  values,
  className,
  tone = "auto",
  width = 96,
  height = 24,
  ariaLabel,
}: {
  values: number[];
  className?: string;
  /** "auto" colours by the first-to-last direction; "neutral" never does. */
  tone?: "auto" | "neutral";
  width?: number;
  height?: number;
  ariaLabel?: string;
}) {
  // Two points is the minimum that can describe a direction; anything less
  // is a dot pretending to be a trend, so render nothing at all.
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  // 1px of padding top and bottom keeps the stroke from being clipped at the
  // extremes, where the interesting values always are.
  const points = values.map((value, index) => `${index * step},${height - 1 - ((value - min) / span) * (height - 2)}`).join(" ");

  const rising = values[values.length - 1] >= values[0];
  const stroke = tone === "neutral" ? "var(--color-text-tertiary)" : rising ? "var(--color-positive)" : "var(--color-negative)";

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      className={cn("overflow-visible", className)}
      role={ariaLabel ? "img" : "presentation"}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
