import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr/ArrowUpRight";
import { ArrowDownRight } from "@phosphor-icons/react/dist/ssr/ArrowDownRight";
import { format, type Money } from "@/domain/money/money";
import { cn } from "@/lib/utils";

/**
 * DESIGN.md §15: one asymmetric hero metric outweighing smaller secondary
 * metrics — never three equal cards.
 *
 * Sizes come straight from the §4 type scale rather than from Tailwind's
 * nearest step: the hero is the H1 numeric scale (40/48, −0.015em) and the
 * secondary figures are "Numeric — prominent total" (22/28, −0.01em).
 * `text-4xl` was 36px, which is close enough to look like an accident and
 * far enough to break the ratio between the hero and everything under it.
 *
 * The trend carries an arrow as well as a sign and a colour, because §24 is
 * explicit that colour is never the sole indicator — a red number and a
 * green number are the same number to a red-green colourblind reader.
 */
export function StatBlock({
  label,
  value,
  changePercent,
  favourableDirection = "up",
  size = "secondary",
  className,
}: {
  label: string;
  value: Money;
  changePercent?: number | null;
  /**
   * Which way this figure moving is *good news*. Income and profit rising is
   * good, so they use "up"; expenses rising is not, so they use "down".
   *
   * Without this the component coloured purely by arithmetic sign, which
   * produced the exact wrong reading on the dashboard: "Expenses −81% vs.
   * last month" rendered in negative red, telling a business owner that
   * spending far less than last month was bad. In an accounting product the
   * semantic colours mean money-good and money-bad (DESIGN.md §3), not
   * greater-than and less-than.
   */
  favourableDirection?: "up" | "down";
  size?: "hero" | "secondary";
  className?: string;
}) {
  const hasChange = changePercent !== undefined && changePercent !== null;
  const rose = hasChange && changePercent >= 0;
  const favourable = favourableDirection === "up" ? rose : !rose;
  // The arrow always reports the direction of the number; only the colour
  // reports whether that direction is welcome.
  const TrendIcon = rose ? ArrowUpRight : ArrowDownRight;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className="text-[13px] text-text-secondary">{label}</span>
      <span
        className={cn(
          "font-numeric font-medium text-ink",
          size === "hero" ? "text-[40px] leading-[48px] tracking-[-0.015em]" : "text-[22px] leading-[28px] tracking-[-0.01em]",
        )}
      >
        {format(value)}
      </span>
      {hasChange && (
        <span className={cn("flex items-center gap-1 text-[13px]", favourable ? "text-positive" : "text-negative")}>
          <TrendIcon weight="bold" className="size-3 shrink-0" aria-hidden="true" />
          <span className="font-numeric">
            {rose ? "+" : ""}
            {changePercent}%
          </span>
          <span className="text-text-tertiary">vs. last month</span>
        </span>
      )}
    </div>
  );
}
