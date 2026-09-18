import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";

type Client = SupabaseClient<Database>;
type ConversationRow = Database["public"]["Tables"]["ai_conversations"]["Row"];
type MessageRow = Database["public"]["Tables"]["ai_messages"]["Row"];
type ActionRow = Database["public"]["Tables"]["ai_actions"]["Row"];

export interface AiConversation {
  id: string;
  organizationId: string;
  userId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiMessage {
  id: string;
  conversationId: string;
  role: MessageRow["role"];
  content: string | null;
  createdAt: string;
}

export interface AiAction {
  id: string;
  organizationId: string;
  conversationId: string | null;
  operationMode: ActionRow["operation_mode"];
  toolName: string;
  input: Json;
  status: ActionRow["status"];
  result: Json;
  errorMessage: string | null;
  createdAt: string;
}

function toConversation(row: ConversationRow): AiConversation {
  return { id: row.id, organizationId: row.organization_id, userId: row.user_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toMessage(row: MessageRow): AiMessage {
  return { id: row.id, conversationId: row.conversation_id, role: row.role, content: row.content, createdAt: row.created_at };
}

function toAction(row: ActionRow): AiAction {
  return {
    id: row.id,
    organizationId: row.organization_id,
    conversationId: row.conversation_id,
    operationMode: row.operation_mode,
    toolName: row.tool_name,
    input: row.input,
    status: row.status,
    result: row.result,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

export async function createConversation(client: Client, organizationId: string, userId: string, title?: string): Promise<AiConversation> {
  const { data, error } = await client
    .from("ai_conversations")
    .insert({ organization_id: organizationId, user_id: userId, title: title ?? null })
    .select("*")
    .single();
  if (error) throw error;
  return toConversation(data);
}

export async function listConversations(client: Client, organizationId: string, userId: string): Promise<AiConversation[]> {
  const { data, error } = await client
    .from("ai_conversations")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data.map(toConversation);
}

export async function getConversation(client: Client, conversationId: string): Promise<AiConversation | null> {
  const { data, error } = await client.from("ai_conversations").select("*").eq("id", conversationId).maybeSingle();
  if (error) throw error;
  return data ? toConversation(data) : null;
}

/** Returns whether a row was actually renamed. RLS
 *  (`ai_conversations_update_own`) restricts this to the conversation's
 *  creator by matching zero rows rather than erroring, so the caller needs
 *  the count to tell "renamed" apart from "silently ignored". */
export async function renameConversation(client: Client, conversationId: string, title: string): Promise<boolean> {
  const { data, error } = await client.from("ai_conversations").update({ title }).eq("id", conversationId).select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * RLS (`ai_conversations_delete_own`, supabase/migrations/0022_ai_conversations_delete.sql)
 * restricts this to the conversation's own creator — a different org
 * member's delete simply matches zero rows rather than erroring, so the
 * caller (src/server/ai/actions.ts) checks affected row count itself to
 * surface a clear "not yours" error instead of a silent no-op success.
 * Deleting the conversation cascades to its ai_messages rows (FK `on
 * delete cascade`, supabase/migrations/0008_ai.sql) — no separate cleanup
 * needed.
 */
export async function deleteConversation(client: Client, conversationId: string): Promise<boolean> {
  const { data, error } = await client.from("ai_conversations").delete().eq("id", conversationId).select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Counts real user-sent messages for an organization since `sinceIso` —
 * the metering signal for `src/domain/billing/limits.ts`'s
 * `aiMessagesPerDay`. `ai_messages` has no `organization_id` column of its
 * own (it belongs to a conversation, which belongs to an org), so this
 * uses PostgREST's `!inner` embed to filter on the joined
 * `ai_conversations.organization_id` while counting `ai_messages` rows —
 * `head: true` avoids fetching row data for what is purely a count.
 */
export async function countUserMessagesSince(client: Client, organizationId: string, sinceIso: string): Promise<number> {
  const { count, error } = await client
    .from("ai_messages")
    .select("id, ai_conversations!inner(organization_id)", { count: "exact", head: true })
    .eq("ai_conversations.organization_id", organizationId)
    .eq("role", "user")
    .gte("created_at", sinceIso);
  if (error) throw error;
  return count ?? 0;
}

export async function listMessages(client: Client, conversationId: string): Promise<AiMessage[]> {
  const { data, error } = await client.from("ai_messages").select("*").eq("conversation_id", conversationId).order("created_at");
  if (error) throw error;
  return data.map(toMessage);
}

export async function addMessage(
  client: Client,
  input: { conversationId: string; role: MessageRow["role"]; content?: string | null; toolCalls?: Json; toolResults?: Json },
): Promise<AiMessage> {
  const { data, error } = await client
    .from("ai_messages")
    .insert({
      conversation_id: input.conversationId,
      role: input.role,
      content: input.content ?? null,
      tool_calls: input.toolCalls ?? null,
      tool_results: input.toolResults ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toMessage(data);
}

/**
 * Takes the ADMIN client, not the caller's session client — there is no
 * INSERT policy for `authenticated` on `ai_actions`
 * (supabase/migrations/0021_ai_actions_insert_hardening.sql), on purpose:
 * a pending action must only ever be created by this server-side flow
 * (src/server/ai/actions.ts#sendAiMessage, after `requireOrgMembership`
 * has already run), never plantable by a direct client insert. See that
 * migration's module comment for the full reasoning.
 */
export async function createPendingAction(
  adminClient: Client,
  input: { organizationId: string; conversationId: string | null; operationMode: "write" | "delete"; toolName: string; input: Json },
): Promise<AiAction> {
  const { data, error } = await adminClient
    .from("ai_actions")
    .insert({
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      operation_mode: input.operationMode,
      tool_name: input.toolName,
      input: input.input,
      status: "pending_confirmation",
    })
    .select("*")
    .single();
  if (error) throw error;
  return toAction(data);
}

export async function getAiAction(client: Client, actionId: string): Promise<AiAction | null> {
  const { data, error } = await client.from("ai_actions").select("*").eq("id", actionId).maybeSingle();
  if (error) throw error;
  return data ? toAction(data) : null;
}

/**
 * Claims a pending action for execution: an atomic compare-and-set, not a
 * blind update.
 *
 * The `.eq("status", "pending_confirmation")` predicate is the whole point.
 * `confirmAiAction` previously read the row, checked `status === 'pending'`
 * in JavaScript, and only then wrote — a textbook TOCTOU: two confirm
 * requests racing (a double-click, or a replayed request) both read
 * `pending`, both passed the check, and the write tool ran TWICE, creating
 * two transactions from one confirmation. Folding the check into the UPDATE
 * makes Postgres arbitrate it: the second statement blocks on the row lock,
 * re-evaluates its WHERE against the committed row, matches nothing, and
 * returns false. Returns whether THIS caller won the claim; only the winner
 * may execute the tool.
 *
 * Role enforcement is unchanged and still RLS's job
 * (`ai_actions_update_privileged`, 0011); the status machine and the
 * "confirmed_by must be the caller" rule are additionally enforced by the
 * `ai_actions_enforce_integrity` trigger (0024).
 */
export async function claimActionForExecution(client: Client, actionId: string, confirmedBy: string): Promise<boolean> {
  const { data, error } = await client
    .from("ai_actions")
    .update({ status: "confirmed", confirmed_by: confirmedBy })
    .eq("id", actionId)
    .eq("status", "pending_confirmation")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function markActionExecuted(client: Client, actionId: string, result: Json): Promise<void> {
  const { error } = await client
    .from("ai_actions")
    .update({ status: "executed", result, executed_at: new Date().toISOString() })
    .eq("id", actionId);
  if (error) throw error;
}

export async function markActionFailed(client: Client, actionId: string, errorMessage: string): Promise<void> {
  const { error } = await client.from("ai_actions").update({ status: "failed", error_message: errorMessage }).eq("id", actionId);
  if (error) throw error;
}

/** Same compare-and-set shape as `claimActionForExecution` — rejecting an
 *  action that has already been confirmed/executed elsewhere must not
 *  silently "succeed" and report the wrong outcome to the user. */
export async function markActionRejected(client: Client, actionId: string): Promise<boolean> {
  const { data, error } = await client
    .from("ai_actions")
    .update({ status: "rejected" })
    .eq("id", actionId)
    .eq("status", "pending_confirmation")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function listPendingActions(client: Client, organizationId: string): Promise<AiAction[]> {
  const { data, error } = await client
    .from("ai_actions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "pending_confirmation")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data.map(toAction);
}

export interface RecordAiUsageInput {
  organizationId: string;
  userId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Records what one AI turn cost at the provider.
 *
 * `ai_usage` has existed since 0008 with exactly the right columns and
 * nothing has ever written to it, so the Business tier's "unlimited" has been
 * unlimited *and* unmeasured — there was no way to answer "what does a heavy
 * workspace actually cost us", which is precisely the number needed before
 * Stripe pricing is finalized.
 *
 * Written through the ADMIN client for the same reason `ai_insights` and
 * `notifications` are: there is no INSERT policy for `authenticated` on this
 * table, deliberately, so a client can never write its own usage record and
 * under-report. Members can read their organization's rows (RLS
 * `ai_usage_select_member`); only the server can create them.
 *
 * `cost_minor` is left null: converting tokens to money requires per-model
 * rates that are a pricing input this project has not fixed. The columns that
 * are facts are recorded; the one that needs a decision is not invented.
 */
export async function recordAiUsage(client: Client, input: RecordAiUsageInput): Promise<void> {
  const { error } = await client.from("ai_usage").insert({
    organization_id: input.organizationId,
    user_id: input.userId,
    provider: input.provider,
    model: input.model,
    input_tokens: input.inputTokens,
    output_tokens: input.outputTokens,
  });
  if (error) throw error;
}
