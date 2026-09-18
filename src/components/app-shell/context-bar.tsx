import { cn } from "@/lib/utils";

/**
 * The instrument strip.
 *
 * This is the single change that reframes the product from "SaaS dashboard"
 * to "financial terminal". Every serious financial instrument — a Bloomberg
 * panel, a trading blotter, an accounting package — states its operating
 * context permanently, because a figure is meaningless without knowing which
 * books, which currency, and as of when. Before this bar, none of that was on
 * screen anywhere: a reader looking at $376,293.35 had no way to tell whether
 * it was USD, whose workspace it belonged to, or how current it was.
 *
 * Set entirely in Geist Mono at the Micro scale (DESIGN.md §4), on the sunken
 * fill with hairlines above and below. Mono is doing semantic work here, not
 * decoration: these are reference values, the same category as an account
 * number or a date, and §4 reserves mono for exactly that.
 *
 * Every field is real. `asOf` is the server's date, `currency` and `entity`
 * come from the organization row. Nothing here is decorative or invented — if
 * a value were unavailable the field would be omitted rather than faked.
 */
export function ContextBar({
  workspace,
  entity,
  currency,
  asOf,
  className,
}: {
  workspace: string;
  entity: string;
  currency: string;
  asOf: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-7 shrink-0 items-center gap-0 overflow-x-auto border-b border-border-subtle bg-surface-sunken/60 px-4 lg:px-6",
        "font-numeric text-[11px] tracking-[0.02em] whitespace-nowrap text-text-tertiary",
        className,
      )}
    >
      <Field label="WORKSPACE" value={workspace} emphasis />
      <Field label="ENTITY" value={entity} />
      <Field label="BASE" value={currency} />
      <Field label="AS OF" value={asOf} />
      {/* A live indicator, but an honest one: it marks that the figures on
          screen were computed for this request, not that a socket is open. */}
      <span className="ml-auto hidden items-center gap-1.5 pl-6 sm:flex">
        <span aria-hidden="true" className="size-1 rounded-full bg-positive" />
        <span className="uppercase">Computed live</span>
      </span>
    </div>
  );
}

function Field({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 border-r border-border-subtle px-3 first:pl-0 last:border-r-0">
      <span className="uppercase opacity-70">{label}</span>
      <span className={cn("uppercase", emphasis ? "text-text-secondary" : "text-text-secondary/90")}>{value}</span>
    </span>
  );
}
