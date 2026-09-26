import { createClient } from "@/server/supabase/server";
import { requireOrgMembership } from "@/server/auth/session";
import { can } from "@/domain/organizations/permissions";
import { configuredBankProviders } from "@/server/bank-connections/providers";
import { loadBankConnectionsWorkspace } from "@/server/bank-connections/workspace";
import { BankConnectionsView } from "@/components/bank-connections/bank-connections-view";

/**
 * Bank connections: the member's own RLS-scoped reads, and controls shown only
 * to the roles whose Server Actions would accept them. The actions check again
 * — hiding a button is a courtesy, not the boundary.
 */
export default async function BankConnectionsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { membership, user } = await requireOrgMembership(orgId);
  const client = await createClient();
  // The session travels in so that a developer's test plan is reflected here
  // exactly as the actions enforce it — a page that showed "upgrade" while
  // the action allowed the call would be worse than no override at all.
  const workspace = await loadBankConnectionsWorkspace(client, orgId, configuredBankProviders(), user);

  return (
    <BankConnectionsView
      organizationId={orgId}
      workspace={workspace}
      permissions={{ manage: can(membership.role, "bank:manage"), sync: can(membership.role, "bank:sync"), resolve: can(membership.role, "financial:write") }}
    />
  );
}
