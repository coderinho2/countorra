"use client";

import * as React from "react";
import { useRef, useState, useTransition } from "react";
import { ArrowUp } from "@phosphor-icons/react/dist/ssr/ArrowUp";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import { AiMessageTurn } from "./ai-message-turn";
import { AiActionConfirmation } from "./ai-action-confirmation";
import { AiResultPanel } from "./ai-result-panel";
import { AiUpgradePrompt } from "./ai-upgrade-prompt";
import { sendAiMessage, type PendingActionSummary, type ToolResultSummary } from "@/server/ai/actions";
import type { PlanTier } from "@/types/database";

export interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  pendingActions?: PendingActionSummary[];
  results?: ToolResultSummary[];
  sources?: string | null;
  limitReached?: boolean;
  plan?: PlanTier;
}

/**
 * Product spec §3 — real examples, not generic filler. Personal only: Countorra
 * launches for personal finances and personal taxes
 * (src/domain/organizations/launch-scope.ts); the freelancer and business
 * sets are gone with those entity types.
 * Selecting one runs it against the real system exactly like typing it.
 *
 * Grouped, because five ungrouped example questions read as filler while the
 * same five under "Position", "Money owed" and "Patterns" read as a map of
 * what the assistant is actually able to answer.
 */
export const SUGGESTED_QUESTIONS: { group: string; questions: string[] }[] = [
  { group: "Position", questions: ["How much did I spend this month?", "Can I afford a $2,000 purchase?", "What's my net worth?"] },
  { group: "Patterns", questions: ["What were my biggest expenses?", "Why did my spending increase?", "Show me my subscriptions."] },
  { group: "Taxes", questions: ["What's still missing from my tax preparation?"] },
];

/**
 * The transcript and the composer.
 *
 * DESIGN.md §14 composer: matches the standard Textarea spec exactly — no
 * pill shape, no floating circular FAB, no shadow. The whole composer sits in
 * a bar with a hairline top rule and the surface fill, so it reads as part of
 * the application frame rather than as a widget hovering over the page.
 *
 * Two structural changes from the Phase 2 pass:
 *
 * - The empty state is a two-column brief instead of a centred stack of five
 *   buttons: what you can ask on the left, what the assistant can see on the
 *   right. A blank chat page with example prompts is the single most
 *   recognisable "generic AI product" shape there is, and §38 rules it out.
 * - The transcript is measured. Prose runs to 70ch (§4) inside a wider
 *   column, so a table of results can be full width while an explanation
 *   never becomes a 1,200px line of text.
 */
