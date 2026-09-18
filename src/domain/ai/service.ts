import { assertAuthorized, requiresConfirmation } from "./safety";
import type { AIContentBlock, AIMessage, AIProvider, AIToolDefinition } from "./provider";
import { parseToolInput, toolFailureMessage, type AITool, type ToolContext, type ToolFailure } from "./tools/types";
import { budgetHistory, type HistoryMessage } from "./conversation-history";
import { addUsage, MAX_PROVIDER_CALLS_PER_REQUEST, ZERO_USAGE, type ProviderUsage } from "@/domain/billing/provider-budget";

/**
 * Orchestrates provider + tools + the safety gate (DESIGN brief §13–§14).
 *
 * A BOUNDED tool loop, not a general agent loop: at most
 * `MAX_PROVIDER_CALLS_PER_REQUEST` model turns per user message, and the last
 * of those is always tool-free so the model is forced to produce an answer
 * rather than ask for more work.
 *
 * WHY THIS REPLACED THE FIXED TWO ROUNDS (AI-03)
 *
 * The previous shape was round one with tools, round two without. The
 * tool-free second round was the prompt-injection defence: attacker text
 * inside a tool result could not trigger a tool call, because no tool existed
 * in the turn that read it.
 *
 * The first real end-to-end test showed what that cost. Asked "what was my
 * net cash flow this month?", the model correctly called
 * `getFinancialPeriods` to turn "this month" into a date range — that tool
 * exists precisely to be chained into a second call — and then could not make
 * the call it had just prepared for, because round two had no tools. It
 * returned an empty string. Any question with a relative period was affected,
 * which is most questions a person asks about money.
 *
 * HOW INJECTION SAFETY IS PRESERVED WITHOUT THAT ROUND
 *
 * The tool-free round was never the only defence, and it was not the load
 * bearing one. What actually contains a hostile tool result is structural,
 * and all of it still holds — now stated explicitly rather than relied on:
 *
 *  1. **Three separated channels.** `system` carries trusted instructions and
 *     is passed BYWORD-IDENTICAL on every round; it is built once by the
 *     caller from the organization's own row and this class never appends to
 *     it. The user's message is a `user` turn. Tool output travels only
 *     inside `tool_result` blocks. Nothing a tool returns can reach `system`,
 *     because nothing in this method ever writes to it.
 *  2. **A closed tool set.** The model can only name tools in the registry;
 *     an unknown name is a failed call, never an execution.
 *  3. **Schema validation on every call, every round.** `parseToolInput`
 *     runs before anything else, so injected arguments are rejected before
 *     they can be executed or persisted.
 *  4. **Server-supplied scope.** Every tool receives `ctx` — the authorized
 *     organization and user — from the server. The model cannot supply,
 *     override or widen it, so the worst an injected read achieves is data
 *     the caller could already see.
 *  5. **The confirmation gate is round-independent.** WRITE and DELETE never
 *     execute here at any round; they become `pendingConfirmations` that a
 *     human approves with the arguments visible. Chaining cannot reach around
 *     it, and a repeated proposal is de-duplicated rather than stacking.
 *  6. **A hard stop.** The final round is offered no tools, so the loop
 *     cannot be extended by anything the model or a tool result asks for.
 *
 * So an injected tool result can, at most, cause one additional *read* within
 * the caller's own organization, or propose a write the user must explicitly
 * confirm. That is a real reduction in the blast radius of chaining, and it is
 * the trade this design accepts in exchange for questions being answerable.
 *
 * Every tool call is isolated (FIN-04). `tool.execute` used to run outside
 * any try/catch, so one throwing tool aborted the loop, threw away the
 * results of every tool that had already succeeded, and surfaced the raw
 * exception to the user. A failure is now a *result* like any other: it is
 * reported to the model as an explicit `status: "failed"` tool_result, the
 * other tools' work survives, and the model is told in the same payload not
 * to substitute a number for the one it did not get.
 */

/**
 * What the user sees when the loop finishes with nothing to say (AI-04).
 *
 * The empty string used to reach the UI directly: an assistant bubble with no
 * text in it, indistinguishable from a rendering bug. It states that nothing
 * happened and asks for a retry — and deliberately contains no figure, no
 * estimate and no provider detail, because the one thing worse than a blank
 * answer about someone's money is an invented one.
 */
export const EMPTY_RESPONSE_FALLBACK =
  "I wasn't able to put together an answer for that. Nothing in your records was changed — please try again, or rephrase the question.";

export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  output: unknown;
}

export interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  input: unknown;
  operationMode: "write" | "delete";
}

