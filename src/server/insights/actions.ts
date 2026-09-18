"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { requireOrgMembership } from "@/server/auth/session";
import { dismissInsight } from "@/server/db/repositories/insights";

export async function dismissInsightAction(organizationId: string, insightId: string) {
  await requireOrgMembership(organizationId);
  const client = await createClient();
  await dismissInsight(client, insightId, organizationId);
  revalidatePath(`/app/${organizationId}/insights`);
}
