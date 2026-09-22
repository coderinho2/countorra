"use server";

import { createClient } from "@/server/supabase/server";
import { createAdminClient } from "@/server/supabase/admin";
import { requireOrgMembership } from "@/server/auth/session";
import { createAiService, buildSystemPrompt } from "./service-factory";
import { createToolRegistry } from "@/domain/ai/tools/registry";
import { isToolInLaunchScope } from "@/domain/ai/tools/launch-scope";
import { DEFERRED_MODULE_MESSAGE } from "@/domain/organizations/launch-scope";
import { assertAuthorized, UnauthorizedAiActionError } from "@/domain/ai/safety";
import { measureDependency, reportError, reportEvent, wasReported } from "@/lib/observability";
import { currentRequestId } from "@/server/observability/request-id";
import { ProviderError } from "@/domain/ai/provider-errors";
import { parseToolInput } from "@/domain/ai/tools/types";
import { can } from "@/domain/organizations/permissions";
import { summarizeSources } from "@/domain/ai/sources";
import { getOrganization } from "@/server/db/repositories/organizations";
import {
  addMessage,
  countUserMessagesSince,
  createConversation,
  claimActionForExecution,
  createPendingAction,
  deleteConversation,
  getAiAction,
  getConversation,
  listConversations,
  listMessages,
  markActionExecuted,
  markActionFailed,
  markActionRejected,
  recordAiUsage,
  renameConversation,
  type AiConversation,
  type AiMessage,
} from "@/server/db/repositories/ai-conversations";
import { getSubscription } from "@/server/db/repositories/subscriptions";
import { last24HoursIso } from "@/domain/billing/limits";
import { entitlementsFor } from "@/domain/billing/entitlements";
import { exceedsStructuralBound } from "@/domain/billing/provider-budget";
import { recordAuditEvent, AUDIT_ACTIONS } from "@/domain/audit/audit-log";
import { clientAddress, enforceRateLimit } from "@/server/security/rate-limit";
import type { PlanTier } from "@/types/database";
import {
  sendAiMessageSchema,
  confirmAiActionSchema,
  loadConversationSchema,
  renameConversationSchema,
  deleteConversationSchema,
  type SendAiMessageInput,
  type ConfirmAiActionInput,
  type LoadConversationInput,
  type RenameConversationInput,
  type DeleteConversationInput,
} from "@/validation/schemas/aiMessage";
import type { Json } from "@/types/database";

export interface PendingActionSummary {
  id: string;
  toolName: string;
  operationMode: "write" | "delete";
  /**
   * The exact arguments that will be executed if the user confirms.
   *
   * The confirmation card previously showed only the tool's name — "the
   * assistant wants to run createDraftTransaction" — so the human in the
   * loop was authorizing an action whose amount, account and date they
   * could not see. That is not informed consent, and it is precisely the
   * gap that makes prompt-injected tool arguments dangerous: whatever the
   * model was talked into putting in `input` sails past a confirmation
   * step that never displayed it.
   */
  input: unknown;
}

export interface ToolResultSummary {
  toolName: string;
  output: unknown;
}

export interface SendAiMessageResult {
  conversationId: string;
  content: string;
  pendingActions: PendingActionSummary[];
  results: ToolResultSummary[];
  sources: string | null;
  error?: string;
  /** True when the organization's plan-based daily AI message limit
   *  (src/domain/billing/limits.ts) has been reached. The UI uses this to
   *  show a real upgrade prompt instead of a generic error — see
   *  AiChatPanel. The model is never called when this is true; the limit is
   *  enforced here, server-side. The user's own message row IS persisted
   *  first — that ordering is what makes concurrent requests count each
   *  other instead of racing past the limit; see the comment at the check
   *  itself. */
  limitReached?: boolean;
  plan?: PlanTier;
}

