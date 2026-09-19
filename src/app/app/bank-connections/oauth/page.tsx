import type { Metadata } from "next";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { PlaidOauthResume } from "@/components/bank-connections/plaid-link-button";

export const metadata: Metadata = {
  title: "Finishing your bank sign-in",
  // A redirect landing page: nothing here for a search engine.
  robots: { index: false, follow: false },
};

/**
 * THE ONE BANK OAUTH RETURN PATH: /app/bank-connections/oauth
 *
 * Banks that sign a customer in on their own website send them back here —
 * the single PLAID_REDIRECT_URI registered with the provider, the same for
 * every organization. The path names no organization, and this page reads
 * none from the URL: the organization comes from the Link session the server
 * sealed when it started (src/server/bank-connections/link-state.ts), and the
 * actions it calls re-check that the signed-in person is the one who started
 * it and still belongs to that workspace.
 *
 * The session gate is `src/app/app/layout.tsx`, like every page under /app.
 * There is no organization shell here because, until the server has opened
 * the seal, there is no organization to show.
 */
export default function BankOauthReturnPage() {
  return (
    <PageShell wide={false} className="gap-6 py-10">
      <PageHeader eyebrow="Bank connections" title="Finishing your bank sign-in" description="Your bank sent you back here. This takes a moment, and nothing is imported until it finishes." />
      <Panel className="flex flex-col items-start gap-3 p-4">
        <PlaidOauthResume />
      </Panel>
    </PageShell>
  );
}
