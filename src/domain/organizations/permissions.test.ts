import { describe, expect, it } from "vitest";
import { can, canChangeMemberRole, canRemoveMember } from "./permissions";
import type { OrgRole } from "@/types/database";

describe("can", () => {
  it("lets every role read financial data, including viewer", () => {
    const roles: OrgRole[] = ["owner", "admin", "accountant", "manager", "employee", "viewer"];
    for (const role of roles) {
      expect(can(role, "financial:read")).toBe(true);
    }
  });

  it("excludes viewer from writing financial data", () => {
    expect(can("viewer", "financial:write")).toBe(false);
    expect(can("employee", "financial:write")).toBe(true);
  });

  it("restricts delete to owner/admin/accountant", () => {
    expect(can("manager", "financial:delete")).toBe(false);
    expect(can("employee", "financial:delete")).toBe(false);
    expect(can("accountant", "financial:delete")).toBe(true);
  });

  it("restricts org deletion to owner only", () => {
    expect(can("admin", "org:delete")).toBe(false);
    expect(can("owner", "org:delete")).toBe(true);
  });

  it("restricts AI write/delete confirmation to owner/admin/accountant/manager", () => {
    expect(can("employee", "ai:confirm_action")).toBe(false);
    expect(can("manager", "ai:confirm_action")).toBe(true);
  });
});

describe("canChangeMemberRole", () => {
  it("blocks an actor from changing their own role even as owner", () => {
    const owner = { role: "owner" as const, userId: "u1" };
    expect(canChangeMemberRole(owner, { userId: "u1" })).toBe(false);
  });

  it("allows an admin to change someone else's role", () => {
    const admin = { role: "admin" as const, userId: "u1" };
    expect(canChangeMemberRole(admin, { userId: "u2" })).toBe(true);
  });

  it("blocks a non-admin from changing anyone's role", () => {
    const employee = { role: "employee" as const, userId: "u1" };
    expect(canChangeMemberRole(employee, { userId: "u2" })).toBe(false);
  });
});

describe("owner-role escalation (security audit regression)", () => {
  // Reproduced during the audit: blocking self-edits alone did nothing to
  // stop an admin who simply used a second account they also controlled.
  it("an admin cannot grant the owner role to anyone", () => {
    const admin = { role: "admin" as const, userId: "u1" };
    expect(canChangeMemberRole(admin, { userId: "u2", role: "viewer" }, "owner")).toBe(false);
  });

  it("an admin cannot alter or remove an existing owner", () => {
    const admin = { role: "admin" as const, userId: "u1" };
    expect(canChangeMemberRole(admin, { userId: "u2", role: "owner" }, "viewer")).toBe(false);
    expect(canRemoveMember(admin, { userId: "u2", role: "owner" })).toBe(false);
  });

  it("an admin can still manage every non-owner role", () => {
    const admin = { role: "admin" as const, userId: "u1" };
    for (const role of ["admin", "accountant", "manager", "employee", "viewer"] as const) {
      expect(canChangeMemberRole(admin, { userId: "u2", role: "viewer" }, role)).toBe(true);
    }
    expect(canRemoveMember(admin, { userId: "u2", role: "employee" })).toBe(true);
  });

  it("an owner can grant and revoke the owner role", () => {
    const owner = { role: "owner" as const, userId: "u1" };
    expect(canChangeMemberRole(owner, { userId: "u2", role: "viewer" }, "owner")).toBe(true);
    expect(canChangeMemberRole(owner, { userId: "u2", role: "owner" }, "admin")).toBe(true);
    expect(canRemoveMember(owner, { userId: "u2", role: "owner" })).toBe(true);
  });

  it("nobody, including an owner, can act on their own membership row", () => {
    const owner = { role: "owner" as const, userId: "u1" };
    expect(canChangeMemberRole(owner, { userId: "u1", role: "owner" }, "owner")).toBe(false);
    expect(canRemoveMember(owner, { userId: "u1", role: "owner" })).toBe(false);
  });

  it("a non-manager role cannot change anyone regardless of the target", () => {
    for (const role of ["accountant", "manager", "employee", "viewer"] as const) {
      expect(canChangeMemberRole({ role, userId: "u1" }, { userId: "u2", role: "viewer" }, "viewer")).toBe(false);
    }
  });
});