/**
 * The one entry point for "ask your money anything" (product spec §2–§4).
 * Enforces the full pipeline every message goes through:
 *
 *   requireOrgMembership → rate limit → plan entitlement → persist user
 *   message → AIService.respond (tools execute read/analyze/calculate
 *   immediately; write/delete requests come back as pendingConfirmations,
 *   never executed) → persist assistant message → persist each pending
 *   action as an `ai_actions` row → return to the UI
 *
 * The rate limit and the plan entitlement are separate controls and both
 * apply: the entitlement is the product limit (how much this organization
 * has paid for, src/domain/billing/limits.ts), the rate limit is the abuse
 * control (is this traffic shaped like a human,
 * src/domain/security/rate-limit-policy.ts). Neither replaces the other, and
 * both sit ahead of the provider call.
 *
 * Untrusted content note (product spec §36): the user's own message text
 * is the only thing here that reaches the model as an instruction. Tool
 * results (transaction descriptions, merchant names, document filenames)
 * are returned to the model as *data* inside tool_result blocks, per the
 * Anthropic Messages API's role separation — the model is instructed
 * (AI_SYSTEM_PROMPT) to treat them as data, and no tool result is ever
 * concatenated into the system prompt or re-interpreted as a command.
 */
export async function sendAiMessage(input: SendAiMessageInput): Promise<SendAiMessageResult> {
  const parsed = sendAiMessageSchema.safeParse(input);
  if (!parsed.success) {
    return { conversationId: "", content: "", pendingActions: [], results: [], sources: null, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  // Authenticate and authorize FIRST, so the limiter is keyed on identities
  // that have already been verified rather than on anything the client
  // asserted. `requireOrgMembership` is what makes `organizationId`
  // trustworthy here — a forged or unrelated org id never reaches the
  // limiter, it redirects out before this line.
  const { user } = await requireOrgMembership(parsed.data.organizationId);

  // Then abuse control, BEFORE the plan check, before persisting anything,
  // and well before the model is called. Ordering is the security property:
  // every expensive step below — two Anthropic round-trips, tool execution
  // against the database — is downstream of this gate, so a burst costs an
  // attacker nothing and costs us nothing either. Keyed on the authenticated
  // user, the authorized organization and the connecting address, so
  // rotating a conversation id, an org id in the payload, or a request header
  // changes none of them.
  const rateLimited = await enforceRateLimit("aiMessage", {
    aiMessagePerUser: user.id,
    aiMessagePerOrg: parsed.data.organizationId,
    aiMessagePerIp: await clientAddress(),
  });
  if (!rateLimited.allowed) {
    return { conversationId: parsed.data.conversationId ?? "", content: "", pendingActions: [], results: [], sources: null, error: rateLimited.message };
  }

  const client = await createClient();

  const organization = await getOrganization(client, parsed.data.organizationId);
  if (!organization) {
    return { conversationId: "", content: "", pendingActions: [], results: [], sources: null, error: "Organization not found." };
  }

  // Entitlements are resolved from the organization's real subscription row,
  // status included — `entitlementsFor` falls back to Free for a lapsed,
  // cancelled or incomplete subscription rather than honouring a tier the
  // organization is no longer paying for. That is what makes a downgrade take
  // effect on the next request instead of needing a reconciliation job, and
  // it is the hook Stripe will write to.
  const subscription = await getSubscription(client, parsed.data.organizationId);
  const entitlements = entitlementsFor(subscription);
  const plan: PlanTier = entitlements.tier;
  const dailyLimit = entitlements.aiMessagesPerDay;

  // Plan eligibility is a separate question from usage: "may this workspace
  // use the assistant at all" comes before "how much has it used today".
  // Every tier currently answers yes, so this gate is inert in production —
  // it is here because the alternative is that the entitlement stays
  // unenforced until the first plan that turns it off, which is exactly how
  // the organization limit came to be a number nothing checked.
  if (!entitlements.aiAssistant) {
    return {
      conversationId: parsed.data.conversationId ?? "",
      content: "",
      pendingActions: [],
      results: [],
      sources: null,
      limitReached: true,
      plan,
    };
  }

  // A client-supplied conversationId was previously used as-is: whatever
  // uuid arrived became the conversation this turn was appended to, with no
  // check that it belongs to this user or even to the organization the rest
  // of the request claims. Resolving it against its own row first (and RLS
  // now scopes ai_conversations to their creator, 0024) means the id has to
  // survive both checks before a message is written into it.
  let conversationId: string;
  if (parsed.data.conversationId) {
    const existing = await getConversation(client, parsed.data.conversationId);
    if (!existing || existing.organizationId !== parsed.data.organizationId || existing.userId !== user.id) {
      return { conversationId: "", content: "", pendingActions: [], results: [], sources: null, error: "Conversation not found." };
    }
    conversationId = existing.id;
  } else {
    conversationId = (await createConversation(client, parsed.data.organizationId, user.id, parsed.data.message.slice(0, 80))).id;
  }

  // Prior turns are loaded BEFORE the current message is persisted, so the
  // history is what came before rather than including the question being
  // asked. RLS scopes `ai_messages` to conversations the caller owns, and the
  // conversation itself was just verified to belong to this user AND this
  // organization above — so this cannot reach another user's transcript.
  const priorMessages = await listMessages(client, conversationId);
  const history = priorMessages
    // `content` is nullable in the schema and roles include more than the two
    // the API accepts; both are narrowed here rather than trusted, and
    // `budgetHistory` drops anything empty that survives.
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }));

  // Metering is deliberately count-AFTER-write, not the other way round.
  // Counting first and inserting second is a TOCTOU: N requests fired
  // together all read the same under-limit count, all pass, and all call
  // the model — the limit is trivially exceeded by racing it. Persisting
  // the message first means every concurrent request sees every other
  // one's row, so the race resolves closed (some requests may be refused
  // slightly early, which is the safe direction for a paid resource).
  await addMessage(client, { conversationId, role: "user", content: parsed.data.message });

  // Unconditional. This used to be wrapped in `if (dailyLimit !== null)`,
  // which meant the Business tier — whose limit was null — never counted
  // anything at all. `aiMessagesPerDay` is now a plain `number` on every
  // tier, so there is no branch here to skip and no tier that can opt out of
  // metering.
  const usedToday = await countUserMessagesSince(client, parsed.data.organizationId, last24HoursIso());
  if (usedToday > dailyLimit) {
    return {
      conversationId,
      content: "",
      pendingActions: [],
      results: [],
      sources: null,
      limitReached: true,
      plan,
    };
  }

  const aiService = createAiService(client);
  const requestId = await currentRequestId();
  const observed = { scope: "ai" as const, organizationId: parsed.data.organizationId, userId: user.id, requestId };

  try {
    // Timed and recorded — latency, outcome, and the request it belongs to.
    // The prompt and the reply never reach a log (src/lib/observability.ts).
    const result = await measureDependency("anthropic", "respond", observed, () =>
      aiService.respond({
        message: parsed.data.message,
        system: buildSystemPrompt(organization),
        context: { organizationId: parsed.data.organizationId, userId: user.id },
        history,
      }),
    );

    await addMessage(client, {
      conversationId,
      role: "assistant",
      content: result.content,
      toolResults: (result.executedTools as unknown as Json) ?? null,
    });

    const admin = createAdminClient();

    // Record what this turn cost at the provider. Best-effort on purpose: a
    // metering failure must not lose the user an answer they already paid a
    // message for, and the daily entitlement — which IS the customer-facing
    // control — is metered separately off `ai_messages`, so it is unaffected
    // either way. The admin client is required because `ai_usage` has no
    // INSERT policy for `authenticated`, so a client cannot under-report.
    try {
      await recordAiUsage(admin, {
        organizationId: parsed.data.organizationId,
        userId: user.id,
        provider: aiService.providerName,
        model: aiService.providerModel,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      if (exceedsStructuralBound(result.usage)) {
        // Not a customer problem — the code is supposed to make at most two
        // provider calls per message. More than that means a loop crept in.
        reportEvent("ai.provider_call_bound_exceeded", { ...observed, detail: { providerCalls: result.usage.providerCalls } }, "error");
      }
    } catch (usageError) {
      reportError(usageError, { ...observed, detail: { step: "record_ai_usage" } });
    }

    const pendingActions: PendingActionSummary[] = [];
    for (const pending of result.pendingConfirmations) {
      const action = await createPendingAction(admin, {
        organizationId: parsed.data.organizationId,
        conversationId,
        operationMode: pending.operationMode,
        toolName: pending.toolName,
        input: pending.input as Json,
      });
      pendingActions.push({ id: action.id, toolName: pending.toolName, operationMode: pending.operationMode, input: pending.input });
    }

    const sourceSummary = summarizeSources(result.executedTools);

    return {
      conversationId,
      content: result.content,
      pendingActions,
      results: result.executedTools.map((t) => ({ toolName: t.toolName, output: t.output })),
      sources: sourceSummary?.text ?? null,
    };
  } catch (error) {
    // Individual tool failures no longer reach here — `AIService` isolates
    // them (FIN-04). What is left is a provider or database failure, whose
    // message is a connection string, a schema name or an SDK internal. The
    // real error is logged; the user gets a sentence they can act on, and the
    // same sentence is what gets persisted into the conversation, since that
    // transcript is read back later by both the user and the model.
    // Through the redacting seam, never raw: a database or SDK message can
    // carry connection details (src/lib/observability.ts).
    // Once: a model failure was already recorded, with its duration, by
    // measureDependency; only failures after it (saving the reply, pending
    // actions) are recorded here.
    if (!wasReported(error)) reportError(error, { ...observed, detail: { step: "send_ai_message", providerError: error instanceof ProviderError } });

    // A `ProviderError` has already been classified and phrased for a person
    // at the provider boundary (429, 5xx, timeout, malformed reply), so its
    // message is safe to show and worth showing — "try again in a moment" is
    // actionable in a way that a generic failure is not. Anything else is
    // still replaced wholesale, because it carries connection strings, schema
    // names and SDK internals.
    const message = error instanceof ProviderError ? error.message : "The assistant could not complete this request. Nothing was changed — please try again.";
    await addMessage(client, { conversationId, role: "assistant", content: message });
    return { conversationId, content: "", pendingActions: [], results: [], sources: null, error: message };
  }
}

export interface ConfirmAiActionResult {
  status: "executed" | "rejected";
  error?: string;
}

/**
 * The confirmation half of the WRITE/DELETE gate (product spec §4). RLS
 * (`ai_actions_update_privileged`) already restricts who can move an
 * action out of pending_confirmation to owner/admin/accountant/manager —
 * `can(membership.role, "ai:confirm_action")` here is the same rule
 * checked client-side-early so a non-privileged member gets a clear error
 * instead of a silently-ignored update.
 */
export async function confirmAiAction(input: ConfirmAiActionInput): Promise<ConfirmAiActionResult> {
  const parsed = confirmAiActionSchema.safeParse(input);
  if (!parsed.success) return { status: "rejected", error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const client = await createClient();
  const action = await getAiAction(client, parsed.data.aiActionId);
  if (!action) return { status: "rejected", error: "Action not found." };

  const { user, membership } = await requireOrgMembership(action.organizationId);

  // Executing a confirmed action performs a real financial write, so it gets
  // its own budget. Placed after `requireOrgMembership` so the key is the
  // authenticated user, not anything the request claimed.
  const rateLimited = await enforceRateLimit("aiConfirm", { aiConfirmPerUser: user.id });
  if (!rateLimited.allowed) return { status: "rejected", error: rateLimited.message };

  // Both approving and rejecting are UPDATEs on ai_actions, gated by the
  // same RLS policy — so the permission check has to come before either
  // branch. It previously sat after the reject path, which let an
  // unprivileged member "reject" someone else's pending action and be told
  // it worked while RLS silently discarded the write.
  if (!can(membership.role, "ai:confirm_action")) {
    return { status: "rejected", error: "You don't have permission to act on AI actions for this organization." };
  }

  if (action.status !== "pending_confirmation") {
    return { status: "rejected", error: `This action is already ${action.status}.` };
  }

  if (!parsed.data.approve) {
    const rejected = await markActionRejected(client, action.id);
    return rejected ? { status: "rejected" } : { status: "rejected", error: "This action is no longer pending." };
  }

  // A write proposed before the launch scope narrowed — a draft invoice — is
  // not replayed while its module is deferred. It stays pending, unexecuted.
  if (!isToolInLaunchScope(action.toolName)) {
    return { status: "rejected", error: DEFERRED_MODULE_MESSAGE };
  }

  try {
    assertAuthorized(action.toolName, action.operationMode as "write" | "delete", true);

    const tools = createToolRegistry(client);
    const tool = tools.find((t) => t.name === action.toolName);
    if (!tool) throw new Error(`Unknown tool "${action.toolName}".`);

    // Re-validate the stored arguments before replaying them. The row has
    // sat in the database between proposal and confirmation, and
    // `ai_actions.input` is jsonb — this is the last point at which
    // something malformed can be stopped before it becomes a financial
    // record. (0024 additionally makes tool_name/input immutable at the
    // database level, so the two layers agree.)
    const toolInput = parseToolInput(tool, action.input);

    // Atomically claim the action. Two concurrent confirmations (a
    // double-click, a replayed request) previously both read
    // "pending_confirmation" in JavaScript and both executed the tool,
    // creating the record twice from a single human confirmation. Exactly
    // one caller can win this compare-and-set.
    const claimed = await claimActionForExecution(client, action.id, user.id);
    if (!claimed) {
      return { status: "rejected", error: "This action was already confirmed." };
    }

    const result = await tool.execute(toolInput, { organizationId: action.organizationId, userId: user.id });
    await markActionExecuted(client, action.id, result as Json);

    await recordAuditEvent(client, {
      organizationId: action.organizationId,
      action: AUDIT_ACTIONS.aiActionExecuted,
      resourceType: "ai_action",
      resourceId: action.id,
      metadata: { toolName: action.toolName },
    });

    return { status: "executed" };
  } catch (error) {
    const message = error instanceof UnauthorizedAiActionError ? error.message : error instanceof Error ? error.message : "Execution failed.";
    await markActionFailed(client, action.id, message);
    return { status: "rejected", error: message };
  }
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

/** Conversation history for the current user within one organization
 *  (product spec §8). `requireOrgMembership` plus filtering by the
 *  caller's own `userId` (not a client-supplied one) is what keeps this
 *  scoped to "my conversations" — RLS additionally scopes every row to
 *  the organization regardless. */
export async function listConversationsAction(organizationId: string): Promise<ConversationSummary[]> {
  const { user } = await requireOrgMembership(organizationId);
  const client = await createClient();
  const conversations = await listConversations(client, organizationId, user.id);
  return conversations.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }));
}

