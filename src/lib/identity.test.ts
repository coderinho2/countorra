import { describe, expect, it } from "vitest";
import { resolvePublicIdentity } from "./identity";

describe("resolvePublicIdentity", () => {
  it("prefers the profile display name over metadata and email", () => {
    const identity = resolvePublicIdentity({
      profileFullName: "Ada Lovelace",
      metadataFullName: "Ignored Metadata Name",
      email: "ignored@example.com",
    });
    expect(identity).toEqual({ displayName: "Ada Lovelace", initials: "AL" });
  });

  it("falls back to auth metadata full_name when no profile name is set", () => {
    const identity = resolvePublicIdentity({
      profileFullName: null,
      metadataFullName: "Grace Hopper",
      email: "grace@example.com",
    });
    expect(identity).toEqual({ displayName: "Grace Hopper", initials: "GH" });
  });

  it("falls back to an abbreviated email handle when no name exists anywhere", () => {
    const identity = resolvePublicIdentity({
      profileFullName: null,
      metadataFullName: undefined,
      email: "diag.test@example.com",
    });
    expect(identity.displayName).toBe("diag.test");
    expect(identity.initials).toBe("DI");
  });

  it("truncates a long email handle instead of widening the navbar", () => {
    const identity = resolvePublicIdentity({
      profileFullName: "",
      metadataFullName: null,
      email: "a-very-long-mailbox-handle@example.com",
    });
    expect(identity.displayName.length).toBeLessThanOrEqual(14);
    expect(identity.displayName.endsWith("…")).toBe(true);
  });

  it("derives single-word initials from the first two letters", () => {
    const identity = resolvePublicIdentity({ profileFullName: "Cher", metadataFullName: null, email: null });
    expect(identity.initials).toBe("CH");
  });

  it("never crashes on a fully empty identity and returns a safe placeholder", () => {
    const identity = resolvePublicIdentity({ profileFullName: null, metadataFullName: null, email: null });
    expect(identity).toEqual({ displayName: "Account", initials: "A" });
  });

  it("ignores non-string metadata values (defensive against unexpected auth payload shapes)", () => {
    const identity = resolvePublicIdentity({ profileFullName: null, metadataFullName: { unexpected: true }, email: "user@example.com" });
    expect(identity.displayName).toBe("user");
  });
});
