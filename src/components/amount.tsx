import { format, type Money } from "@/domain/money/money";
import { amountSign, type SignMode } from "@/domain/money/display";
import { cn } from "@/lib/utils";

/**
 * A monetary figure.
 *
 * Every table, list and panel in the product was formatting money slightly
 * differently — some prefixed a hyphen, some a real minus, some coloured
 * expenses and some didn't, and the `font-numeric` class was applied by hand
 * at each site and occasionally forgotten. In an accounting product that is
 * not a cosmetic inconsistency: a column where one row's minus is a hyphen
 * and the next row's is U+2212 does not line up, and misaligned digits are
 * exactly the signal DESIGN.md §11 calls load-bearing for financial trust.
 *
 * `sign` is separate from `tone` on purpose. A transaction is an expense
 * whether or not we want the row painted red, and DESIGN.md §24 requires
 * the sign to carry the meaning independently of colour anyway.
 */
export function Amount({
  value,
  sign,
  tone = "neutral",
  size = "body",
  className,
}: {
  value: Money;
  /** See `SignMode` — a negative amount is always signed regardless. */
  sign?: SignMode;
  tone?: "neutral" | "ink" | "positive" | "negative" | "muted" | "semantic";
  size?: "small" | "body" | "prominent" | "hero";
  className?: string;
}) {
  // The sign rule lives in src/domain/money/display.ts so it can be tested
  // directly — it is a financial-correctness rule, not a styling detail. See
  // display.test.ts for the regression it guards.
  const prefix = amountSign(value, sign);
  const negative = prefix === "−";
  const positive = prefix === "+";
  // `format` puts its own "-" on a negative amount; strip it so the explicit
  // U+2212 from `amountSign` is the only sign, not "-−$40.00".
  const text = format(value).replace(/^-/, "");

  return (
    <span
      className={cn(
        "font-numeric whitespace-nowrap",
        size === "small" && "text-[13px]",
        size === "body" && "text-[15px]",
        size === "prominent" && "text-[22px] leading-[28px] font-medium tracking-[-0.01em]",
        size === "hero" && "text-[40px] leading-[48px] font-medium tracking-[-0.015em]",
        tone === "ink" && "text-ink",
        tone === "neutral" && "text-text-primary",
        tone === "muted" && "text-text-secondary",
        tone === "positive" && "text-positive",
        tone === "negative" && "text-negative",
        tone === "semantic" && (negative ? "text-negative" : positive ? "text-positive" : "text-text-primary"),
        className,
      )}
    >
      {prefix}
      {text}
    </span>
  );
}
