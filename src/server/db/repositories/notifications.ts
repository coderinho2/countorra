import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Client = SupabaseClient<Database>;
type NotificationRow = Database["public"]["Tables"]["notifications"]["Row"];

export interface Notification {
  id: string;
  organizationId: string;
  userId: string | null;
  kind: NotificationRow["kind"];
  title: string;
  body: string | null;
  resourceType: string | null;
  resourceId: string | null;
  createdAt: string;
  isRead: boolean;
}

/** Reads notifications visible to `userId` in `organizationId` (RLS
 *  already restricts this to org-wide + targeted-at-me rows), left-joined
 *  against this viewer's own read receipts. */
export async function listNotifications(
  client: Client,
  organizationId: string,
  userId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<Notification[]> {
  // Two queries rather than an embedded `notifications(..., notification_reads(...))`
  // select — this hand-written Database type doesn't model table
  // relationships (see the comment on `Relationships: []` in
  // src/types/database.ts), so an embedded select can't be typed
  // accurately. Joining in JS keeps this simple and correctly typed.
  const [notificationsResult, readsResult] = await Promise.all([
    client
      .from("notifications")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(options.limit ?? 50),
    client.from("notification_reads").select("notification_id").eq("user_id", userId),
  ]);
  if (notificationsResult.error) throw notificationsResult.error;
  if (readsResult.error) throw readsResult.error;

  const readIds = new Set(readsResult.data.map((r) => r.notification_id));

  const notifications = notificationsResult.data.map((row: NotificationRow) => ({
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    createdAt: row.created_at,
    isRead: readIds.has(row.id),
  }));

  return options.unreadOnly ? notifications.filter((n) => !n.isRead) : notifications;
}

export async function markNotificationRead(client: Client, notificationId: string, userId: string): Promise<void> {
  const { error } = await client
    .from("notification_reads")
    .upsert({ notification_id: notificationId, user_id: userId }, { onConflict: "notification_id,user_id" });
  if (error) throw error;
}

/**
 * Writes go through the admin client — there is no INSERT policy for
 * `authenticated` on `notifications` (supabase/migrations/0015), the same
 * pattern as `audit_logs`. `src/domain/insights/generate.ts` is the only
 * caller, and only after the invoking Server Action has already verified
 * the requesting user is a member of `organizationId` — see that file's
 * module comment for the full reasoning.
 */
export async function createNotifications(
  adminClient: Client,
  organizationId: string,
  items: Array<{
    kind: NotificationRow["kind"];
    title: string;
    body?: string;
    resourceType?: string;
    resourceId?: string;
    userId?: string | null;
  }>,
): Promise<void> {
  if (items.length === 0) return;
  const { error } = await adminClient.from("notifications").insert(
    items.map((item) => ({
      organization_id: organizationId,
      kind: item.kind,
      title: item.title,
      body: item.body ?? null,
      resource_type: item.resourceType ?? null,
      resource_id: item.resourceId ?? null,
      user_id: item.userId ?? null,
    })),
  );
  if (error) throw error;
}
