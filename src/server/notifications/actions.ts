"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { requireOrgMembership, requireUser } from "@/server/auth/session";
import { listNotifications, markNotificationRead } from "@/server/db/repositories/notifications";
import { generateInsights } from "@/server/insights/generate-insights";
import { listInsights } from "@/server/db/repositories/insights";
import { enforceRateLimit } from "@/server/security/rate-limit";

export async function getNotifications(organizationId: string) {
  const { user } = await requireOrgMembership(organizationId);
  const client = await createClient();
  return listNotifications(client, organizationId, user.id, { limit: 20 });
}

export async function markNotificationReadAction(organizationId: string, notificationId: string) {
  const { user } = await requireOrgMembership(organizationId);
  const client = await createClient();
  await markNotificationRead(client, notificationId, user.id);
  revalidatePath(`/app/${organizationId}`);
}

/**
 * Called on-demand from the dashboard/insights page — see the module
 * comment on generateInsights for why this is a deliberate on-demand
 * trigger rather than a real background job.
 *
 * Two guards, both added by the security audit. `generateInsights` reads up
 * to 2000 transactions, runs the detectors over them, and then writes rows
 * through the ADMIN client (there is no INSERT policy on
 * `ai_insights`/`notifications`, by design) — so an unthrottled call was
 * both the most expensive request in the product and the only way a member
 * could cause unbounded RLS-bypassing writes. Any member could fire it in a
 * loop and flood the organization's insight feed and notification bell for
 * everyone, with no rate limit anywhere in front of it.
 *
 * The window below is a correctness-and-cost guard, not a substitute for
 * real infrastructure rate limiting (see the audit's deferred risks).
 */
const INSIGHT_REFRESH_WINDOW_MS = 5 * 60 * 1000;

export async function refreshInsights(organizationId: string) {
  await requireOrgMembership(organizationId);

  // The 5-minute regeneration window below prevents duplicate *writes*; it
  // does not prevent the 2000-row read and the detector passes that precede
  // it, which is the expensive part. This bounds those too.
  const rateLimited = await enforceRateLimit("insightsRefresh", { insightsRefreshPerOrg: organizationId });
  if (!rateLimited.allowed) {
    return { insightsCreated: 0, notificationsCreated: 0, skipped: true as const };
  }

  const client = await createClient();

  const existing = await listInsights(client, organizationId);
  const newest = existing.reduce<number>((latest, insight) => Math.max(latest, Date.parse(insight.generatedAt)), 0);
  if (newest > 0 && Date.now() - newest < INSIGHT_REFRESH_WINDOW_MS) {
    return { insightsCreated: 0, notificationsCreated: 0, skipped: true as const };
  }

  const result = await generateInsights(client, organizationId);
  revalidatePath(`/app/${organizationId}`);
  return { ...result, skipped: false as const };
}

export async function requireCurrentUserId() {
  const user = await requireUser();
  return user.id;
}
