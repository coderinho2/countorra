import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";

type Client = SupabaseClient<Database>;
type InsightRow = Database["public"]["Tables"]["ai_insights"]["Row"];

export interface Insight {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  data: Json;
  generatedAt: string;
  dismissedAt: string | null;
}

function toInsight(row: InsightRow): Insight {
  return { id: row.id, kind: row.kind, title: row.title, body: row.body, data: row.data, generatedAt: row.generated_at, dismissedAt: row.dismissed_at };
}

export async function listInsights(client: Client, organizationId: string, options: { includeDismissed?: boolean } = {}): Promise<Insight[]> {
  let query = client.from("ai_insights").select("*").eq("organization_id", organizationId).order("generated_at", { ascending: false });
  if (!options.includeDismissed) query = query.is("dismissed_at", null);
  const { data, error } = await query;
  if (error) throw error;
  return data.map(toInsight);
}

export async function dismissInsight(client: Client, insightId: string, organizationId: string): Promise<boolean> {
  const { data, error } = await client
    .from("ai_insights")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", insightId)
    .eq("organization_id", organizationId)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}
