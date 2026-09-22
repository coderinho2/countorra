import { Sparkle } from "@phosphor-icons/react/dist/ssr/Sparkle";
import { cn } from "@/lib/utils";

const EXAMPLES = [
  { title: "Dining is running above pace", body: "About 22% higher than your usual monthly pace, driven by a handful of larger charges." },
  { title: "Three renewals land Thursday", body: "$340 in recurring software charges are due together this week." },
  { title: "A subscription price went up", body: "Your streaming plan rose from $12.99 to $15.99 in October — worth a look." },
  { title: "A new recurring charge appeared", body: "$29/month, first seen last week. Confirm it's expected." },
];

/**
 * Proactive intelligence (product spec). Deliberately hedged language —
 * "surface", "worth a follow-up" — never an absolute claim. Reuses the
 * dashboard's InsightCard visual language (flat card, accent Sparkle
 * mark, no gradient) with static example copy, laid out asymmetrically
 * rather than as equal-width cards.
 */
export function ProactiveBriefing() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {EXAMPLES.map((item, i) => (
        <div
          key={item.title}
          className={cn("flex items-start gap-3 rounded-md border border-border-subtle bg-surface p-4", i === 0 && "sm:col-span-2")}
        >
          <Sparkle size={16} weight="fill" className="mt-0.5 shrink-0 text-ai" />
          <div className="flex flex-col gap-0.5">
            <p className="text-[15px] font-medium text-text-primary">{item.title}</p>
            <p className="text-[13px] text-text-secondary">{item.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
