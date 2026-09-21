import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { Organization } from "@/domain/organizations/types";
import type { LaunchEntityType } from "@/domain/organizations/launch-scope";

type Client = SupabaseClient<Database>;

/**
 * Repositories are the only place application code talks to Supabase
 * tables directly (DESIGN brief §27 — "app code never depends on random
 * Supabase calls everywhere"). They take an already-authenticated client
 * rather than constructing one, so a caller's session (and therefore RLS
 * context) is always explicit at the call site.
 */

function toOrganization(row: Database["public"]["Tables"]["organizations"]["Row"]): Organization {
  return {
    id: row.id,
    name: row.name,
    entityType: row.entity_type,
    country: row.country,
    stateRegion: row.state_region,
    baseCurrency: row.base_currency,
    taxIdentifier: row.tax_identifier,
    taxIdentifierType: row.tax_identifier_type,
  };
}

export async function listMyOrganizations(client: Client): Promise<Organization[]> {
  const { data, error } = await client.from("organizations").select("*").order("created_at", { ascending: true });
  if (error) throw error;
  return data.map(toOrganization);
}

export async function getOrganization(client: Client, organizationId: string): Promise<Organization | null> {
  const { data, error } = await client.from("organizations").select("*").eq("id", organizationId).maybeSingle();
  if (error) throw error;
  return data ? toOrganization(data) : null;
}

export interface CreateOrganizationInput {
  name: string;
  /** Personal only at launch; the database enforces it as well (0051). */
  entityType: LaunchEntityType;
  country?: string;
  stateRegion?: string | null;
  baseCurrency?: string;
  createdBy: string;
}

/**
 * The owner membership, starter categories, and initial 'free' subscription
 * are all created server-side by the `bootstrap_new_organization` trigger
 * (supabase/migrations/0012_org_bootstrap.sql) — this function only ever
 * needs to insert the organization row itself.
 */
export async function createOrganization(client: Client, input: CreateOrganizationInput): Promise<Organization> {
  const { data, error } = await client
    .from("organizations")
    .insert({
      name: input.name,
      entity_type: input.entityType,
      country: input.country,
      state_region: input.stateRegion,
      base_currency: input.baseCurrency,
      created_by: input.createdBy,
    })
    .select("*")
    .single();

  if (error) throw error;
  return toOrganization(data);
}

export async function updateOrganization(
  client: Client,
  organizationId: string,
  updates: { name?: string; country?: string; stateRegion?: string | null; baseCurrency?: string; taxIdentifier?: string | null; taxIdentifierType?: Organization["taxIdentifierType"] },
): Promise<void> {
  const { error } = await client
    .from("organizations")
    .update({
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.country !== undefined ? { country: updates.country } : {}),
      ...(updates.stateRegion !== undefined ? { state_region: updates.stateRegion } : {}),
      ...(updates.baseCurrency !== undefined ? { base_currency: updates.baseCurrency } : {}),
      ...(updates.taxIdentifier !== undefined ? { tax_identifier: updates.taxIdentifier } : {}),
      ...(updates.taxIdentifierType !== undefined ? { tax_identifier_type: updates.taxIdentifierType } : {}),
    })
    .eq("id", organizationId);
  if (error) throw error;
}
