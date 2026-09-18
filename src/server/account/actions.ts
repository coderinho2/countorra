"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { createAdminClient } from "@/server/supabase/admin";
import { requireOrgMembership, requireUser } from "@/server/auth/session";
import { reauthenticate } from "@/server/auth/reauthentication";
import { canChangeMemberRole } from "@/domain/organizations/permissions";
import { describeBlockers, planAccountDeletion, type OwnedOrganizationState } from "@/domain/organizations/account-deletion";
import { deleteAllOrganizationFiles } from "@/server/storage/documents";
import { recordAuditEvent, AUDIT_ACTIONS } from "@/domain/audit/audit-log";
import { reportError, reportEvent } from "@/lib/observability";
import { bankCredentialDependencies } from "@/server/bank-connections/runtime";
import { releaseOrganizationBankCredentials } from "@/server/bank-connections/service";

export interface AccountActionResult {
  error?: string;
  success?: boolean;
}

/**
 * Hands an organization to another member.
 *
 * The prerequisite for deleting an account that owns a shared workspace: the
 * account holder cannot delete while they are its only owner, and they cannot
 * stop being its only owner without this.
 *
 * WHY THE ADMIN CLIENT IS USED FOR THE DEMOTION
 *
 * RLS deliberately forbids editing your own membership row
 * (`memberships_update_admin_not_self`, and `canChangeMemberRole` mirrors it)
 * because self-edit is how privilege escalation happens. That rule is correct
 * and stays. But it also makes stepping DOWN impossible, which is the one
 * self-edit that reduces privilege rather than raising it.
 *
 * So the demotion runs through the admin client, after this function has
 * established server-side that: the caller is an owner, the target is a real
 * member of the same organization, the target is not the caller, and the
 * promotion has already succeeded so the organization is never left without an
 * owner. The elevated write is narrow, ordered and audited — not a bypass of
 * the rule, but the sanctioned exception to it.
 */
export async function transferOrganizationOwnershipAction(organizationId: string, targetUserId: string): Promise<AccountActionResult> {
  const { user, membership } = await requireOrgMembership(organizationId);

  if (membership.role !== "owner") {
    return { error: "Only an owner can transfer ownership of a workspace." };
  }
  if (targetUserId === user.id) {
    return { error: "Choose a different member to transfer ownership to." };
  }

  const client = await createClient();

  // The target's membership is read from the database, never taken from the
  // request — the same rule `updateMemberRoleAction` follows.
  const { data: target, error: targetError } = await client
    .from("memberships")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .eq("user_id", targetUserId)
    .maybeSingle();

  if (targetError || !target) {
    return { error: "That person isn't a member of this workspace." };
  }

  if (!canChangeMemberRole({ role: membership.role, userId: user.id }, { userId: targetUserId, role: target.role }, "owner")) {
    return { error: "You can't transfer ownership to that member." };
  }

  const admin = createAdminClient();

  // Promote FIRST. If the demotion then fails, the organization has two
  // owners — recoverable. The reverse order could leave it with none.
  const { error: promoteError } = await admin
    .from("memberships")
    .update({ role: "owner" })
    .eq("organization_id", organizationId)
    .eq("user_id", targetUserId);

  if (promoteError) {
    reportError(promoteError, { scope: "security", organizationId, userId: user.id, detail: { step: "promote" } });
    return { error: "Ownership couldn't be transferred. Please try again." };
  }

  const { error: demoteError } = await admin
    .from("memberships")
    .update({ role: "admin" })
    .eq("organization_id", organizationId)
    .eq("user_id", user.id);

  if (demoteError) {
    reportError(demoteError, { scope: "security", organizationId, userId: user.id, detail: { step: "demote" } });
    return { error: "Ownership was transferred, but your own role couldn't be updated. Please check the members list." };
  }

  await recordAuditEvent(client, {
    organizationId,
    action: AUDIT_ACTIONS.membershipRoleChanged,
    metadata: { transferredTo: targetUserId, previousOwner: user.id },
  });
  reportEvent("ownership_transferred", { scope: "security", organizationId, userId: user.id });

  revalidatePath(`/app/${organizationId}/settings`);
  return { success: true };
}

/**
 * Deletes the account holder's account, and only what is genuinely theirs.
 *
 * The order matters and is deliberate:
 *
 *   1. Re-authenticate. A session proves someone logged in once; this proves
 *      the account holder is present for an action with no undo.
 *   2. Build the plan (src/domain/organizations/account-deletion.ts) and
 *      REFUSE entirely if any workspace would lose data that is not theirs.
 *      Nothing is deleted while a blocker exists — not even the parts that
 *      would have been safe.
 *   3. Storage first, database second. Bucket objects have no foreign key and
 *      no cascade; if the rows went first, the files would be unreachable and
 *      permanent.
 *   4. Conversations next. `ai_conversations.user_id` is NOT NULL by design —
 *      a conversation is the person's own data, not an organization record
 *      with a name on it — so they are removed rather than orphaned.
 *   5. The auth user last, which detaches attribution everywhere else through
 *      the ON DELETE SET NULL rules added in migrations 0029 and 0033. The
 *      books stay complete; the person is no longer identified by them.
 *
 * Step 5 is the only step that touches attribution, and it does so through
 * referential actions rather than through application statements. That is what
 * makes it all-or-nothing: the detach and the deletion are one statement, so
 * there is no window in which some rows have been rewritten and the account
 * still exists.
 */
