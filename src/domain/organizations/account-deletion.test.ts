import { describe, expect, it } from "vitest";
import { describeBlockers, planAccountDeletion, type OwnedOrganizationState } from "./account-deletion";

/**
 * The decision that determines whether other people lose their data.
 *
 * Tested as a pure function because that is the point of extracting it: the
 * rule can be inspected without a session, a database or a mock, and a change
 * to it shows up here rather than in production.
 */

const org = (overrides: Partial<OwnedOrganizationState> = {}): OwnedOrganizationState => ({
  organizationId: "org-1",
  name: "My finances",
  memberCount: 1,
  ownerCount: 1,
  viewerIsOwner: true,
  ...overrides,
});

describe("planAccountDeletion", () => {
  it("deletes a personal workspace the account holder is alone in", () => {
    const plan = planAccountDeletion([org()]);

    expect(plan.organizationsToDelete).toEqual(["org-1"]);
    expect(plan.membershipsToRemove).toEqual([]);
    expect(plan.canProceed).toBe(true);
  });

  it("proceeds for an account with no workspaces at all", () => {
    const plan = planAccountDeletion([]);
    expect(plan.canProceed).toBe(true);
    expect(plan.organizationsToDelete).toEqual([]);
  });

  it("BLOCKS a sole owner whose workspace has other members", () => {
    const plan = planAccountDeletion([org({ memberCount: 3, ownerCount: 1, viewerIsOwner: true })]);

    expect(plan.canProceed).toBe(false);
    expect(plan.blocked).toEqual([{ organizationId: "org-1", name: "My finances", reason: "sole_owner_with_members", otherMemberCount: 2 }]);
    expect(plan.organizationsToDelete).toEqual([]);
  });

  it("only leaves a co-owned workspace, never deletes it", () => {
    const plan = planAccountDeletion([org({ memberCount: 3, ownerCount: 2, viewerIsOwner: true })]);

    expect(plan.canProceed).toBe(true);
    expect(plan.organizationsToDelete).toEqual([]);
    expect(plan.membershipsToRemove).toEqual(["org-1"]);
  });

  it("only leaves a workspace the account holder does not own", () => {
    const plan = planAccountDeletion([org({ memberCount: 5, ownerCount: 1, viewerIsOwner: false })]);

    expect(plan.organizationsToDelete).toEqual([]);
    expect(plan.membershipsToRemove).toEqual(["org-1"]);
    expect(plan.canProceed).toBe(true);
  });

  it("refuses everything when any one workspace is blocked", () => {
    // All-or-nothing. A partial deletion would cost the account holder some
    // workspaces while leaving the account they asked to remove.
    const plan = planAccountDeletion([
      org({ organizationId: "personal", memberCount: 1 }),
      org({ organizationId: "shared", name: "Acme", memberCount: 4, ownerCount: 1 }),
    ]);

    expect(plan.canProceed).toBe(false);
    expect(plan.blocked.map((b) => b.organizationId)).toEqual(["shared"]);
  });

  it("handles a mix of every safe case at once", () => {
    const plan = planAccountDeletion([
      org({ organizationId: "solo", memberCount: 1 }),
      org({ organizationId: "coowned", memberCount: 3, ownerCount: 2 }),
      org({ organizationId: "guest", memberCount: 9, ownerCount: 1, viewerIsOwner: false }),
    ]);

    expect(plan.organizationsToDelete).toEqual(["solo"]);
    expect(plan.membershipsToRemove).toEqual(["coowned", "guest"]);
    expect(plan.canProceed).toBe(true);
  });

  it("never both deletes and leaves the same workspace", () => {
    const plan = planAccountDeletion([org({ organizationId: "a" }), org({ organizationId: "b", memberCount: 2, ownerCount: 2 })]);
    const overlap = plan.organizationsToDelete.filter((id) => plan.membershipsToRemove.includes(id));

    expect(overlap).toEqual([]);
  });

  it("treats a zero member count defensively rather than as co-owned", () => {
    // Shouldn't happen — a membership row is what put the org in this list —
    // but the safe reading of "no other members" is delete, not block.
    expect(planAccountDeletion([org({ memberCount: 0 })]).organizationsToDelete).toEqual(["org-1"]);
  });
});

describe("describeBlockers", () => {
  it("says nothing when nothing is blocked", () => {
    expect(describeBlockers([])).toBe("");
  });

  it("names the workspace and the action that unblocks it", () => {
    const message = describeBlockers([{ organizationId: "a", name: "Acme", reason: "sole_owner_with_members", otherMemberCount: 3 }]);

    expect(message).toContain('"Acme"');
    expect(message).toMatch(/transfer ownership/i);
    expect(message).toMatch(/remove their data/i);
  });

  it("lists several workspaces readably", () => {
    const message = describeBlockers([
      { organizationId: "a", name: "Acme", reason: "sole_owner_with_members", otherMemberCount: 1 },
      { organizationId: "b", name: "Beta", reason: "sole_owner_with_members", otherMemberCount: 2 },
    ]);

    expect(message).toContain('"Acme" and "Beta"');
    expect(message).toContain("workspaces");
  });
});
