import { Sparkle } from "@phosphor-icons/react/dist/ssr/Sparkle";
import { Card } from "@/components/ui/card";

/** DESIGN.md §20: AI insights read as analyst notes, not chat bubbles —
 *  flat card, no gradient identity mark, the text carries the weight. */
export function InsightCard({ title, body }: { title: string; body: string | null }) {
  return (
    <Card className="flex flex-row items-start gap-3 p-4">
      <Sparkle size={16} weight="fill" className="mt-0.5 shrink-0 text-ai" />
      <div className="flex flex-col gap-0.5">
        <p className="text-[15px] font-medium text-text-primary">{title}</p>
        {body && <p className="text-[13px] text-text-secondary">{body}</p>}
      </div>
    </Card>
  );
}
