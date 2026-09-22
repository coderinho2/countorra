import Link from "next/link";
import { Warning } from "@phosphor-icons/react/dist/ssr/Warning";
import { Sparkle } from "@phosphor-icons/react/dist/ssr/Sparkle";
import { Info } from "@phosphor-icons/react/dist/ssr/Info";
import { CaretRight } from "@phosphor-icons/react/dist/ssr/CaretRight";
import { cn } from "@/lib/utils";

/**
 * One thing that wants the user's attention.
 *
 * The dashboard previously showed AI insights as a grid of cards and overdue
 * invoices as a separate widget in a different column, which meant the two
 * most urgent kinds of information on the screen were competing rather than
 * ranked. They are the same question — what should I deal with — so they are
 * now one ruled list, ordered by consequence, with the financial figure on
 * the right where every other figure in the product sits.
 *
 * Rows are ruled, not boxed. Six bordered cards read as six widgets; six
 * ruled rows read as a list of six things, which is what this is.
 *
 * Severity is carried by an icon *and* a word, never by colour alone
 * (DESIGN.md §24), and the icon is line-weight monochrome per §20 — there is
 * no red-filled alert badge here, because DESIGN.md §18 is explicit that
 * warnings in this product stay calm.
 */
export type AttentionSeverity = "urgent" | "insight" | "info";

const SEVERITY = {
  urgent: { Icon: Warning, className: "text-negative" },
  insight: { Icon: Sparkle, className: "text-ai" },
  info: { Icon: Info, className: "text-text-tertiary" },
} as const;

export function AttentionRow({
  severity,
  title,
  description,
  value,
  meta,
  href,
}: {
  severity: AttentionSeverity;
  title: string;
  description?: string | null;
  /** The financial figure, if this item has one. */
  value?: React.ReactNode;
  /** A short qualifier under the figure — "18 days overdue", "vs. last month". */
  meta?: string;
  href?: string;
}) {
  const { Icon, className } = SEVERITY[severity];

  const body = (
    <>
      <Icon size={16} weight={severity === "insight" ? "fill" : "regular"} className={cn("mt-0.5 shrink-0", className)} aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-medium text-text-primary">{title}</span>
        {description && <span className="text-[13px] text-text-secondary">{description}</span>}
      </span>
      {(value || meta) && (
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          {value}
          {meta && <span className="text-[12px] text-text-tertiary">{meta}</span>}
        </span>
      )}
      {href && (
        <CaretRight
          size={14}
          aria-hidden="true"
          className="mt-1 shrink-0 text-text-tertiary transition-transform duration-[var(--duration-fast)] ease-out group-hover:translate-x-0.5"
        />
      )}
    </>
  );

  return (
    <li className="border-b border-border-subtle last:border-0">
      {href ? (
        <Link
          href={href}
          className={cn(
            "group -mx-2 flex items-start gap-3 rounded-sm px-2 py-3 transition-colors duration-[var(--duration-fast)] ease-out",
            "hover:bg-surface-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
          )}
        >
          {body}
        </Link>
      ) : (
        <div className="flex items-start gap-3 py-3">{body}</div>
      )}
    </li>
  );
}
