import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Client = SupabaseClient<Database>;

export interface Profile {
  id: string;
  fullName: string | null;
  defaultCurrency: string;
  locale: string;
}

export async function getProfile(client: Client, userId: string): Promise<Profile | null> {
  const { data, error } = await client.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, fullName: data.full_name, defaultCurrency: data.default_currency, locale: data.locale } : null;
}

export async function updateProfile(client: Client, userId: string, updates: { fullName?: string; defaultCurrency?: string; locale?: string }): Promise<void> {
  const { error } = await client
    .from("profiles")
    .update({
      ...(updates.fullName !== undefined ? { full_name: updates.fullName } : {}),
      ...(updates.defaultCurrency !== undefined ? { default_currency: updates.defaultCurrency } : {}),
      ...(updates.locale !== undefined ? { locale: updates.locale } : {}),
    })
    .eq("id", userId);
  if (error) throw error;
}
