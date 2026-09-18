/**
 * Prior turns, trimmed to something safe to send to the model.
 *
 * The assistant had no memory at all. `AIService.respond` sent exactly one
 * message — the current one — so every turn was turn one. Conversations were
 * persisted, listed, renamed, reloaded and displayed, and none of that ever
 * reached the model: "what about last month?" had nothing to resolve "what"
 * against. For a product whose whole surface is a chat, that is the first
 * thing any user hits.
 *
 * Trimming lives here, as a pure function, rather than in the service,
 * because the rules are the kind that are easy to get subtly wrong and
 * expensive to debug against a live provider:
 *
 *   - **A budget, not the whole history.** Every prior turn is re-sent on
 *     every request and billed again. Unbounded history means a long-running
 *     conversation silently costs more per message until it hits the context
 *     limit and starts failing.
 *   - **Trim from the oldest.** Recent turns are what pronouns refer to.
 *   - **Roles must alternate, starting with `user` and ending with
 *     `assistant`.** The Anthropic Messages API rejects a sequence that does
 *     not alternate, and the caller appends the current user message to
 *     whatever comes back from here — so history ending on a user turn would
 *     produce two user messages in a row at the seam. Ending on an assistant
 *     reply makes appending always legal, which is a property the caller
 *     should not have to remember. The stored transcript violates all of this
 *     routinely: two user rows in a row when a message is persisted but the
 *     daily limit stops the reply, a leading assistant row once trimming has
 *     cut the user turn before it, a trailing question whose answer failed.
 *   - **Empty content is dropped.** A message row with no text carries no
 *     meaning and the API rejects an empty content block.
 *
 * What this deliberately does NOT do is summarize dropped turns. That would
 * mean a model call to prepare a model call, and a summary is a paraphrase —
 * for a financial assistant, silently substituting a paraphrase of what the
 * user said earlier is a worse failure than forgetting it.
 */

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface HistoryBudget {
  /** Most recent messages to consider. Counts messages, not exchanges, so a
   *  turn is usually two. */
  maxMessages: number;
  /** Rough proxy for tokens. Characters are used rather than a tokenizer
   *  because an approximation that never under-counts is enough here, and a
   *  real tokenizer would be a dependency and a per-request cost for a
   *  guardrail that only needs to be conservative. ~4 chars/token, so 12000
   *  is roughly 3k tokens of history. */
  maxCharacters: number;
}

export const DEFAULT_HISTORY_BUDGET: HistoryBudget = { maxMessages: 12, maxCharacters: 12_000 };

export function budgetHistory(messages: HistoryMessage[], budget: HistoryBudget = DEFAULT_HISTORY_BUDGET): HistoryMessage[] {
  const usable = messages.filter((m) => m.content.trim().length > 0);

  // Newest first while trimming, so both budgets drop the oldest.
  const kept: HistoryMessage[] = [];
  let characters = 0;

  for (let i = usable.length - 1; i >= 0; i--) {
    const message = usable[i];
    if (kept.length >= budget.maxMessages) break;
    if (characters + message.content.length > budget.maxCharacters && kept.length > 0) break;
    kept.push(message);
    characters += message.content.length;
  }

  kept.reverse();

  return dropTrailingUser(dropLeadingAssistant(mergeConsecutive(kept)));
}

/** Consecutive same-role rows are joined rather than dropped: they happen
 *  whenever a user message was persisted but no reply followed (the daily
 *  limit, a provider outage), and losing what the user said would be the
 *  wrong repair. */
function mergeConsecutive(messages: HistoryMessage[]): HistoryMessage[] {
  const merged: HistoryMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      merged[merged.length - 1] = { role: previous.role, content: `${previous.content}\n\n${message.content}` };
      continue;
    }
    merged.push(message);
  }
  return merged;
}

/**
 * History must end on a completed exchange.
 *
 * A trailing user row means that question never got an answer — the daily
 * limit stopped it, or the provider failed. Keeping it would put two user
 * messages side by side once the caller appends the current one.
 *
 * The unanswered question is dropped rather than merged into the current
 * message: merging would present two separate questions as one thing the user
 * is asking now, and for an assistant that answers questions about money,
 * misstating the question is worse than losing a turn of context the user can
 * simply ask again.
 */
function dropTrailingUser(messages: HistoryMessage[]): HistoryMessage[] {
  const lastAssistant = messages.findLastIndex((m) => m.role === "assistant");
  return lastAssistant === -1 ? [] : messages.slice(0, lastAssistant + 1);
}

/** The API requires the first message to be from the user. Trimming can cut a
 *  user turn and leave its reply stranded at the front.
 *
 *  The `-1` case is separate from the `0` case on purpose: a history with no
 *  user message at all is not "already fine", it is unusable, and folding the
 *  two together with `<= 0` sent an assistant-only sequence straight to the
 *  API. */
function dropLeadingAssistant(messages: HistoryMessage[]): HistoryMessage[] {
  const firstUser = messages.findIndex((m) => m.role === "user");
  if (firstUser === -1) return [];
  return firstUser === 0 ? messages : messages.slice(firstUser);
}
