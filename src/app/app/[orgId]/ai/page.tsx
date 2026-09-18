import { notFound } from "next/navigation";
import { requireOrgMembership } from "@/server/auth/session";
import { createClient } from "@/server/supabase/server";
import { getOrganization } from "@/server/db/repositories/organizations";
import { listTransactions } from "@/server/db/repositories/transactions";
import { listInvoices } from "@/server/db/repositories/invoices";
import { listAccounts } from "@/server/db/repositories/accounts";
import { listConversationsAction } from "@/server/ai/actions";
import { AiWorkspace } from "@/components/ai/ai-workspace";

/**
 * /app/[orgId]/ai (product spec §1–§11): the one Countorra surface,
 * behavior adapted by `organization.entityType` — never a second AI system.
 * Conversation list, entity type and the grounding counts are all fetched
 * here, server-side, from the organization's own rows (never trusted from the
 * client), and handed down to the client workspace that owns turn-by-turn
 * state.
 *
 * The grounding counts are cheap — `count: "exact"` with a single-row page,
 * so Postgres counts and returns nothing — and they let the workspace state
 * plainly what the assistant is working from. DESIGN.md §14 wants the
 * assistant to read as an analyst pointing at your books; saying how many
 * records are behind it is the least it can do to earn that.
 */

/**
 * Server Actions are POSTed to the route that hosts them, so this ceiling is
 * what bounds `sendAiMessage` — the one request path in the product that can
 * legitimately take tens of seconds.
 *
 * It was unset, which meant the platform default (as low as 15s) applied to a
 * flow that makes two provider round-trips with tool execution between them.
 * The failure mode was the worst available: the user's message and their
 * daily quota were both already consumed when the function was killed, so
 * they paid for a message and got nothing.
 *
 * 60s is the ceiling; the provider budget in
 * src/domain/ai/providers/anthropic.ts (20s timeout, 1 retry) is deliberately
 * set so the worst case fits inside it with room to persist the failure.
 */
export const maxDuration = 60;
export default async function AiAssistantPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await requireOrgMembership(orgId);

  const client = await createClient();
  const organization = await getOrganization(client, orgId);
  if (!organization) notFound();

  const [conversations, transactionPage, invoicePage, accounts] = await Promise.all([
    listConversationsAction(orgId),
    listTransactions(client, { organizationId: orgId, pageSize: 1 }),
    listInvoices(client, { organizationId: orgId, pageSize: 1 }),
    listAccounts(client, orgId),
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <AiWorkspace
        organizationId={orgId}
        entityType={organization.entityType}
        initialConversations={conversations}
        grounding={{
          transactions: transactionPage.total,
          invoices: invoicePage.total,
          accounts: accounts.length,
          through: new Date().toISOString().slice(0, 10),
        }}
      />
    </div>
  );
}