export async function deleteAccountAction(_prev: AccountActionResult, formData: FormData): Promise<AccountActionResult> {
  const user = await requireUser();
  const password = String(formData.get("password") ?? "");

  const confirmation = String(formData.get("confirmation") ?? "").trim();
  if (confirmation !== "DELETE") {
    return { error: 'Type DELETE to confirm you want to remove your account.' };
  }

  const reauth = await reauthenticate(password);
  if (!reauth.ok) return { error: reauth.error };

  const client = await createClient();

  // Every organization the caller belongs to, with the counts the plan needs.
  // Read through the caller's own RLS-scoped session, so this can only ever
  // see workspaces they are actually a member of.
  const { data: memberships, error: membershipError } = await client.from("memberships").select("organization_id, user_id, role");
  if (membershipError) {
    reportError(membershipError, { scope: "security", userId: user.id, detail: { step: "list_memberships" } });
    return { error: "We couldn't check your workspaces. Please try again." };
  }

  const organizationIds = [...new Set((memberships ?? []).map((m) => m.organization_id))];
  const states: OwnedOrganizationState[] = [];

  for (const organizationId of organizationIds) {
    const rows = (memberships ?? []).filter((m) => m.organization_id === organizationId);
    const { data: org } = await client.from("organizations").select("name").eq("id", organizationId).maybeSingle();
    states.push({
      organizationId,
      name: org?.name ?? "Untitled workspace",
      memberCount: rows.length,
      ownerCount: rows.filter((m) => m.role === "owner").length,
      viewerIsOwner: rows.some((m) => m.user_id === user.id && m.role === "owner"),
    });
  }

  const plan = planAccountDeletion(states);
  if (!plan.canProceed) {
    reportEvent("account_deletion_blocked", { scope: "security", userId: user.id, detail: { blockedCount: plan.blocked.length } }, "warning");
    return { error: describeBlockers(plan.blocked) };
  }

  const admin = createAdminClient();

  try {
    // Bank-provider credentials before anything else, for every workspace
    // being deleted. The reference rows cascade with the organization, but the
    // credential itself lives in a secret store no cascade reaches — and a
    // credential that cannot be destroyed must stop the deletion while nothing
    // has been removed yet, not after one workspace already has been.
    for (const organizationId of plan.organizationsToDelete) {
      const released = await releaseOrganizationBankCredentials(bankCredentialDependencies(admin), organizationId);
      if (!released.ok) throw new Error(`bank credentials could not be released: ${released.reason}`);
    }

    for (const organizationId of plan.organizationsToDelete) {
      // Bucket objects first — nothing in the database can reach them once
      // the organization row is gone.
      await deleteAllOrganizationFiles(admin, organizationId);
      const { error } = await admin.from("organizations").delete().eq("id", organizationId);
      if (error) throw error;
    }

    for (const organizationId of plan.membershipsToRemove) {
      const { error } = await admin.from("memberships").delete().eq("organization_id", organizationId).eq("user_id", user.id);
      if (error) throw error;
    }

    // NOT NULL, so these cannot be detached — and should not be. A financial
    // conversation is the person's own content.
    const { error: conversationError } = await admin.from("ai_conversations").delete().eq("user_id", user.id);
    if (conversationError) throw conversationError;

    // `ai_actions` is NOT touched here, deliberately.
    //
    // There used to be an update at this point nulling `confirmed_by` on the
    // subset of rows the old CHECK permitted — `pending_confirmation` and
    // `rejected`. It could not touch a confirmed or executed WRITE, so a user
    // who had approved an AI write in a workspace they merely LEAVE kept a row
    // pointing at them, and `deleteUser` below then failed on the foreign key.
    // By that point everything above had already run: the account was half
    // deleted and the user was told to contact support.
    //
    // Migration 0033 moves that work into the database. The foreign key is now
    // ON DELETE SET NULL, and a trigger sets `confirmer_deleted` as it fires,
    // so the detach happens in the SAME statement as the user deletion rather
    // than as a separate step that could half-succeed. The row survives with
    // its history intact and no confirmer named.
    //
    // The update was also the one statement here whose result was never
    // checked. Removing it resolves that outright: there is no longer a step
    // that can silently do nothing.
    const { error: userError } = await admin.auth.admin.deleteUser(user.id);
    if (userError) throw userError;
  } catch (error) {
    // Every step above either succeeded or threw. Nothing reports success on
    // a failed path: this returns an error, and the caller never reaches the
    // sign-out and redirect below.
    reportError(error, { scope: "security", userId: user.id, detail: { step: "execute_plan" } });
    return { error: "We couldn't finish deleting your account. Nothing further was removed — please contact support." };
  }

  reportEvent("account_deleted", {
    scope: "security",
    userId: user.id,
    detail: { organizationsDeleted: plan.organizationsToDelete.length, membershipsRemoved: plan.membershipsToRemove.length },
  });

  await (await createClient()).auth.signOut();
  redirect("/?deleted=1");
}
