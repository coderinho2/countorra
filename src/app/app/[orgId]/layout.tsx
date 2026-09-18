import { notFound } from "next/navigation";
import { requireOrgMembership } from "@/server/auth/session";
import { createClient } from "@/server/supabase/server";
import { getOrganization, listMyOrganizations } from "@/server/db/repositories/organizations";
import { listNotifications } from "@/server/db/repositories/notifications";
import { Sidebar } from "@/components/app-shell/sidebar";
import { Topbar } from "@/components/app-shell/topbar";
import { ViewTransition } from "@/components/app-shell/view-transition";
import { ContextBar } from "@/components/app-shell/context-bar";

/**
 * Every route under /app/[orgId]/* is authorized here, once, via
 * requireOrgMembership — individual pages don't need to repeat the check
 * (though several do it again for role-gated actions, since "is a member"
 * and "can do X" are different questions — see
 * src/domain/organizations/permissions.ts). RLS is still the real
 * boundary underneath this; this is the page-level defense-in-depth
 * layer DESIGN brief §7/§35 asks for.
 */
export default async function OrganizationLayout({ children, params }: { children: React.ReactNode; params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { user } = await requireOrgMembership(orgId);

  const client = await createClient();
  const organization = await getOrganization(client, orgId);
  if (!organization) notFound();

  // The switcher lists only organizations this user is actually a member
  // of — `listMyOrganizations` runs under the user's own RLS context, so
  // membership is enforced by the database, not by this query.
  const [notifications, organizations] = await Promise.all([listNotifications(client, orgId, user.id, { limit: 20 }), listMyOrganizations(client)]);

  return (
    // A real application frame: the shell is exactly the viewport tall and
    // only the content area scrolls. Previously the whole document scrolled,
    // which meant the sidebar and top bar slid off the top of the screen —
    // so on any page longer than the window the user lost their navigation
    // and had to scroll back up to move anywhere. `min-h-0` on both the
    // column and `main` is what lets the scroll container actually be
    // shorter than its content inside a flex parent. Note the shell is
    // sized, not flexed: `flex-1` sets `flex-basis: 0%` and, in an
    // auto-height parent, resolves back to the content height — which
    // silently defeated `h-dvh` and let the whole document scroll again.
    <div className="flex h-dvh w-full overflow-hidden">
      <Sidebar
        orgId={orgId}
        entityType={organization.entityType}
        organization={{
          id: organization.id,
          name: organization.name,
          entityType: organization.entityType,
        }}
        organizations={organizations.map((o) => ({
          id: o.id,
          name: o.name,
          entityType: o.entityType,
        }))}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Topbar
          orgId={orgId}
          orgName={organization.name}
          entityType={organization.entityType}
          userEmail={user.email ?? ""}
          notifications={notifications}
        />
        {/* The instrument strip: which books, which currency, as of when.
            Sits between the top bar and the content so it frames everything
            below it without competing with navigation above it. */}
        <ContextBar
          workspace={organization.name}
          entity={organization.entityType}
          currency={organization.baseCurrency}
          asOf={new Date().toISOString().slice(0, 10)}
        />
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <ViewTransition>{children}</ViewTransition>
        </main>
      </div>
    </div>
  );
}
