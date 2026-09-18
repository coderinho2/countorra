/**
 * A small interactive lock mark for the Security nav item (and, at
 * larger scale, the Security page hero). Pure CSS `group-hover` /
 * `group-focus-visible` — no JS pointer tracking needed for a discrete
 * hover state. Default: closed shackle, ink-colored. On hover: the
 * shackle lifts slightly (as if released) and the body tints toward the
 * accent color, then settles back — "security, then control, then
 * trust" as one restrained motion, not a spinning/bouncing cartoon lock.
 * The parent element must carry `className="group"` for this to react;
 * without a hoverable/focusable ancestor it simply renders the static,
 * closed, monochrome mark.
 */
export function LockMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className} aria-hidden="true">
      <path
        d="M4.5 6.3V4.6a2.5 2.5 0 0 1 5 0v1.7"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
        className="origin-[7px_6.3px] text-text-tertiary transition-transform duration-200 ease-[var(--ease-out)] group-hover:-translate-y-[1.5px] group-hover:-rotate-3 group-focus-visible:-translate-y-[1.5px] group-focus-visible:-rotate-3"
      />
      <rect
        x="3"
        y="6.3"
        width="8"
        height="6"
        rx="1.4"
        fill="currentColor"
        className="text-text-tertiary transition-colors duration-200 ease-[var(--ease-out)] group-hover:text-accent group-focus-visible:text-accent"
      />
    </svg>
  );
}
