/**
 * What deleting an account is allowed to take with it.
 *
 * Kept as a pure function because it is the part that decides whether other
 * people lose their data, and that decision should be inspectable without a
 * database, a session or a mock. The server action executes this plan; it does
 * not make it.
 *
 * THE RULE, AND WHY
 *
 * A workspace is not owned by the person deleting their account just because
 * they created it. Three cases, and they are genuinely different:
 *
 *   SOLE MEMBER      — the workspace exists only for them. Deleting the
 *                      account deletes the workspace and its records, which is
 *                      what "delete my data" means for a personal ledger.
 *
 *   CO-OWNED         — another owner remains. The workspace survives; only
 *                      this person's membership goes. Their attribution on
 *                      past records is detached by the FK rules in migration
 *                      0029, so the books stay complete and the name does not.
 *
 *   SOLE OWNER, but  — BLOCKED. Deleting would either destroy other members'
 *   others present     data or leave a workspace nobody can administer. The
 *                      account holder must transfer ownership first. This is
 *                      the case that makes blind cascade deletion wrong.
 *
 * Being a non-owner member is never a blocker: leaving somebody else's
 * workspace costs them nothing but a row.
 */

export interface OwnedOrganizationState {
  organizationId: string;
  name: string;
  /** Everyone with a membership row, the account holder included. */
  memberCount: number;
  /** Members whose role is `owner`, the account holder included. */
  ownerCount: number;
  /** Whether the account holder is one of those owners. */
  viewerIsOwner: boolean;
}

export interface BlockedOrganization {
  organizationId: string;
  name: string;
  reason: "sole_owner_with_members";
  otherMemberCount: number;
}

export interface DeletionPlan {
  /** Organizations to delete outright, with everything in them. */
  organizationsToDelete: string[];
  /** Organizations to merely leave. */
  membershipsToRemove: string[];
  /** Nothing may be deleted while this is non-empty. */
  blocked: BlockedOrganization[];
  canProceed: boolean;
}

export function planAccountDeletion(organizations: OwnedOrganizationState[]): DeletionPlan {
  const organizationsToDelete: string[] = [];
  const membershipsToRemove: string[] = [];
  const blocked: BlockedOrganization[] = [];

  for (const org of organizations) {
    if (!org.viewerIsOwner) {
      membershipsToRemove.push(org.organizationId);
      continue;
    }

    if (org.memberCount <= 1) {
      organizationsToDelete.push(org.organizationId);
      continue;
    }

    if (org.ownerCount <= 1) {
      blocked.push({
        organizationId: org.organizationId,
        name: org.name,
        reason: "sole_owner_with_members",
        otherMemberCount: org.memberCount - 1,
      });
      continue;
    }

    membershipsToRemove.push(org.organizationId);
  }

  return {
    organizationsToDelete,
    membershipsToRemove,
    blocked,
    // All-or-nothing: a partially executed deletion would leave the account
    // holder having lost some workspaces while still holding an account they
    // asked to remove.
    canProceed: blocked.length === 0,
  };
}

/** A message naming exactly what must be transferred, so the refusal is
 *  actionable rather than a wall. */
export function describeBlockers(blocked: BlockedOrganization[]): string {
  if (blocked.length === 0) return "";

  const names = blocked.map((b) => `"${b.name}"`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const subject = blocked.length === 1 ? "workspace" : "workspaces";

  return `You're the only owner of the ${subject} ${list}, which ${blocked.length === 1 ? "has" : "have"} other members. Transfer ownership to another member first — deleting your account would otherwise remove their data too.`;
}
