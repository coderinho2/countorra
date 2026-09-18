import Link from "next/link";
import { requireOrgMembership } from "@/server/auth/session";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { PlaidOauthResume } from "@/components/bank-connections/plaid-link-button";

/**
 * Where an OAuth institution's sign-in comes back to.
 *
 * Many large banks take the customer to their own site to approve access, then
 * return them to this exact path (PLAID_REDIRECT_URI, registered with Plaid).
 * The page re-opens the dialog with the token that started it and hands the
 * result to the same Server Actions as the ordinary flow — so an OAuth
 * connection is authorized, entitled and rate limited identically.
 *
 * Membership is still required: a URL somebody was redirected to is not a
 * session.
 */
export default async function BankOauthReturnPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await requireOrgMembership(orgId);

  return (
    <PageShell wide={false} className="gap-6">
      <PageHeader eyebrow="Records" title="Finishing your bank sign-in" description="Your bank sent you back here. This takes a moment, and nothing is imported until it finishes." />
      <Panel className="flex flex-col items-start gap-3 p-4">
        <PlaidOauthResume organizationId={orgId} />
        <Button asChild variant="secondary" size="sm">
          <Link href={`/app/${orgId}/bank-connections`}>Back to bank connections</Link>
        </Button>
      </Panel>
    </PageShell>
  );
}
