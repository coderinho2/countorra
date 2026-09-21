import type { ReactNode } from "react";
import { Reveal } from "./reveal";
import { IntelligenceMap } from "./intelligence-map";
import { AskAnything } from "./ask-anything";
import { ChapterChange } from "./chapter-change";
import { ChapterActions } from "./chapter-actions";
import { ProactiveBriefing } from "./proactive-briefing";

interface Chapter {
  number: string;
  title: string;
  body: string;
  visual: ReactNode;
  anchor?: string;
}

const CHAPTERS: Chapter[] = [
  {
    number: "01",
    title: "See everything.",
    body: "Income, spending, accounts and your tax year, read as one connected system instead of five separate spreadsheets.",
    visual: <IntelligenceMap />,
  },
  {
    number: "02",
    title: "Ask anything.",
    body: "Real questions, answered from your actual transactions and documents — as financial UI, not a wall of chat text.",
    visual: <AskAnything />,
    anchor: "ask-anything",
  },
  {
    number: "03",
    title: "Understand what changed.",
    body: "When something moves, Countorra shows the comparison and the reason, not just a number.",
    visual: <ChapterChange />,
  },
  {
    number: "04",
    title: "Act.",
    body: "Categorize a transaction, record an expense, or suggest a figure for your taxes. Reads and reports run instantly — anything that changes your records waits for your confirmation first.",
    visual: <ChapterActions />,
  },
  {
    number: "05",
    title: "Stay ahead.",
    body: "Countorra can surface things worth noticing before you go looking for them.",
    visual: <ProactiveBriefing />,
    anchor: "proactive",
  },
];

/**
 * Product story (product spec §9): one evolving narrative, not five
 * marketing cards. A consistent numbered scaffold (mono step number →
 * headline → one line of body → a full-width, distinct visual) repeated
 * deliberately as an editorial device — each visual is a different kind
 * of UI (bento grid, interactive demo, comparison, action list, insight
 * cards), so the repetition reads as a chapter system, not a template.
 */
export function ProductStory() {
  return (
    <div id="story" className="divide-y divide-border-subtle border-y border-border-subtle">
      {CHAPTERS.map((chapter) => (
        <div key={chapter.number} id={chapter.anchor} className="py-14 sm:py-16">
          <Reveal>
            <div className="flex items-baseline gap-3">
              <span className="font-numeric text-[13px] text-text-tertiary">{chapter.number}</span>
              <h3 className="text-xl font-semibold tracking-[-0.005em] text-ink sm:text-2xl">{chapter.title}</h3>
            </div>
            <p className="mt-2 max-w-[60ch] text-[15px] leading-[1.6] text-text-secondary">{chapter.body}</p>
          </Reveal>
          <Reveal delayMs={80} className="mt-8">
            {chapter.visual}
          </Reveal>
        </div>
      ))}
    </div>
  );
}
