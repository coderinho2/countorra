"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { AiMessageTurn } from "@/components/ai/ai-message-turn";

interface Metric {
  value: string;
  label: string;
  positive?: boolean;
}

interface Row {
  label: string;
  date: string;
  amount: string;
}

interface Example {
  question: string;
  answer: string;
  metrics?: Metric[];
  rows?: Row[];
}

const EXAMPLES: Example[] = [
  {
    question: "How much did I spend on subscriptions this year?",
    answer: "Across 8 merchants, spread over 17 recurring charges.",
    metrics: [
      { value: "$1,284.00", label: "Total this year" },
      { value: "17", label: "Recurring charges" },
      { value: "8", label: "Merchants" },
    ],
    rows: [
      { label: "Cloud hosting", date: "Monthly", amount: "$89.00" },
      { label: "Design tool", date: "Monthly", amount: "$32.00" },
      { label: "Analytics", date: "Monthly", amount: "$24.00" },
    ],
  },
  {
    question: "How much did I spend on dining this month?",
    answer: "Dining is up 8.4% versus last month, mostly from a handful of larger charges in the last two weeks.",
    metrics: [{ value: "$486.20", label: "Dining", positive: false }],
  },
  {
    question: "Can I afford a $1,500 purchase this month?",
    answer: "A $1,500 purchase this week would leave a projected buffer of about $6,140 through the end of the month, based on your upcoming income and bills.",
    metrics: [{ value: "$6,140.00", label: "Projected buffer after purchase", positive: true }],
  },
  {
    question: "What changed in my spending?",
    answer: "Dining rose 18% and software rose $340 from two new subscriptions. Travel spending fell 22%.",
  },
  {
    question: "How much cash will I have in 30 days?",
    answer: "Projected cash in 30 days is around $45,900, assuming recurring income and expenses hold steady.",
    metrics: [{ value: "$45,900.00", label: "Projected balance, Dec 21", positive: true }],
  },
  {
    question: "What's still missing from my taxes?",
    answer: "One figure: federal withholding from your W-2 is suggested but not yet confirmed. Once you confirm it on Tax preparation, the 2026 estimate can be calculated.",
  },
];

/**
 * The central interaction (product spec §8, DESIGN.md §14). A static,
 * presentational recreation of the in-app AI panel — same flush-left
 * turn styling, same ink identity mark, no chat bubbles — with answers
 * that render as real financial UI (a structured result: metrics and
 * supporting rows) where the question resolves to more than a sentence.
 * This previews the interaction pattern; answers here are fixed example
 * copy, not generated — the in-app assistant only ever answers from a
 * signed-in organization's real data.
 */
export function AskAnything() {
  const [active, setActive] = useState(0);
  const current = EXAMPLES[active];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,300px)_1fr] lg:gap-10">
      <div className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0" aria-label="Example questions">
        {EXAMPLES.map((example, i) => (
          <button
            key={example.question}
            type="button"
            aria-pressed={active === i}
            onClick={() => setActive(i)}
            className={cn(
              "shrink-0 rounded-md border px-3 py-2.5 text-left text-[13px] transition-colors duration-100 ease-out lg:shrink",
              active === i
                ? "border-ai/40 bg-ai-subtle text-ai"
                : "border-border-subtle text-text-secondary hover:border-border hover:text-text-primary",
            )}
          >
            {example.question}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-border-subtle bg-surface p-2 sm:p-4">
        <AiMessageTurn role="user" label="You" content={current.question} />
        <AnswerTurn example={current} />
      </div>
    </div>
  );
}

function AnswerTurn({ example }: { example: Example }) {
  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-sm bg-ink text-[11px] font-semibold text-paper">A</span>
        <span className="text-[11px] font-semibold tracking-wide text-ai uppercase">Countorra</span>
      </div>

      {example.metrics && (
        <div className={cn("grid gap-3 rounded-md border border-border-subtle bg-surface-sunken p-4", // On a phone three columns are narrower than the leading figure, so it
        // takes its own row and the two counts share the next.
        example.metrics.length > 1 ? "grid-cols-3 max-sm:grid-cols-2 max-sm:[&>*:first-child]:col-span-2" : "")}>
          {example.metrics.map((m) => (
            <div key={m.label} className="flex flex-col gap-0.5">
              <span
                className={cn(
                  "font-numeric text-xl font-medium",
                  m.positive === undefined ? "text-ink" : m.positive ? "text-positive" : "text-negative",
                )}
              >
                {m.value}
              </span>
              <span className="text-[12px] text-text-secondary">{m.label}</span>
            </div>
          ))}
        </div>
      )}

      <p className="text-[15px] text-text-primary">{formatWithChips(example.answer)}</p>

      {example.rows && (
        <div className="flex flex-col divide-y divide-border-subtle border-y border-border-subtle">
          {example.rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between py-2 text-[13px]">
              <span className="text-text-primary">{row.label}</span>
              <span className="text-text-tertiary">{row.date}</span>
              <span className="font-numeric text-text-primary">{row.amount}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Renders dollar figures inline as Geist Mono, matching DESIGN.md §14's
 *  "the assistant's numbers must look like the app's numbers" rule. */
function formatWithChips(text: string) {
  const parts = text.split(/(\$[\d,]+(?:\.\d+)?%?|\d+%)/g);
  return parts.map((part, i) =>
    /^\$[\d,]+(?:\.\d+)?$|^\d+%$/.test(part) ? (
      <span key={i} className="font-numeric text-text-primary">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}