export interface AIRespondResult {
  content: string;
  executedTools: ToolExecutionResult[];
  /** Tools that were called and threw. Kept separate from `executedTools` so
   *  a failure can never be mistaken for a result, and exposed so a caller can
   *  log or surface it rather than have it vanish. */
  failedTools: ToolFailure[];
  /** What this turn actually cost at the provider, summed across every round.
   *  Returned so the caller can record it (`ai_usage`) — the Business tier is
   *  sold as unlimited, so measurement is the only way its real cost is ever
   *  visible. See src/domain/billing/provider-budget.ts. */
  usage: ProviderUsage;
  /** WRITE/DELETE tool calls the model requested but that were NOT
   *  executed — the caller must persist these as `ai_actions` rows
   *  (status: 'pending_confirmation') via
   *  src/server/db/repositories and surface them to the user. Executing
   *  a tool in this list without that confirmation flow is exactly what
   *  DESIGN brief §14 forbids. */
  pendingConfirmations: PendingConfirmation[];
  /**
   * True when the loop consumed every available round.
   *
   * Observability only — never read by control flow. The hard stop is the
   * tool-free final round, not this flag.
   *
   * Named for what it measures. It was `stoppedAtRoundLimit`, which read as
   * "the answer was cut short" — and the first live run set it on three
   * successful multi-step answers, because using all three rounds is the
   * normal path for a chain, not a truncation. A telemetry field that makes
   * healthy traffic look degraded is worse than no field.
   */
  usedAllRounds: boolean;
}

/** Outcome of executing one round's tool calls. */
interface RoundOutcome {
  assistantContent: AIContentBlock[];
  toolResultContent: AIContentBlock[];
}

export class AIService {
  constructor(
    private provider: AIProvider,
    private tools: AITool[],
    /** Server-side observability seam. The *real* error goes here; only the
     *  sanitized message from `toolFailureMessage` ever leaves this class. */
    private onToolError?: (toolName: string, error: unknown) => void,
  ) {}

  /** Which provider and model actually served a turn. Exposed so the caller
   *  can attribute a usage record without reaching into the provider — an
   *  `ai_usage` row that does not say which model produced it is not much use
   *  for costing. */
  get providerName(): string {
    return this.provider.name;
  }

  get providerModel(): string {
    return this.provider.model;
  }

