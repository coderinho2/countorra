/**
 * The Countorra mark: three ledger rows of decreasing length
 * resolving into one full-height total bar — itemized activity becoming
 * a single understood figure. Original to this product; not a dollar
 * sign, calculator, sparkle, or generic geometric SaaS glyph. Renders
 * crisply from 16px (nav) up to large hero scale; see
 * interactive-brand-mark.tsx for the pointer-reactive hero version built
 * on this same geometry.
 */
export function BrandMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="3" y="5" width="13" height="2" rx="1" fill="currentColor" />
      <rect x="3" y="11" width="9" height="2" rx="1" fill="currentColor" />
      <rect x="3" y="17" width="5" height="2" rx="1" fill="currentColor" />
      <rect x="19" y="4" width="2" height="16" rx="1" fill="currentColor" />
    </svg>
  );
}