export interface LoadConversationResult {
  messages: Pick<AiMessage, "id" | "role" | "content">[];
  error?: string;
}

/**
 * Loads a conversation's messages for display. Authorization here follows
 * the same "fetch first, authorize against what's real" pattern as
 * confirmAiAction above: the conversation's organizationId is read from
 * its own row, never accepted from the client, so a request that pairs a
 * conversationId from one org with an organizationId the user happens to
 * belong to cannot be used to read across organizations.
 */
export async function loadConversationAction(input: LoadConversationInput): Promise<LoadConversationResult> {
  const parsed = loadConversationSchema.safeParse(input);
  if (!parsed.success) return { messages: [], error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const client = await createClient();
  const conversation = await getConversation(client, parsed.data.conversationId);
  if (!conversation) return { messages: [], error: "Conversation not found." };

  await requireOrgMembership(conversation.organizationId);

  const messages = await listMessages(client, conversation.id);
  return { messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content })) };
}

function findConversationOrThrow(conversation: AiConversation | null): asserts conversation is AiConversation {
  if (!conversation) throw new Error("Conversation not found.");
}

export interface ConversationActionResult {
  ok: boolean;
  error?: string;
}

export async function renameConversationAction(input: RenameConversationInput): Promise<ConversationActionResult> {
  const parsed = renameConversationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const client = await createClient();
  const conversation = await getConversation(client, parsed.data.conversationId);
  try {
    findConversationOrThrow(conversation);
  } catch {
    return { ok: false, error: "Conversation not found." };
  }

  await requireOrgMembership(conversation.organizationId);
  const renamed = await renameConversation(client, conversation.id, parsed.data.title);
  if (!renamed) return { ok: false, error: "You can only rename conversations you started." };
  return { ok: true };
}

/** Delete requires confirmation client-side (product spec §3/§8) — this
 *  action performs the delete itself once the user has already confirmed
 *  in the UI; RLS (`ai_conversations_delete_own`) is the actual boundary
 *  restricting this to the conversation's own creator. */
export async function deleteConversationAction(input: DeleteConversationInput): Promise<ConversationActionResult> {
  const parsed = deleteConversationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const client = await createClient();
  const conversation = await getConversation(client, parsed.data.conversationId);
  try {
    findConversationOrThrow(conversation);
  } catch {
    return { ok: false, error: "Conversation not found." };
  }

  await requireOrgMembership(conversation.organizationId);
  const deleted = await deleteConversation(client, conversation.id);
  if (!deleted) return { ok: false, error: "You can only delete conversations you started." };
  return { ok: true };
}
