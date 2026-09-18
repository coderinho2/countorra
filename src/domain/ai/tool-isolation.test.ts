import { describe, expect, it, vi } from "vitest";
import { AIService } from "./service";
import type { AIGenerateInput, AIGenerateResult, AIProvider } from "./provider";
import type { AITool } from "./tools/types";

/**
 * FIN-04 regression.
 *
 * `tool.execute` used to run outside any try/catch, so one throwing tool ended
 * the loop, discarded every result already collected, and let the raw
 * exception escape to the user through `sendAiMessage`'s outer catch.
 *
 * The trigger was ordinary, not exotic: a workspace whose transactions were in
 * a different currency to the one a tool asked for raised
 * `CurrencyMismatchError`, and from then on every aggregate question in that
 * workspace failed with a sentence about internal invariants.
 *
 * Kept in its own file rather than appended to service.test.ts because these
 * assert a different property — not "the pipeline produces the right answer"
 * but "the pipeline survives a part of itself failing, and says so honestly".
 */

function mockProvider(responses: AIGenerateResult[]): AIProvider & { calls: AIGenerateInput[] } {
  const calls: AIGenerateInput[] = [];
  let i = 0;
  return {
    name: "mock",
    model: "mock-model",
    calls,
    generate: vi.fn(async (input: AIGenerateInput) => {
      calls.push(input);
      const result = responses[Math.min(i, responses.length - 1)];
      i++;
      return result;
    }),
  };
}

function readTool(name: string, output: unknown): AITool {
  return { name, description: "", operationMode: "read", inputSchema: {}, execute: vi.fn(async () => output) };
}

function writeTool(name: string): AITool {
  return { name, description: "", operationMode: "write", inputSchema: {}, execute: vi.fn(async () => ({ ok: true })) };
}

function failingTool(name: string, error: Error): AITool {
  return {
    name,
    description: "",
    operationMode: "read",
    inputSchema: {},
    execute: vi.fn(async () => {
      throw error;
    }),
  };
}

const context = { organizationId: "org-1", userId: "user-1" };

const call = (id: string, name: string) => ({ id, name, input: {} });

const wantsTools = (...names: string[]): AIGenerateResult => ({
  content: "",
  toolCalls: names.map((name, i) => call(`call_${i + 1}`, name)),
  stopReason: "tool_use",
  usage: { inputTokens: 1, outputTokens: 1 },
});

const answers = (text: string): AIGenerateResult => ({ content: text, toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } });

describe("AIService tool failure isolation (FIN-04)", () => {
  it("does not collapse the turn when one tool throws", async () => {
    const provider = mockProvider([wantsTools("getIncome", "getExpenses"), answers("Income was $500. The expense figure is unavailable.")]);
    const service = new AIService(provider, [readTool("getIncome", { amountMinor: 50_000, currency: "USD" }), failingTool("getExpenses", new Error("connection terminated unexpectedly"))]);

    const result = await service.respond({ message: "profit?", context });

    expect(result.content).toBe("Income was $500. The expense figure is unavailable.");
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });

  it("keeps every successful tool's result when a sibling fails", async () => {
    const provider = mockProvider([wantsTools("getIncome", "getExpenses"), answers("done")]);
    const service = new AIService(provider, [readTool("getIncome", { amountMinor: 50_000, currency: "USD" }), failingTool("getExpenses", new Error("boom"))]);

    const result = await service.respond({ message: "profit?", context });

    expect(result.executedTools).toHaveLength(1);
    expect(result.executedTools[0].toolName).toBe("getIncome");
    expect(result.failedTools).toHaveLength(1);
    expect(result.failedTools[0].toolName).toBe("getExpenses");
  });

  it("keeps a failure out of executedTools, so it can never be read as a result", async () => {
    const provider = mockProvider([wantsTools("getExpenses"), answers("done")]);
    const service = new AIService(provider, [failingTool("getExpenses", new Error("boom"))]);

    const result = await service.respond({ message: "spend?", context });

    expect(result.executedTools).toEqual([]);
    expect(result.failedTools.map((f) => f.toolName)).toEqual(["getExpenses"]);
  });

  it("replaces an unrecognised internal error with a safe message", async () => {
    const provider = mockProvider([wantsTools("getExpenses"), answers("done")]);
    const service = new AIService(provider, [failingTool("getExpenses", new Error('relation "public.transactions" does not exist at character 42'))]);

    const result = await service.respond({ message: "spend?", context });

    expect(result.failedTools[0].message).toBe("This calculation could not be completed.");
    expect(result.failedTools[0].message).not.toContain("relation");

    // And it must not have reached the model's context window either.
    expect(JSON.stringify(provider.calls[1].messages)).not.toContain("does not exist");
  });

  it("passes through this codebase's own domain errors, which are written for a person", async () => {
    const mismatch = new Error("Currency mismatch: cannot operate on USD and EUR together.");
    mismatch.name = "CurrencyMismatchError";

    const provider = mockProvider([wantsTools("getProfitAndLoss"), answers("done")]);
    const result = await new AIService(provider, [failingTool("getProfitAndLoss", mismatch)]).respond({ message: "p&l?", context });

    expect(result.failedTools[0].message).toContain("Currency mismatch");
  });

  it("tells the model the calculation did not run, and that it must not invent one", async () => {
    const provider = mockProvider([wantsTools("getExpenses"), answers("done")]);
    await new AIService(provider, [failingTool("getExpenses", new Error("boom"))]).respond({ message: "spend?", context });

    const toolResults = provider.calls[1].messages[2].content as { type: string; content?: string }[];
    const failure = toolResults.find((b) => b.content?.includes("failed"));

    expect(failure).toBeDefined();
    expect(failure!.content).toContain("did NOT run");
    expect(failure!.content).toContain("Never estimate");
  });

  it("reports the real error to the server without exposing it", async () => {
    const onToolError = vi.fn();
    const raw = new Error("password authentication failed for user");

    const provider = mockProvider([wantsTools("getExpenses"), answers("done")]);
    const result = await new AIService(provider, [failingTool("getExpenses", raw)], onToolError).respond({ message: "spend?", context });

    expect(onToolError).toHaveBeenCalledWith("getExpenses", raw);
    expect(result.failedTools[0].message).not.toContain("password");
  });

  it("treats a hallucinated tool name as a failed call, not a crashed turn", async () => {
    const provider = mockProvider([wantsTools("getIncome", "getMagicNumber"), answers("done")]);
    const result = await new AIService(provider, [readTool("getIncome", { amountMinor: 1, currency: "USD" })]).respond({ message: "?", context });

    expect(result.executedTools).toHaveLength(1);
    expect(result.failedTools).toEqual([{ toolCallId: "call_2", toolName: "getMagicNumber", message: "That tool does not exist." }]);
  });

  it("still holds a write tool for confirmation — isolation did not soften the gate", async () => {
    const write = writeTool("createDraftTransaction");
    const provider = mockProvider([wantsTools("createDraftTransaction"), answers("done")]);

    const result = await new AIService(provider, [write]).respond({ message: "add expense", context });

    expect(write.execute).not.toHaveBeenCalled();
    expect(result.pendingConfirmations).toHaveLength(1);
    expect(result.failedTools).toEqual([]);
  });

  it("survives every tool failing, and still answers from what is left", async () => {
    const provider = mockProvider([wantsTools("getIncome", "getExpenses"), answers("I could not retrieve those figures.")]);
    const service = new AIService(provider, [failingTool("getIncome", new Error("a")), failingTool("getExpenses", new Error("b"))]);

    const result = await service.respond({ message: "profit?", context });

    expect(result.executedTools).toEqual([]);
    expect(result.failedTools).toHaveLength(2);
    expect(result.content).toBe("I could not retrieve those figures.");
  });
});

