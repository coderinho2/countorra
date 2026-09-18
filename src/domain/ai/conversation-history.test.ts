import { describe, expect, it } from "vitest";
import { budgetHistory, DEFAULT_HISTORY_BUDGET, type HistoryMessage } from "./conversation-history";

const user = (content: string): HistoryMessage => ({ role: "user", content });
const assistant = (content: string): HistoryMessage => ({ role: "assistant", content });

describe("budgetHistory", () => {
  it("returns nothing for an empty conversation", () => {
    expect(budgetHistory([])).toEqual([]);
  });

  it("keeps a completed conversation intact and in order", () => {
    const history = [user("what did I spend?"), assistant("$400."), user("and last month?"), assistant("$380.")];
    expect(budgetHistory(history)).toEqual(history);
  });

  it("keeps the most recent messages when over the message budget", () => {
    const history = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? user(`q${i}`) : assistant(`a${i}`)));
    const result = budgetHistory(history, { maxMessages: 6, maxCharacters: 100_000 });

    expect(result).toHaveLength(6);
    expect(result[result.length - 1].content).toBe("a29");
  });

  it("drops the oldest, never the newest, when over the character budget", () => {
    const history = [user("x".repeat(5_000)), assistant("y".repeat(5_000)), user("recent q"), assistant("recent a")];
    const result = budgetHistory(history, { maxMessages: 50, maxCharacters: 6_000 });

    expect(result[result.length - 1].content).toBe("recent a");
    expect(result.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(6_000);
  });

  it("gives up the history entirely rather than emitting an illegal sequence", () => {
    // One enormous assistant message can survive the budget on its own while
    // the question that prompted it does not. The result would be an
    // assistant-only history, which the API rejects — so the honest outcome
    // is no history at all. The current message is still sent, so the turn
    // works; only the context is lost.
    const result = budgetHistory([user("q"), assistant("z".repeat(50_000))], { maxMessages: 10, maxCharacters: 100 });
    expect(result).toEqual([]);
  });

  it("keeps a large exchange when the budget can hold both halves", () => {
    const result = budgetHistory([user("q".repeat(40)), assistant("a".repeat(40))], { maxMessages: 10, maxCharacters: 100 });
    expect(result).toHaveLength(2);
    expect(result[result.length - 1].role).toBe("assistant");
  });

  /**
   * The caller appends the current user message to whatever comes back, so
   * history ending on a user turn would create two user messages in a row at
   * the seam — which the API rejects. This invariant is what makes appending
   * safe without the caller having to think about it.
   */
  it("always ends on an assistant reply, so appending the current message is legal", () => {
    const cases: HistoryMessage[][] = [
      [user("q"), assistant("a"), user("unanswered")],
      [user("q"), assistant("a"), user("one"), user("two")],
      [user("only a question")],
      [assistant("stranded"), user("unanswered")],
    ];

    for (const history of cases) {
      const result = budgetHistory(history);
      if (result.length > 0) expect(result[result.length - 1].role).toBe("assistant");
    }
  });

  it("drops a trailing unanswered question rather than merging it into the next one", () => {
    const result = budgetHistory([user("what did I spend?"), assistant("$400."), user("this one got no reply")]);

    expect(result).toEqual([user("what did I spend?"), assistant("$400.")]);
    expect(JSON.stringify(result)).not.toContain("no reply");
  });

  it("returns nothing when no exchange ever completed", () => {
    expect(budgetHistory([user("q1"), user("q2")])).toEqual([]);
  });

  it("produces a sequence that stays legal once the current message is appended", () => {
    const messy = [assistant("stranded"), user("a"), user("b"), assistant("c"), assistant("d"), user("e"), assistant("f")];
    const withCurrent = [...budgetHistory(messy), user("the new question")];

    expect(withCurrent[0].role).toBe("user");
    for (let i = 1; i < withCurrent.length; i++) {
      expect(withCurrent[i].role).not.toBe(withCurrent[i - 1].role);
    }
  });

  it("drops empty and whitespace-only messages", () => {
    const result = budgetHistory([user("real"), assistant(""), assistant("   "), user("also real"), assistant("reply")]);

    expect(result.map((m) => m.content)).toEqual(["real\n\nalso real", "reply"]);
  });

  it("merges the user turns that dropping an empty reply left adjacent", () => {
    // An empty assistant row is what a failed or limit-blocked turn leaves
    // behind. Removing it must not then produce an illegal user/user pair.
    const result = budgetHistory([user("first question"), assistant(""), user("second question"), assistant("an answer")]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "first question\n\nsecond question" });
  });

  describe("API sequencing rules", () => {
    it("starts with a user message", () => {
      const result = budgetHistory([assistant("stranded reply"), user("q"), assistant("a")]);
      expect(result[0].role).toBe("user");
    });

    it("starts with a user message even after trimming cut its question", () => {
      const history = [user("old question"), assistant("old answer"), user("recent"), assistant("recent answer")];
      const result = budgetHistory(history, { maxMessages: 3, maxCharacters: 100_000 });

      expect(result[0].role).toBe("user");
      expect(result.map((m) => m.content)).toEqual(["recent", "recent answer"]);
    });

    it("returns nothing rather than an assistant-only sequence", () => {
      expect(budgetHistory([assistant("a"), assistant("b")])).toEqual([]);
    });

    it("alternates strictly, merging consecutive same-role messages", () => {
      // Two user rows in a row is a real transcript: a message persisted
      // while the daily limit stopped the reply.
      const result = budgetHistory([user("first"), user("second, no reply came"), assistant("finally")]);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: "user", content: "first\n\nsecond, no reply came" });
      expect(result[1].role).toBe("assistant");
    });

    it("never produces two adjacent messages with the same role", () => {
      const messy = [user("a"), user("b"), assistant("c"), assistant("d"), user("e"), assistant("f"), assistant("g")];
      const result = budgetHistory(messy);

      for (let i = 1; i < result.length; i++) {
        expect(result[i].role).not.toBe(result[i - 1].role);
      }
    });

    it("keeps the user's words when merging rather than discarding one", () => {
      const result = budgetHistory([user("how much did I spend"), user("on software"), assistant("$400")]);
      expect(result[0].content).toContain("how much did I spend");
      expect(result[0].content).toContain("on software");
    });
  });

  describe("the default budget", () => {
    it("is bounded on both axes", () => {
      expect(DEFAULT_HISTORY_BUDGET.maxMessages).toBeGreaterThan(0);
      expect(DEFAULT_HISTORY_BUDGET.maxCharacters).toBeGreaterThan(0);
    });

    it("bounds a runaway conversation so per-message cost cannot grow without limit", () => {
      const history = Array.from({ length: 500 }, (_, i) => (i % 2 === 0 ? user("x".repeat(400)) : assistant("y".repeat(400))));
      const result = budgetHistory(history);

      expect(result.length).toBeLessThanOrEqual(DEFAULT_HISTORY_BUDGET.maxMessages);
      expect(result.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(DEFAULT_HISTORY_BUDGET.maxCharacters);
    });
  });
});
