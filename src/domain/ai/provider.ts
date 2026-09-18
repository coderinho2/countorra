/**
 * Provider-agnostic AI abstraction (DESIGN brief §13). Nothing outside
 * src/domain/ai/providers/* should import an Anthropic or OpenAI SDK
 * directly — every call site depends on this interface, so adding a
 * second provider later (OpenAI, or a local model) is a new file in
 * providers/, not a refactor of every caller.
 */

/**
 * A message's content is usually plain text, but a follow-up turn that
 * replays a prior tool call needs to carry the same `tool_use`/`tool_result`
 * blocks the Messages API itself uses (see src/domain/ai/service.ts's
 * second round) — the id linking a `tool_use` to its `tool_result` is load
 * bearing, so this shape is structural, not just "text plus metadata."
 */
export type AIContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string };

export interface AIMessage {
  role: "user" | "assistant" | "system";
  content: string | AIContentBlock[];
}

export interface AIToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface AIToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface AIGenerateResult {
  content: string;
  toolCalls: AIToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: { inputTokens: number; outputTokens: number };
}

export interface AIGenerateInput {
  messages: AIMessage[];
  system?: string;
  tools?: AIToolDefinition[];
  maxTokens?: number;
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generate(input: AIGenerateInput): Promise<AIGenerateResult>;
}
