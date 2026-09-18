import { signOut } from "@/server/auth/actions";
import { CommandPalette } from "./command-palette";
import { NotificationBell } from "./notification-bell";
import { MobileNav } from "./mobile-nav";
import { Breadcrumb } from "./breadcrumb";
import { AccountMenu } from "./account-menu";
import type { UserEntityType } from "@/domain/organizations/types";
import type { Notification } from "@/server/db/repositories/notifications";

/**
 * DESIGN.md §7: 56px, breadcrumb/page title left, account and notifications
 * right, no duplicate primary nav.
 *
 * The previous arrangement put search in the centre of the bar, which is
 * where the eye lands first and therefore where the most important thing
 * should be — but search is not the most important thing on any of these
 * pages, and centring it also meant it collided with the breadcrumb at
 * narrow widths. Search now sits with the other tools on the right, where a
 * ⌘K-driven control belongs; the left edge is where you are.
 */
export function Topbar({
  orgId,
  orgName,
  entityType,
  userEmail,
  notifications,
}: {
  orgId: string;
  orgName: string;
  entityType: UserEntityType;
  userEmail: string;
  notifications: Notification[];
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border-subtle bg-surface px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <MobileNav orgId={orgId} entityType={entityType} orgName={orgName} />
        {/* On mobile the sidebar (and its workspace identity) is behind the
            drawer, so the bar names the workspace there instead of the page —
            the page's own heading is a few pixels below anyway. */}
        <span className="text-ink truncate text-[14px] font-medium lg:hidden">{orgName}</span>
        <span className="hidden min-w-0 lg:flex">
          <Breadcrumb />
        </span>
      </div>

      <div className="flex items-center gap-1">
        <CommandPalette organizationId={orgId} entityType={entityType} />
        <NotificationBell organizationId={orgId} initialNotifications={notifications} />
        <AccountMenu userEmail={userEmail} settingsHref={`/app/${orgId}/settings`} signOutAction={signOut} />
      </div>
    </header>
  );
}
