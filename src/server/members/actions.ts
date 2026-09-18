"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { requireOrgMembership } from "@/server/auth/session";
import { canChangeMemberRole } from "@/domain/organizations/permissions";
import { getMyMembership, updateMemberRole } from "@/server/db/repositories/memberships";
import { recordAuditEvent, AUDIT_ACTIONS } from "@/domain/audit/audit-log";
import type { OrgRole } from "@/types/database";
import { enforceRateLimit } from "@/server/security/rate-limit";

/**
 * Mirrors the RLS-level self-escalation guard client-side, for a clear
 * error message instead of a silently-ignored update — RLS
 * (`memberships_update_admin_not_self`) is still what actually enforces
 * this (tests/rls/tenant-isolation.test.ts).
 */
export async function updateMemberRoleAction(organizationId: string, targetUserId: string, role: OrgRole) {
  const { user, membership } = await requireOrgMembership(organizationId);

  // Bounded after authorization, so the limiter is keyed on an identity that
  // has already been verified (rate-limit-policy.ts: privilegedMutationPerUser).
  const limited = await enforceRateLimit("privilegedMutation", { privilegedMutationPerUser: user.id });
  if (!limited.allowed) throw new Error(limited.message);

  const client = await createClient();
  // The TARGET's current role matters, not just the actor's: granting
  // `owner`, or editing someone who already holds it, is owner-only (see
  // canChangeMemberRole for the takeover this closes). Read it from the
  // database rather than from anything the client sent.
  const target = await getMyMembership(client, organizationId, targetUserId);
  if (!target) throw new Error("That member isn't part of this organization.");

  if (!canChangeMemberRole({ role: membership.role, userId: user.id }, { userId: targetUserId, role: target.role }, role)) {
    throw new Error("You can't change this member's role.");
  }

  await updateMemberRole(client, { organizationId, userId: targetUserId, role });
  await recordAuditEvent(client, { organizationId, action: AUDIT_ACTIONS.membershipRoleChanged, metadata: { targetUserId, role } });
  revalidatePath(`/app/${organizationId}/settings`);
}
