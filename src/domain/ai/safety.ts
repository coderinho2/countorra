/**
 * AI safety boundary (DESIGN brief §14). Every tool the AI can call
 * declares one of these modes; only WRITE/DELETE ever touch data, and both
 * require a human-confirmed ai_actions row before src/domain/ai/service
 * will execute them — enforced twice: here in application code, and again
 * at the database level by the check constraint on ai_actions
 * (supabase/migrations/0008_ai.sql) so a bug in this file alone can't
 * produce an unconfirmed write.
 */
export type OperationMode = "read" | "analyze" | "calculate" | "suggest" | "write" | "delete";

const MUTATING_MODES: readonly OperationMode[] = ["write", "delete"];

export function requiresConfirmation(mode: OperationMode): boolean {
  return MUTATING_MODES.includes(mode);
}

export class UnauthorizedAiActionError extends Error {
  constructor(toolName: string, mode: OperationMode) {
    super(`AI tool "${toolName}" (${mode}) requires explicit human confirmation before it can execute.`);
    this.name = "UnauthorizedAiActionError";
  }
}

/** Throws unless the mode is non-mutating, or the caller has an explicit,
 *  already-recorded confirmation for it. Call this immediately before
 *  executing a tool, not just when scheduling one — see
 *  src/domain/ai/service.ts. */
export function assertAuthorized(toolName: string, mode: OperationMode, confirmed: boolean): void {
  if (requiresConfirmation(mode) && !confirmed) {
    throw new UnauthorizedAiActionError(toolName, mode);
  }
}
