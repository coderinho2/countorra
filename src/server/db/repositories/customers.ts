import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";

type Client = SupabaseClient<Database>;
type CustomerRow = Database["public"]["Tables"]["customers"]["Row"];

export interface Customer {
  id: string;
  organizationId: string;
  displayName: string;
  email: string | null;
  billingAddress: Json;
  taxId: string | null;
}

function toCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    organizationId: row.organization_id,
    displayName: row.display_name,
    email: row.email,
    billingAddress: row.billing_address,
    taxId: row.tax_id,
  };
}

export async function listCustomers(client: Client, organizationId: string, search?: string): Promise<Customer[]> {
  let query = client.from("customers").select("*").eq("organization_id", organizationId);
  if (search) {
    const escaped = search.replace(/[%_]/g, (c) => `\\${c}`);
    query = query.ilike("display_name", `%${escaped}%`);
  }
  const { data, error } = await query.order("display_name");
  if (error) throw error;
  return data.map(toCustomer);
}

export async function getCustomer(client: Client, customerId: string): Promise<Customer | null> {
  const { data, error } = await client.from("customers").select("*").eq("id", customerId).maybeSingle();
  if (error) throw error;
  return data ? toCustomer(data) : null;
}

export interface CreateCustomerInput {
  organizationId: string;
  displayName: string;
  email?: string | null;
  taxId?: string | null;
  billingAddress?: Json;
}

export async function createCustomer(client: Client, input: CreateCustomerInput): Promise<Customer> {
  const { data, error } = await client
    .from("customers")
    .insert({
      organization_id: input.organizationId,
      display_name: input.displayName,
      email: input.email ?? null,
      tax_id: input.taxId ?? null,
      billing_address: input.billingAddress ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toCustomer(data);
}
