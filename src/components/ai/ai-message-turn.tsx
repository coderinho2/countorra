import { cn } from "@/lib/utils";

/**
 * DESIGN.md §14: no chat bubbles. Flush-left text blocks with a Micro-label,
 * separated by hairlines, styled like the rest of the app rather than like a
 * chat widget bolted onto it.
 *
 * The two roles are now typographically distinct instead of identical blocks
 * with different labels. A question is a heading — it is short, it is the
 * thing you scroll back to find, and it introduces everything under it — so
 * it is set at the H3 scale in ink with no identity mark. The answer is body
 * copy under it, measured to 70ch per §4 so a long explanation does not run
 * the full width of a desktop window.
 *
 * The assistant's mark is §14's specified 24px ink square with a single
 * letter: no gradient orb, no illustrated avatar, nothing that reads as a
 * character rather than as an instrument.
 */
export function AiMessageTurn({ role, content, label }: { role: "user" | "assistant"; content: string; label: string }) {
  if (role === "user") {
    return (
      <div className="flex flex-col gap-1 pt-8 pb-3 first:pt-0">
        <span className="text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">{label}</span>
        <p className="text-[20px] leading-7 font-semibold tracking-[-0.005em] text-ink">{content}</p>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2 pb-4")}>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-sm bg-ink text-[11px] font-semibold text-paper">
          A
        </span>
        <span className="text-[11px] font-semibold tracking-[0.02em] text-ai uppercase">{label}</span>
      </div>
      <p className="max-w-[70ch] text-[15px] leading-[24px] whitespace-pre-wrap text-text-primary">{content}</p>
    </div>
  );
}
