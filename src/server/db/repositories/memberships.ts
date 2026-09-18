import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, OrgRole } from "@/types/database";
import type { Membership } from "@/domain/organizations/types";
import { createAdminClient } from "@/server/supabase/admin";

type Client = SupabaseClient<Database>;

function toMembership(row: Database["public"]["Tables"]["memberships"]["Row"]): Membership {
  return { organizationId: row.organization_id, userId: row.user_id, role: row.role };
}

export async function listMembers(client: Client, organizationId: string): Promise<Membership[]> {
  const { data, error } = await client.from("memberships").select("*").eq("organization_id", organizationId);
  if (error) throw error;
  return data.map(toMembership);
}

/** The current user's own membership for an org — the call every protected
 *  route and every permission check (src/domain/organizations/permissions)
 *  starts from. Returns null if the user isn't a member, which RLS already
 *  guarantees is the same thing as "this org doesn't exist for you". */
export async function getMyMembership(client: Client, organizationId: string, userId: string): Promise<Membership | null> {
  const { data, error } = await client
    .from("memberships")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data ? toMembership(data) : null;
}

/**
 * Members' emails live in `auth.users`, which isn't exposed through the
 * normal PostgREST/RLS-scoped client — the admin client's
 * `auth.admin.getUserById` is the sanctioned way to read it (see the
 * "why this is safe" comment in src/server/supabase/admin.ts). Scoped to
 * exactly the members of one already-authorized organization, never a
 * cross-tenant user lookup.
 */
export async function listMembersWithEmail(client: Client, organizationId: string): Promise<(Membership & { email: string })[]> {
  const members = await listMembers(client, organizationId);
  const admin = createAdminClient();
  return Promise.all(
    members.map(async (m) => {
      const { data } = await admin.auth.admin.getUserById(m.userId);
      return { ...m, email: data.user?.email ?? "Unknown" };
    }),
  );
}

export async function updateMemberRole(
  client: Client,
  input: { organizationId: string; userId: string; role: OrgRole },
): Promise<void> {
  // RLS (memberships_update_admin_not_self) enforces both the role check
  // and the self-escalation guard — this call fails closed (0 rows
  // affected, not an error) if either isn't satisfied. See
  // src/domain/organizations/permissions.ts for the mirrored client-side
  // check used to decide whether to show this action in the UI at all.
  const { error, count } = await client
    .from("memberships")
    .update({ role: input.role }, { count: "exact" })
    .eq("organization_id", input.organizationId)
    .eq("user_id", input.userId);

  if (error) throw error;
  if (count === 0) {
    throw new Error("Not permitted to change this member's role.");
  }
}
