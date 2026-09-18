import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Client = SupabaseClient<Database>;

export interface Merchant {
  id: string;
  organizationId: string;
  name: string;
}

export async function listMerchants(client: Client, organizationId: string): Promise<Merchant[]> {
  const { data, error } = await client.from("merchants").select("*").eq("organization_id", organizationId);
  if (error) throw error;
  return data.map((row) => ({ id: row.id, organizationId: row.organization_id, name: row.name }));
}

export async function findOrCreateMerchant(client: Client, organizationId: string, name: string): Promise<Merchant> {
  const normalized = name.trim().toLowerCase();
  const { data: existing, error: findError } = await client
    .from("merchants")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("normalized_name", normalized)
    .maybeSingle();
  if (findError) throw findError;
  if (existing) return { id: existing.id, organizationId: existing.organization_id, name: existing.name };

  const { data: created, error: createError } = await client
    .from("merchants")
    .insert({ organization_id: organizationId, name: name.trim(), normalized_name: normalized })
    .select("*")
    .single();
  if (createError) throw createError;
  return { id: created.id, organizationId: created.organization_id, name: created.name };
}
