import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared marketing section heading: H2 + one line of supporting copy, capped
 * at DESIGN.md §4's 70ch measure.
 *
 * `index` adds a numbered rule above the heading. That number is what turns a
 * scroll through the homepage into a narrative with a spine — "01 Understand,
 * 02 See where it goes, 03 Know what comes next" reads as an argument, where
 * the same four sections unnumbered read as four unrelated marketing blocks.
 * It is the same device the authenticated screens use for their sections, in
 * the same mono voice, which is what keeps the site and the product feeling
 * like one thing.
 */
export function SectionHeader({
  index,
  title,
  children,
  align = "left",
  serif = true,
  className,
}: {
  index?: number;
  title: string;
  /**
   * Sets the heading in the editorial Display serif (DESIGN.md §4).
   *
   * Defaults on: every consumer of this component is a marketing page, and
   * §4 scopes the serif to marketing headings. Pass `serif={false}` for a
   * marketing surface that wants the sans Display alternate instead.
   */
  serif?: boolean;
  children?: ReactNode;
  align?: "left" | "center";
  className?: string;
}) {
  return (
    <div className={cn("max-w-[62ch]", align === "center" && "mx-auto text-center", className)}>
      {index !== undefined && (
        <p
          aria-hidden="true"
          className={cn(
            "font-numeric text-text-tertiary mb-5 flex items-center gap-3 text-[10px] tracking-[0.14em] uppercase",
            align === "center" && "justify-center",
          )}
        >
          <span className="tabular-nums">{String(index).padStart(2, "0")}</span>
          <span className="bg-border h-px w-8" />
        </p>
      )}
      <h2
        className={cn(
          "text-ink",
          serif
            ? "font-serif text-[30px] leading-[38px] font-normal tracking-[0] sm:text-[38px] sm:leading-[46px]"
            : "text-2xl font-semibold tracking-[-0.01em] sm:text-[28px]",
        )}
      >
        {title}
      </h2>
      {children && <p className="text-text-secondary mt-3 text-[15px] leading-[1.6]">{children}</p>}
    </div>
  );
}