  private toolDefinitions(): AIToolDefinition[] {
    return this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  private findTool(name: string): AITool | undefined {
    return this.tools.find((t) => t.name === name);
  }

  async respond(input: { message: string; system?: string; context: ToolContext; history?: HistoryMessage[] }): Promise<AIRespondResult> {
    // Prior turns, trimmed and made API-legal by `budgetHistory`. Passing
    // them is what makes "and last month?" resolvable — without it every
    // message was turn one, however much transcript the UI displayed.
    const history = budgetHistory(input.history ?? []);
    const conversation: AIMessage[] = [...history, { role: "user", content: input.message }];

    const executedTools: ToolExecutionResult[] = [];
    const pendingConfirmations: PendingConfirmation[] = [];
    const failedTools: ToolFailure[] = [];

    let usage = ZERO_USAGE;
    let answer = "";
    let usedAllRounds = false;

    for (let round = 1; round <= MAX_PROVIDER_CALLS_PER_REQUEST; round++) {
      // The hard stop. The final round is offered no tools at all, so the
      // model cannot extend the loop and neither can anything inside a tool
      // result — termination is a property of the request we send, not of the
      // model choosing to stop.
      const isFinalRound = round === MAX_PROVIDER_CALLS_PER_REQUEST;

      let result;
      try {
        result = await this.provider.generate({
          messages: conversation,
          // Trusted channel. Identical every round, never appended to, and
          // never derived from tool output.
          system: input.system,
          tools: isFinalRound ? undefined : this.toolDefinitions(),
        });
      } catch (error) {
        // A first-round failure is a real provider outage the caller has to
        // surface. A later one means we already have tool results worth
        // keeping, so the loop ends and whatever text exists is used.
        if (round === 1) throw error;
        break;
      }

      usage = addUsage(usage, result.usage);
      if (result.content.trim().length > 0) answer = result.content;

      if (result.toolCalls.length === 0) break;

      // Reaching here on the final round would mean tools were requested in a
      // turn where none were offered — impossible via the API, but if a
      // provider ever did it, the calls are ignored rather than executed.
      if (isFinalRound) {
        usedAllRounds = true;
        break;
      }

      const outcome = await this.runToolCalls(result, input.context, { executedTools, pendingConfirmations, failedTools });
      conversation.push({ role: "assistant", content: outcome.assistantContent });
      conversation.push({ role: "user", content: outcome.toolResultContent });

      // The model asked for work on the last round that could carry tools, so
      // the next turn is the tool-free one and every round will have been
      // used. Recorded for observability.
      if (round === MAX_PROVIDER_CALLS_PER_REQUEST - 1) usedAllRounds = true;
    }

    return {
      // AI-04: the one place an empty answer can be produced, and the one
      // place it is caught.
      content: answer.trim().length > 0 ? answer : EMPTY_RESPONSE_FALLBACK,
      executedTools,
      pendingConfirmations,
      failedTools,
      usage,
      usedAllRounds,
    };
  }

  /**
   * Executes one round's tool calls and builds the two messages that carry
   * them back to the model.
   *
   * Accumulators are passed in rather than returned so results survive across
   * rounds — a tool that succeeded in round one must still be reported even
   * if round two goes wrong.
   */
  private async runToolCalls(
    result: { content: string; toolCalls: { id: string; name: string; input: unknown }[] },
    context: ToolContext,
    acc: { executedTools: ToolExecutionResult[]; pendingConfirmations: PendingConfirmation[]; failedTools: ToolFailure[] },
  ): Promise<RoundOutcome> {
    const executed: ToolExecutionResult[] = [];
    const pending: PendingConfirmation[] = [];
    const failed: ToolFailure[] = [];
    const rejected: { toolCallId: string; reason: string }[] = [];

    for (const call of result.toolCalls) {
      // A hallucinated tool name is a failed call, not a crashed turn.
      // Recorded in BOTH the per-round list (which builds this round's
      // tool_result blocks) and the accumulator (which the caller receives) —
      // missing the accumulator made the failure invisible to the caller
      // while still being reported to the model.
      const tool = this.findTool(call.name);
      if (!tool) {
        const failure = { toolCallId: call.id, toolName: call.name, message: "That tool does not exist." };
        failed.push(failure);
        acc.failedTools.push(failure);
        continue;
      }

      // Validate BEFORE the write/delete branch, not after: an invalid
      // argument must never reach `ai_actions.input`, where it would be
      // shown to a human as a proposal and replayed verbatim on
      // confirmation. See AITool#parseInput.
      let parsedInput: unknown;
      try {
        parsedInput = parseToolInput(tool, call.input);
      } catch (error) {
        rejected.push({ toolCallId: call.id, reason: error instanceof Error ? error.message : "Invalid tool arguments." });
        continue;
      }

      if (requiresConfirmation(tool.operationMode)) {
        // De-duplicated across rounds: a model that re-proposes the same
        // write after seeing "awaiting confirmation" must not stack a second
        // identical card in front of the user.
        const fingerprint = `${call.name}:${JSON.stringify(parsedInput)}`;
        const alreadyProposed = acc.pendingConfirmations.some((p) => `${p.toolName}:${JSON.stringify(p.input)}` === fingerprint);
        const proposal: PendingConfirmation = {
          toolCallId: call.id,
          toolName: call.name,
          input: parsedInput,
          operationMode: tool.operationMode as "write" | "delete",
        };
        if (!alreadyProposed) acc.pendingConfirmations.push(proposal);
        pending.push(proposal);
        continue;
      }

      // The isolation boundary. Everything inside is one tool's problem, and
      // nothing inside can end the loop. The confirmation gate stays *within*
      // it, so a write tool that somehow reached here still cannot execute:
      // `assertAuthorized` throwing becomes a failed tool, never a silent pass.
      try {
        assertAuthorized(tool.name, tool.operationMode, /* confirmed */ true);
        const output = await tool.execute(parsedInput, context);
        const record = { toolCallId: call.id, toolName: call.name, toolInput: parsedInput, output };
        executed.push(record);
        acc.executedTools.push(record);
      } catch (error) {
        this.onToolError?.(call.name, error);
        const failure = { toolCallId: call.id, toolName: call.name, message: toolFailureMessage(error) };
        failed.push(failure);
        acc.failedTools.push(failure);
      }
    }

    const assistantContent: AIContentBlock[] = [
      ...(result.content ? [{ type: "text" as const, text: result.content }] : []),
      ...result.toolCalls.map((call) => ({ type: "tool_use" as const, id: call.id, name: call.name, input: call.input })),
    ];

    // Every tool result is wrapped in a status envelope. The `data` key is the
    // untrusted channel: whatever a merchant name, memo or document filename
    // contains lands in there and nowhere else, and never in `system`.
    const toolResultContent: AIContentBlock[] = [
      ...executed.map((t) => ({
        type: "tool_result" as const,
        toolUseId: t.toolCallId,
        content: JSON.stringify({ status: "ok", data: t.output }),
      })),
      ...pending.map((p) => ({
        type: "tool_result" as const,
        toolUseId: p.toolCallId,
        content: JSON.stringify({
          status: "awaiting_user_confirmation",
          note: "This action has NOT run yet — it requires the user's explicit confirmation. Describe it as a proposal, never as completed, and do not call it again.",
        }),
      })),
      ...rejected.map((r) => ({
        type: "tool_result" as const,
        toolUseId: r.toolCallId,
        content: JSON.stringify({ status: "rejected_invalid_arguments", note: `${r.reason} Nothing was run or proposed. Tell the user plainly; do not retry with invented values.` }),
      })),
      // Stated as a failure the model must report, not as an absence it might
      // paper over. Without the explicit instruction, the likeliest recovery
      // from a missing figure is to produce one.
      ...failed.map((f) => ({
        type: "tool_result" as const,
        toolUseId: f.toolCallId,
        content: JSON.stringify({
          status: "failed",
          error: f.message,
          note: "This calculation did NOT run and produced no figure. Say so plainly, and answer whatever the other tool results do support. Never estimate, infer, or carry over another number to stand in for this one.",
        }),
      })),
    ];

    return { assistantContent, toolResultContent };
  }
}