export function AiChatPanel({
  organizationId,
  initialConversationId,
  initialMessages,
  onConversationCreated,
  grounding,
}: {
  organizationId: string;
  initialConversationId: string | null;
  initialMessages: Turn[];
  onConversationCreated: (id: string, title: string) => void;
  /** What the assistant can see. Real counts, read on the server. */
  grounding?: { transactions: number; documents: number; accounts: number; through: string };
}) {
  const [turns, setTurns] = useState<Turn[]>(initialMessages);
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();
  const listRef = useRef<HTMLDivElement>(null);

  const send = (message: string) => {
    if (!message.trim()) return;
    const isFirstMessage = conversationId === null;
    const userTurn: Turn = { id: crypto.randomUUID(), role: "user", content: message };
    setTurns((prev) => [...prev, userTurn]);
    setInput("");

    startTransition(async () => {
      const result = await sendAiMessage({ organizationId, conversationId, message });
      setConversationId(result.conversationId);
      if (isFirstMessage && result.conversationId) {
        onConversationCreated(result.conversationId, message.slice(0, 80));
      }
      setTurns((prev) => [
        ...prev,
        result.limitReached
          ? { id: crypto.randomUUID(), role: "assistant", content: "", limitReached: true, plan: result.plan }
          : {
              id: crypto.randomUUID(),
              role: "assistant",
              content: result.error ? `I couldn't complete that: ${result.error}` : result.content || "Done.",
              pendingActions: result.pendingActions,
              results: result.results,
              sources: result.sources,
            },
      ]);
      requestAnimationFrame(() => {
        const list = listRef.current;
        if (!list) return;
        // Smooth scrolling is motion, and someone who has asked for less of
        // it should not be dragged down a long transcript.
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        list.scrollTo({ top: list.scrollHeight, behavior: reduced ? "auto" : "smooth" });
      });
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {grounding && (
        <div className="border-border-subtle bg-surface-sunken/60 font-numeric text-text-tertiary flex h-7 shrink-0 items-center gap-0 overflow-x-auto border-b px-4 text-[11px] tracking-[0.02em] whitespace-nowrap lg:px-8">
          <span className="border-border-subtle flex items-center gap-1.5 border-r px-3 pl-0">
            <span className="uppercase opacity-70">Scope</span>
            <span className="text-text-secondary uppercase">This workspace</span>
          </span>
          <span className="border-border-subtle flex items-center gap-1.5 border-r px-3">
            <span className="uppercase opacity-70">Txn</span>
            <span className="text-text-secondary">{grounding.transactions.toLocaleString("en-US")}</span>
          </span>
          <span className="border-border-subtle flex items-center gap-1.5 border-r px-3">
            <span className="uppercase opacity-70">Docs</span>
            <span className="text-text-secondary">{grounding.documents.toLocaleString("en-US")}</span>
          </span>
          <span className="border-border-subtle flex items-center gap-1.5 border-r px-3">
            <span className="uppercase opacity-70">Acct</span>
            <span className="text-text-secondary">{grounding.accounts}</span>
          </span>
          <span className="flex items-center gap-1.5 px-3">
            <span className="uppercase opacity-70">Through</span>
            <span className="text-text-secondary">{grounding.through}</span>
          </span>
        </div>
      )}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 lg:px-8">
        {turns.length === 0 ? (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 py-10">
            <div className="section-enter flex flex-col gap-3" style={{ "--enter-index": 0 } as React.CSSProperties}>
              <p className="font-numeric text-ai text-[11px] tracking-[0.14em] uppercase">Intelligence console</p>
              <h1 className="text-ink text-[32px] leading-10 font-semibold tracking-[-0.015em] sm:text-[40px] sm:leading-[48px]">Ask your money</h1>
              <p className="text-text-secondary max-w-[60ch] text-[15px]">
                Every answer is computed from the transactions, accounts and documents in this workspace. Nothing is estimated, and nothing is invented.
              </p>
            </div>

            <div className="grid gap-8 sm:grid-cols-[1fr_auto] sm:gap-12">
              <div className="section-enter flex flex-col gap-6" style={{ "--enter-index": 1 } as React.CSSProperties}>
                {SUGGESTED_QUESTIONS.map((section, groupIndex) => (
                  <div key={section.group} className="flex flex-col gap-2">
                    <p className="font-numeric text-text-tertiary mb-1 flex items-center gap-2 border-b border-border pb-2 text-[10px] tracking-[0.14em] uppercase">
                      <span className="tabular-nums">{String(groupIndex + 1).padStart(2, "0")}</span>
                      {section.group}
                    </p>
                    <ul className="flex flex-col">
                      {section.questions.map((question) => (
                        <li key={question} className="border-b border-border-subtle last:border-0">
                          <button
                            type="button"
                            onClick={() => send(question)}
                            className={cn(
                              "group flex w-full items-center justify-between gap-3 py-2.5 text-left text-[15px] text-text-primary",
                              "transition-colors duration-[var(--duration-fast)] ease-out hover:text-ai",
                              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                            )}
                          >
                            {question}
                            <ArrowUp
                              size={13}
                              aria-hidden="true"
                              className="shrink-0 rotate-45 text-text-tertiary transition-transform duration-[var(--duration-fast)] ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              {/* The counts moved to the permanent console strip above, so
                  this column explains what the assistant may and may not do
                  rather than repeating them. */}
              <aside
                className="section-enter border-border-subtle bg-surface flex flex-col gap-3 self-start rounded-md border p-4 sm:w-56"
                style={{ "--enter-index": 2 } as React.CSSProperties}
              >
                <p className="font-numeric text-text-tertiary text-[10px] tracking-[0.14em] uppercase">How it answers</p>
                <ul className="text-text-secondary flex flex-col gap-2.5 text-[13px]">
                  <li className="flex gap-2">
                    <span aria-hidden="true" className="bg-positive mt-1.5 size-1 shrink-0 rounded-full" />
                    Figures come from the same calculation engine the reports use.
                  </li>
                  <li className="flex gap-2">
                    <span aria-hidden="true" className="bg-positive mt-1.5 size-1 shrink-0 rounded-full" />
                    Reads run immediately.
                  </li>
                  <li className="flex gap-2">
                    <span aria-hidden="true" className="bg-warning mt-1.5 size-1 shrink-0 rounded-full" />
                    Anything that writes waits for your confirmation.
                  </li>
                </ul>
              </aside>
            </div>
          </div>
        ) : (
          // A reply that only exists visually is a reply a screen-reader user
          // never receives. `polite` announces it after the current utterance
          // rather than interrupting; `aria-atomic="false"` means only the new
          // turn is read, not the whole transcript again.
          <div className="mx-auto max-w-3xl pb-4" aria-live="polite" aria-atomic="false" aria-busy={pending}>
            {turns.map((turn) =>
              turn.limitReached && turn.plan ? (
                <div key={turn.id} className="section-enter">
                  <AiUpgradePrompt plan={turn.plan} />
                </div>
              ) : (
                <div key={turn.id}>
                  {/* An answer is structured, so it arrives structured: the
                      answer itself, then the figures it rests on, then where
                      they came from, then anything awaiting a decision. Each
                      part is one `--stagger-step` behind the last, so the
                      whole cascade completes in well under 200ms — the order
                      is perceptible, the wait is not. This is the reading
                      order too, which is the point: the eye lands on the
                      answer before the evidence. */}
                  <div className="section-enter" style={{ "--enter-index": 0 } as React.CSSProperties}>
                    <AiMessageTurn role={turn.role} content={turn.content} label={turn.role === "assistant" ? "Countorra" : "You"} />
                  </div>
                  {turn.results && turn.results.length > 0 && (
                    <div className="section-enter" style={{ "--enter-index": 1 } as React.CSSProperties}>
                      <AiResultPanel results={turn.results} />
                    </div>
                  )}
                  {turn.sources && (
                    <p
                      className="section-enter mb-4 flex max-w-[70ch] items-baseline gap-2 text-[12px] text-text-tertiary"
                      style={{ "--enter-index": 2 } as React.CSSProperties}
                    >
                      <span className="text-[11px] font-semibold tracking-[0.02em] uppercase">Source</span>
                      {turn.sources}
                    </p>
                  )}
                  {turn.pendingActions?.map((action) => (
                    <div key={action.id} className="section-enter mb-4" style={{ "--enter-index": 3 } as React.CSSProperties}>
                      <AiActionConfirmation actionId={action.id} toolName={action.toolName} operationMode={action.operationMode} input={action.input} />
                    </div>
                  ))}
                </div>
              ),
            )}
            {pending && (
              <div className="flex items-center gap-2 py-4">
                <span aria-hidden="true" className="ai-thinking-dot size-1 rounded-full bg-ai" />
                <span className="text-[13px] text-text-tertiary">Working through your books…</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Composer bar — application chrome, on `surface`, with a hairline top
          rule. It is anchored, not floating: DESIGN.md §14 explicitly rejects
          the floating pill input that every chat product uses. */}
      <div className="shrink-0 border-t border-border-subtle bg-surface px-4 py-3 lg:px-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              aria-label="Ask a question about your finances"
              placeholder="Ask about your finances…"
              className="max-h-40 min-h-10 flex-1 resize-none py-2"
              rows={1}
            />
            <button
              type="button"
              disabled={pending || !input.trim()}
              onClick={() => send(input)}
              aria-label="Send"
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-sm bg-gold text-accent-contrast",
                "transition-[background-color,transform,opacity] duration-[var(--duration-fast)] ease-out",
                "hover:bg-gold-hover active:scale-[0.97]",
                "disabled:bg-surface-sunken disabled:text-text-tertiary disabled:active:scale-100",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              )}
            >
              <ArrowUp size={16} weight="bold" />
            </button>
          </div>
          <p className="text-[11px] text-text-tertiary">
            Enter to send · Shift + Enter for a new line · Anything that changes your records is confirmed by you first
          </p>
        </div>
      </div>
    </div>
  );
}
