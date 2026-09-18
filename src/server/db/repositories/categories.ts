import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Client = SupabaseClient<Database>;
type CategoryRow = Database["public"]["Tables"]["transaction_categories"]["Row"];

export interface Category {
  id: string;
  organizationId: string;
  parentCategoryId: string | null;
  kind: "income" | "expense";
  name: string;
  color: string | null;
  isSystem: boolean;
}

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    organizationId: row.organization_id,
    parentCategoryId: row.parent_category_id,
    kind: row.kind,
    name: row.name,
    color: row.color,
    isSystem: row.is_system,
  };
}

/** Categories are always organization-owned, never a shared global list
 *  (see the comment on `transaction_categories` in 0004_financial_core.sql)
 *  — this is the one function that reads them, so nothing else in the app
 *  hardcodes a category name or id. */
export async function listCategories(client: Client, organizationId: string): Promise<Category[]> {
  const { data, error } = await client
    .from("transaction_categories")
    .select("*")
    .eq("organization_id", organizationId)
    .order("kind")
    .order("name");
  if (error) throw error;
  return data.map(toCategory);
}

export interface CreateCategoryInput {
  organizationId: string;
  kind: "income" | "expense";
  name: string;
  color?: string | null;
  parentCategoryId?: string | null;
}

export async function createCategory(client: Client, input: CreateCategoryInput): Promise<Category> {
  const { data, error } = await client
    .from("transaction_categories")
    .insert({
      organization_id: input.organizationId,
      kind: input.kind,
      name: input.name,
      color: input.color ?? null,
      parent_category_id: input.parentCategoryId ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toCategory(data);
}
