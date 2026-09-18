"use client";

import { useTransition } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updateMemberRoleAction } from "@/server/members/actions";
import { canChangeMemberRole } from "@/domain/organizations/permissions";
import type { Membership } from "@/domain/organizations/types";
import type { OrgRole } from "@/types/database";

const ROLE_OPTIONS: OrgRole[] = ["owner", "admin", "accountant", "manager", "employee", "viewer"];

/**
 * `canChangeMemberRole` decides both what's editable and which roles are
 * offered — the same function the Server Action and (in SQL form) RLS use,
 * so the three cannot drift. This is presentation only: hiding the `owner`
 * option from an admin is a courtesy, not the control. The control is
 * `memberships_update_admin_not_self` in
 * supabase/migrations/0024_security_hardening.sql.
 */
export function MembersManager({
  organizationId,
  members,
  currentUserId,
  currentUserRole,
  canManage,
}: {
  organizationId: string;
  members: (Membership & { email: string })[];
  currentUserId: string;
  currentUserRole: OrgRole;
  canManage: boolean;
}) {
  const [, startTransition] = useTransition();
  const actor = { role: currentUserRole, userId: currentUserId };

  return (
    <ul className="flex flex-col gap-2">
      {members.map((member) => {
        const isSelf = member.userId === currentUserId;
        const editable = canManage && canChangeMemberRole(actor, { userId: member.userId, role: member.role });
        const assignableRoles = ROLE_OPTIONS.filter((role) => canChangeMemberRole(actor, { userId: member.userId, role: member.role }, role));
        return (
          <li key={member.userId} className="flex items-center justify-between rounded-md border border-border-subtle px-3 py-2.5">
            <span className="text-[15px] text-text-primary">
              {member.email}
              {isSelf && <span className="ml-2 text-[13px] text-text-tertiary">(you)</span>}
            </span>
            {editable ? (
              <Select
                value={member.role}
                onValueChange={(role) => startTransition(() => updateMemberRoleAction(organizationId, member.userId, role as OrgRole))}
              >
                <SelectTrigger className="h-8 w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {assignableRoles.map((role) => (
                    <SelectItem key={role} value={role}>
                      {role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-[13px] text-text-secondary capitalize">{member.role}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
