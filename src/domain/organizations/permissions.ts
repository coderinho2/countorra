import type { OrgRole } from "@/types/database";

/**
 * Mirrors supabase/migrations/0011_rls_policies.sql exactly. This module
 * exists so the UI can decide what to show/enable without a round trip,
 * and so server actions can reject early with a clear error — but RLS is
 * the actual enforcement boundary (DESIGN brief §9: "do not rely solely on
 * application-level checks"). If these two ever disagree, the database
 * wins; treat a mismatch as a bug in this file, not in the SQL.
 */

export type FinancialPermission = "financial:read" | "financial:write" | "financial:delete";
export type OrgPermission = "org:update" | "org:delete" | "org:manage_members";
export type AiPermission = "ai:confirm_action";
/**
 * Billing is its own permission rather than being folded into `org:update`.
 *
 * They happen to grant the same roles today (owner + admin), but they are not
 * the same question: `org:update` is "may rename this workspace", and this is
 * "may commit it to a recurring charge". Keeping them separate means tightening
 * billing to owner-only later is a one-line change here, instead of an audit of
 * every `org:update` call site to work out which ones meant money.
 *
 * There is no `billing:read`. The plan and usage a member already sees in
 * Settings is org data under the existing `subscriptions_select_member` policy.
 */
export type BillingPermission = "billing:manage";
/**
 * Finalizing a prepared return. Its own permission because it is not an edit:
 * it locks a version of a return after a person has reviewed every figure and
 * limitation. Granted to the roles that can delete financial records outright.
 *
 * Unlike the permissions above, this one has no RLS mirror: members have NO
 * write policy on the filing tables at all (migration 0044), and finalization
 * happens only in a server action that checks this first.
 */
export type TaxPermission = "tax:finalize";

/**
 * Bank connections (Task 11). `bank:manage` — connecting, disconnecting, and
 * deciding which Countorra account a bank account feeds — holds a credential and
 * changes what enters the books, so it is owner/admin only. `bank:sync` asks an
 * existing connection for new transactions, a write-level action any
 * bookkeeping role may take; a viewer may not.
 *
 * No RLS mirror: members have no write privilege on any bank table (migration
 * 0047). These gate the Server Actions that write with the service role.
 */
export type BankPermission = "bank:manage" | "bank:sync";

export type Permission = FinancialPermission | OrgPermission | AiPermission | BillingPermission | TaxPermission | BankPermission;

const ALL_ROLES: OrgRole[] = ["owner", "admin", "accountant", "manager", "employee", "viewer"];
const WRITE_ROLES: OrgRole[] = ["owner", "admin", "accountant", "manager", "employee"];
const DELETE_ROLES: OrgRole[] = ["owner", "admin", "accountant"];
const ADMIN_ROLES: OrgRole[] = ["owner", "admin"];
const OWNER_ROLES: OrgRole[] = ["owner"];
const AI_CONFIRM_ROLES: OrgRole[] = ["owner", "admin", "accountant", "manager"];

const PERMISSION_ROLES: Record<Permission, OrgRole[]> = {
  "financial:read": ALL_ROLES,
  "financial:write": WRITE_ROLES,
  "financial:delete": DELETE_ROLES,
  "org:update": ADMIN_ROLES,
  "org:delete": OWNER_ROLES,
  "org:manage_members": ADMIN_ROLES,
  "ai:confirm_action": AI_CONFIRM_ROLES,
  "billing:manage": ADMIN_ROLES,
  "tax:finalize": DELETE_ROLES,
  "bank:manage": ADMIN_ROLES,
  "bank:sync": WRITE_ROLES,
};

export function can(role: OrgRole, permission: Permission): boolean {
  return PERMISSION_ROLES[permission].includes(role);
}

/**
 * A member can never change their own role, regardless of how privileged
 * that role already is — only another owner/admin can (DESIGN brief §9,
 * enforced at the database level by `memberships_update_admin_not_self`
 * and verified in tests/rls/tenant-isolation.test.ts).
 *
 * Blocking self-edits alone was not enough, and the audit reproduced why:
 * an `admin` simply used a second account they also controlled. They
 * granted it `owner`, then deleted the real owner's membership — a
 * complete organization takeover that never once touched their own row.
 * So the `owner` role itself is now the boundary: only an existing owner
 * may hand it out, alter an owner's row, or remove one. Mirrors
 * supabase/migrations/0024_security_hardening.sql, which is what actually
 * enforces it.
 */
export function canChangeMemberRole(
  actor: { role: OrgRole; userId: string },
  target: { userId: string; role?: OrgRole },
  nextRole?: OrgRole,
): boolean {
  if (actor.userId === target.userId) return false;
  if (!can(actor.role, "org:manage_members")) return false;
  // Granting owner, or touching someone who already is one, is owner-only.
  if ((nextRole === "owner" || target.role === "owner") && actor.role !== "owner") return false;
  return true;
}

/** Removing a member follows the same rule as changing one: only an owner
 *  may remove an owner. */
export function canRemoveMember(actor: { role: OrgRole; userId: string }, target: { userId: string; role: OrgRole }): boolean {
  return canChangeMemberRole(actor, target, target.role);
}