/**
 * Conversation memory reaching the provider (Phase 3).
 *
 * `budgetHistory` is unit-tested on its own; what these assert is the wiring
 * — that prior turns actually arrive in the request, in order, ahead of the
 * current message, and in both rounds. The bug being guarded against is not a
 * wrong trim, it is history being computed and then silently not sent.
 */
describe("AIService conversation memory", () => {
  const history = [
    { role: "user" as const, content: "how much did I spend on software?" },
    { role: "assistant" as const, content: "$400 last month." },
  ];

  it("sends prior turns ahead of the current message", async () => {
    const provider = mockProvider([answers("Yes, $380 the month before.")]);
    await new AIService(provider, []).respond({ message: "and the month before?", context, history });

    const sent = provider.calls[0].messages;
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({ role: "user", content: "how much did I spend on software?" });
    expect(sent[1]).toMatchObject({ role: "assistant", content: "$400 last month." });
    expect(sent[2]).toMatchObject({ role: "user", content: "and the month before?" });
  });

  it("sends only the current message when there is no history", async () => {
    const provider = mockProvider([answers("ok")]);
    await new AIService(provider, []).respond({ message: "hello", context });

    expect(provider.calls[0].messages).toHaveLength(1);
    expect(provider.calls[0].messages[0]).toMatchObject({ role: "user", content: "hello" });
  });

  it("carries the same history into the tool-explanation round", async () => {
    const provider = mockProvider([wantsTools("getIncome"), answers("done")]);
    await new AIService(provider, [readTool("getIncome", { amountMinor: 1 })]).respond({ message: "income?", context, history });

    const roundTwo = provider.calls[1].messages;
    expect(roundTwo[0]).toMatchObject({ role: "user", content: "how much did I spend on software?" });
    // ...then the current message, the assistant's tool call, and the results.
    expect(roundTwo).toHaveLength(5);
    expect(roundTwo[roundTwo.length - 1].role).toBe("user");
  });

  it("applies the budget rather than sending an unbounded transcript", async () => {
    const long = Array.from({ length: 200 }, (_, i) =>
      i % 2 === 0 ? { role: "user" as const, content: `q${i}` } : { role: "assistant" as const, content: `a${i}` },
    );
    const provider = mockProvider([answers("ok")]);
    await new AIService(provider, []).respond({ message: "now what?", context, history: long });

    // Bounded, and the current message is still last.
    expect(provider.calls[0].messages.length).toBeLessThan(20);
    expect(provider.calls[0].messages.at(-1)).toMatchObject({ content: "now what?" });
  });

  it("repairs a transcript that would violate the API's role alternation", async () => {
    const messy = [
      { role: "assistant" as const, content: "stranded reply" },
      { role: "user" as const, content: "first" },
      { role: "user" as const, content: "second, no reply came" },
    ];
    const provider = mockProvider([answers("ok")]);
    await new AIService(provider, []).respond({ message: "third", context, history: messy });

    const roles = provider.calls[0].messages.map((m) => m.role);
    expect(roles[0]).toBe("user");
    for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1]);
  });
});
