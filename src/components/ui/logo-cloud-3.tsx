import { InfiniteSlider } from "@/components/ui/infinite-slider";
import { cn } from "@/lib/utils";

/**
 * A quiet, monochrome strip of technology wordmarks.
 *
 * ADAPTED. The reference rendered each logo as an `<img>` from a third-party
 * CDN and reached for `dark:brightness-0 dark:invert` to force it monochrome.
 * Neither survives here:
 *
 *   - Assets are local (`public/logos/*.svg`), not hotlinked.
 *   - Each mark is painted as a CSS **mask** filled with the current text
 *     colour. An SVG loaded through `<img>` cannot inherit `currentColor`, so
 *     the invert trick is the only way to theme it — and it breaks on any
 *     mark that is not pure black. A mask is the colour, in both themes, with
 *     no filter stack.
 *   - `aspect` comes from each file's own viewBox, so a wordmark keeps its
 *     proportions at a shared height instead of being stretched.
 *   - A mark with no usable asset renders as its name in the product's own
 *     typeface (`wordmark`), rather than a broken image.
 */

export type Logo = {
  /** Local path, e.g. `/logos/stripe.svg`. Omit to render `wordmark`. */
  src?: string;
  /** The company's name. Used as the accessible label, and as the visible
   *  text when there is no `src`. */
  alt: string;
  /** width ÷ height of the asset's viewBox. Required with `src`. */
  aspect?: number;
  /** Optical balance. Wordmarks are drawn to different proportions, so a
   *  single shared height makes some shout and others vanish: Anthropic's is
   *  set wide and heavy, the AWS smile is nearly square. A multiplier per
   *  mark is what makes the row read as one line of type. */
  scale?: number;
  /** Set when no official monochrome asset is available. */
  wordmark?: boolean;
};

type LogoCloudProps = React.ComponentProps<"div"> & {
  logos: Logo[];
  /** Height of each mark in pixels; widths follow from `aspect`. */
  height?: number;
};

export function LogoCloud({ className, logos, height = 18, ...props }: LogoCloudProps) {
  return (
    <div
      {...props}
      className={cn(
        // The mask fades both ends into the page, so marks enter and leave
        // rather than appearing at a hard edge.
        "overflow-hidden py-4 [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]",
        className,
      )}
    >
      <InfiniteSlider gap={56} reverse duration={48} durationOnHover={140}>
        {logos.map((logo) =>
          logo.src ? (
            <span
              key={logo.alt}
              role="img"
              aria-label={logo.alt}
              title={logo.alt}
              className="text-text-secondary hover:text-text-primary block shrink-0 select-none transition-colors duration-200 ease-out"
              style={{
                height: height * (logo.scale ?? 1),
                width: height * (logo.scale ?? 1) * (logo.aspect ?? 4),
                backgroundColor: "currentColor",
                maskImage: `url(${logo.src})`,
                WebkitMaskImage: `url(${logo.src})`,
                maskRepeat: "no-repeat",
                WebkitMaskRepeat: "no-repeat",
                maskPosition: "center",
                WebkitMaskPosition: "center",
                maskSize: "contain",
                WebkitMaskSize: "contain",
              }}
            />
          ) : (
            <span
              key={logo.alt}
              className="text-text-secondary hover:text-text-primary flex shrink-0 items-center font-semibold tracking-[-0.01em] whitespace-nowrap transition-colors duration-200 ease-out"
              style={{ height: height * (logo.scale ?? 1), fontSize: height * (logo.scale ?? 1) * 0.95 }}
            >
              {logo.alt}
            </span>
          ),
        )}
      </InfiniteSlider>
    </div>
  );
}
