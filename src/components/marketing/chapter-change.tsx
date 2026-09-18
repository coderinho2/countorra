import { money, format } from "@/domain/money/money";

/** Chapter 03 visual — "Understand what changed": a category spike shown
 *  as a direct this-month-vs-last-month comparison, not a chat message. */
export function ChapterChange() {
  const thisMonth = money(84200, "USD");
  const lastMonth = money(71200, "USD");
  const max = thisMonth.amountMinor;

  return (
    <div className="rounded-md border border-border-subtle bg-surface p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-[15px] font-semibold text-ink">Dining increased 18% this month</h4>
        <span className="font-numeric text-[13px] text-negative">+{format(money(thisMonth.amountMinor - lastMonth.amountMinor, "USD"))}</span>
      </div>
      <p className="mt-1 text-[13px] text-text-secondary">Driven by four charges over $50, mostly in the last two weeks.</p>

      <div className="mt-5 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-[12px] text-text-tertiary">Nov</span>
          <div className="h-2 flex-1 rounded-pill bg-surface-sunken">
            <div className="h-full rounded-pill bg-negative" style={{ width: `${(thisMonth.amountMinor / max) * 100}%` }} />
          </div>
          <span className="w-20 shrink-0 text-right font-numeric text-[13px] text-text-primary">{format(thisMonth)}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-[12px] text-text-tertiary">Oct</span>
          <div className="h-2 flex-1 rounded-pill bg-surface-sunken">
            <div className="h-full rounded-pill bg-text-tertiary" style={{ width: `${(lastMonth.amountMinor / max) * 100}%` }} />
          </div>
          <span className="w-20 shrink-0 text-right font-numeric text-[13px] text-text-secondary">{format(lastMonth)}</span>
        </div>
      </div>
    </div>
  );
}
