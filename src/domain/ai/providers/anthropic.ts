import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import { malformedResponse, toProviderError } from "../provider-errors";
import type { AIGenerateInput, AIGenerateResult, AIMessage, AIProvider, AIToolCall } from "../provider";

/**
 * Request budget.
 *
 * One `sendAiMessage` makes up to TWO provider calls (the tool round, then
 * the explanation round), and the whole thing runs inside a Server Action
 * with a hard platform ceiling — `maxDuration` on the route that hosts it.
 * The SDK's defaults are wrong for that shape in both directions: a
 * 10-minute timeout means the platform kills the function long before the
 * client gives up, and its default retry count multiplies every wait.
 *
 * These numbers are chosen so the worst case fits inside a 60s ceiling:
 * one round timing out and retrying once is 2 × 20s = 40s, which still
 * leaves room to persist the failure and answer. `maxRetries` is stated
 * explicitly rather than left to the default so nobody has to know what the
 * default is to reason about cost — every retry is a billed request.
 */
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 1;

function toAnthropicContent(content: AIMessage["content"]): string | Anthropic.Messages.ContentBlockParam[] {
  if (typeof content === "string") return content;
  return content.map((block): Anthropic.Messages.ContentBlockParam => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input as Record<string, unknown> };
    return { type: "tool_result", tool_use_id: block.toolUseId, content: block.content };
  });
}

/**
 * The default provider (DESIGN brief §13 lists Anthropic first, OpenAI as
 * future). Translates the provider-agnostic AIGenerateInput/Result shape
 * to and from the Anthropic Messages API — this file is the only place
 * that shape conversion happens.
 *
 * It is also the only place a provider-shaped error exists. Everything that
 * leaves this class is either a valid result or a `ProviderError` carrying a
 * message safe to show a user (see ../provider-errors.ts); a 429, a 503, a
 * socket timeout and a response of unexpected shape are all classified here
 * rather than leaking upward as SDK internals.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;

  constructor(model = "claude-sonnet-5") {
    this.model = model;
    this.client = new Anthropic({
      apiKey: serverEnv().ANTHROPIC_API_KEY,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
    });
  }

  async generate(input: AIGenerateInput): Promise<AIGenerateResult> {
    let response: Anthropic.Messages.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: input.maxTokens ?? 1024,
        system: input.system,
        messages: input.messages.map((m) => ({ role: m.role === "system" ? "assistant" : m.role, content: toAnthropicContent(m.content) })),
        tools: input.tools?.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
        })),
      });
    } catch (error) {
      // 429s and 5xx have already been retried by the SDK within the budget
      // above; reaching here means the retries were spent too.
      throw toProviderError(error);
    }

    // The SDK's types promise this shape, but the types describe a contract,
    // not a runtime guarantee — a proxy, a truncated body or a future API
    // change can all produce something else. Since the alternative to
    // checking is presenting a half-read answer about someone's money, it is
    // checked.
    if (!response || !Array.isArray(response.content)) {
      throw malformedResponse("response.content was not an array");
    }

    const toolCalls: AIToolCall[] = response.content
      .filter((block): block is Anthropic.Messages.ToolUseBlock => block?.type === "tool_use")
      .map((block) => ({ id: block.id, name: block.name, input: block.input }));

    if (toolCalls.some((call) => typeof call.id !== "string" || typeof call.name !== "string")) {
      throw malformedResponse("a tool_use block was missing its id or name");
    }

    const content = response.content
      .filter((block): block is Anthropic.Messages.TextBlock => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");

    const stopReason: AIGenerateResult["stopReason"] =
      response.stop_reason === "tool_use" ? "tool_use" : response.stop_reason === "max_tokens" ? "max_tokens" : "end_turn";

    return {
      content,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }
}
