import { describe, expect, it, vi } from "vitest";
import {
  MAX_PROVIDER_CALLS_PER_REQUEST,
  MAX_RETRIES_PER_CALL,
  ZERO_USAGE,
  addUsage,
  exceedsStructuralBound,
  maxProviderCallsPerMessage,
} from "./provider-budget";
import { AIService } from "@/domain/ai/service";
import type { AIGenerateResult, AIProvider } from "@/domain/ai/provider";
import type { AITool } from "@/domain/ai/tools/types";

/**
 * Business cost protection.
 *
 * The tier is sold as unlimited messages and stays that way — the protection
 * asserted here is structural, not a cap on the customer. One user message
 * can only ever produce a bounded number of billed provider requests, because
 * `AIService.respond` is two fixed rounds rather than an agent loop and the
 * SDK's retry count is set explicitly.
 *
 * A loop creeping into `respond` later is exactly the kind of change that
 * would look harmless in review and multiply the bill, so the bound is
 * asserted against the real service, not just the constants.
 */

function countingProvider(responses: AIGenerateResult[]): AIProvider & { callCount: number } {
  let i = 0;
  const provider = {
    name: "mock",
    model: "mock-model",
    callCount: 0,
    generate: vi.fn(async () => {
      provider.callCount++;
      const response = responses[Math.min(i, responses.length - 1)];
      i++;
      return response;
    }),
  };
  return provider;
}

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

const wantsTools = (...names: string[]): AIGenerateResult => ({
  content: "",
  toolCalls: names.map((name, i) => ({ id: `call_${i}`, name, input: {} })),
  stopReason: "tool_use",
  usage: usage(100, 50),
});

const answers = (text: string): AIGenerateResult => ({ content: text, toolCalls: [], stopReason: "end_turn", usage: usage(200, 80) });

const readTool = (name: string): AITool => ({ name, description: "", operationMode: "read", inputSchema: {}, execute: async () => ({ ok: true }) });

const context = { organizationId: "org-1", userId: "user-1" };

describe("structural bounds", () => {
  it("caps one message at three model turns", () => {
    // Raised from 2 by AI-03. Three is what a resolve-then-compute-then-
    // explain question needs; the last turn carries no tools, which is what
    // makes the bound a hard stop rather than a hope.
    expect(MAX_PROVIDER_CALLS_PER_REQUEST).toBe(3);
  });

  it("keeps retries explicit and small", () => {
    expect(MAX_RETRIES_PER_CALL).toBe(1);
  });

  it("bounds the billed requests one message can produce", () => {
    // 3 rounds × (1 attempt + 1 retry) = 6. Worth stating: this is the number
    // that multiplies the bill if either input grows.
    expect(maxProviderCallsPerMessage()).toBe(6);
  });

  it("flags a request that made more calls than the code allows", () => {
    expect(exceedsStructuralBound({ inputTokens: 0, outputTokens: 0, providerCalls: 3 })).toBe(false);
    expect(exceedsStructuralBound({ inputTokens: 0, outputTokens: 0, providerCalls: 4 })).toBe(true);
  });
});

describe("usage accumulation", () => {
  it("starts at zero", () => {
    expect(ZERO_USAGE).toEqual({ inputTokens: 0, outputTokens: 0, providerCalls: 0 });
  });

  it("sums tokens and counts each call", () => {
    const total = addUsage(addUsage(ZERO_USAGE, usage(100, 50)), usage(200, 80));
    expect(total).toEqual({ inputTokens: 300, outputTokens: 130, providerCalls: 2 });
  });

  it("does not mutate what it is given", () => {
    const start = { ...ZERO_USAGE };
    addUsage(start, usage(10, 10));
    expect(start).toEqual(ZERO_USAGE);
  });
});

describe("AIService stays inside the bound", () => {
  it("makes one call when the model answers without tools", async () => {
    const provider = countingProvider([answers("hello")]);
    const result = await new AIService(provider, []).respond({ message: "hi", context });

    expect(provider.callCount).toBe(1);
    expect(result.usage.providerCalls).toBe(1);
  });

  it("makes exactly two when tools are called", async () => {
    const provider = countingProvider([wantsTools("getIncome"), answers("done")]);
    const result = await new AIService(provider, [readTool("getIncome")]).respond({ message: "income?", context });

    expect(provider.callCount).toBe(2);
    expect(result.usage.providerCalls).toBe(2);
    expect(exceedsStructuralBound(result.usage)).toBe(false);
  });

  it("still makes only two when the model asks for many tools at once", async () => {
    // Ten tool calls are ten database reads, not ten provider round-trips.
    const names = Array.from({ length: 10 }, (_, i) => `tool${i}`);
    const provider = countingProvider([wantsTools(...names), answers("done")]);
    const result = await new AIService(
      provider,
      names.map(readTool),
    ).respond({ message: "everything", context });

    expect(provider.callCount).toBe(2);
    expect(result.usage.providerCalls).toBe(2);
  });

  it("does not call again when the second round fails", async () => {
    const provider = {
      name: "mock",
      model: "mock-model",
      callCount: 0,
      generate: vi.fn(async () => {
        provider.callCount++;
        if (provider.callCount === 1) return wantsTools("getIncome");
        throw new Error("second round failed");
      }),
    };

    const result = await new AIService(provider as unknown as AIProvider, [readTool("getIncome")]).respond({ message: "q", context });

    expect(provider.callCount).toBe(2);
    expect(result.usage.providerCalls).toBe(1);
  });

  it("reports the tokens both rounds actually consumed", async () => {
    const provider = countingProvider([wantsTools("getIncome"), answers("done")]);
    const result = await new AIService(provider, [readTool("getIncome")]).respond({ message: "q", context });

    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 130, providerCalls: 2 });
  });

  it("never loops, however many tools fail", async () => {
    const failing = (name: string): AITool => ({
      name,
      description: "",
      operationMode: "read",
      inputSchema: {},
      execute: async () => {
        throw new Error("boom");
      },
    });
    const provider = countingProvider([wantsTools("a", "b", "c"), answers("done")]);
    const result = await new AIService(provider, [failing("a"), failing("b"), failing("c")]).respond({ message: "q", context });

    expect(provider.callCount).toBe(2);
    expect(result.failedTools).toHaveLength(3);
    expect(exceedsStructuralBound(result.usage)).toBe(false);
  });

  it("does not retry a failed tool at the provider", async () => {
    const provider = countingProvider([wantsTools("getIncome"), answers("done")]);
    const attempts: number[] = [];
    const tool: AITool = {
      name: "getIncome",
      description: "",
      operationMode: "read",
      inputSchema: {},
      execute: async () => {
        attempts.push(1);
        throw new Error("boom");
      },
    };

    await new AIService(provider, [tool]).respond({ message: "q", context });

    expect(attempts).toHaveLength(1);
    expect(provider.callCount).toBe(2);
  });
});
