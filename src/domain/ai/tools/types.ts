import type { OperationMode } from "../safety";

export interface ToolContext {
  organizationId: string;
  userId: string;
}

export class InvalidToolInputError extends Error {
  constructor(toolName: string, reason: string) {
    super(`Invalid arguments for tool "${toolName}": ${reason}`);
    this.name = "InvalidToolInputError";
  }
}

export interface AITool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  operationMode: OperationMode;
  inputSchema: Record<string, unknown>;
  /**
   * Runtime validation of the arguments, applied before `execute` ever
   * sees them.
   *
   * `inputSchema` is a JSON Schema sent *to the model* — a description of
   * what the tool wants, not a guarantee of what arrives. Nothing enforces
   * it: the model can emit any JSON, and (for write/delete tools) that JSON
   * is persisted in `ai_actions.input` and replayed at confirmation time,
   * so an unvalidated argument survives the human-in-the-loop step
   * untouched. Untrusted text the model just read — a merchant name, a
   * transaction memo, an OCR'd document — is exactly the sort of thing that
   * can steer those arguments (product spec §36), which is why this is a
   * hard boundary in code rather than a rule in the prompt.
   *
   * Implementations throw (Zod's own error is fine); callers translate that
   * into a tool-level error, never a crashed turn.
   */
  parseInput?: (input: unknown) => Input;
  execute(input: Input, context: ToolContext): Promise<Output>;
}

/** Applies a tool's `parseInput` if it has one, normalizing any validation
 *  failure into `InvalidToolInputError`. Used on both paths a tool's input
 *  can arrive by: the model's live tool call (src/domain/ai/service.ts) and
 *  a stored `ai_actions.input` replayed at confirmation time
 *  (src/server/ai/actions.ts). */
export function parseToolInput(tool: AITool, input: unknown): unknown {
  if (!tool.parseInput) return input;
  try {
    return tool.parseInput(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unrecognized arguments";
    throw new InvalidToolInputError(tool.name, reason);
  }
}

/**
 * A tool that failed while executing — as opposed to one whose arguments
 * failed validation (`InvalidToolInputError`, above) or one awaiting human
 * confirmation.
 *
 * FIN-04. `AIService.respond` used to call `tool.execute` outside any
 * try/catch, so a single throwing tool aborted the loop, discarded every
 * other tool's already-successful result, and surfaced to the user as the raw
 * exception text — in the reported case
 * `"Currency mismatch: cannot operate on USD and EUR together"`, which is an
 * internal invariant, not something a person asking about their money can act
 * on. One bad tool took the whole turn with it.
 */
export interface ToolFailure {
  toolCallId: string;
  toolName: string;
  /** Safe to put in front of a user and to hand back to the model. */
  message: string;
}

/**
 * Errors this codebase raises deliberately, phrased for a person. Everything
 * else — a Postgres error, a PostgREST payload, a provider SDK failure, an
 * unexpected TypeError — is replaced with a generic line, because those carry
 * schema names, connection details and stack context that must not reach a
 * user or the model's context window.
 *
 * Matched by `name` rather than by `instanceof` so the check survives the
 * class being re-exported or an error crossing a module boundary.
 */
const USER_SAFE_ERROR_NAMES = new Set(["InvalidToolInputError", "CurrencyMismatchError", "UnauthorizedAiActionError"]);

export function toolFailureMessage(error: unknown): string {
  if (error instanceof Error && USER_SAFE_ERROR_NAMES.has(error.name)) return error.message;
  return "This calculation could not be completed.";
}
