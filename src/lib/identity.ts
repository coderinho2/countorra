/**
 * Resolves a real, presentation-only identity for the public marketing
 * header's account menu (DESIGN brief: authenticated users should see who
 * they are, not just that "something" is logged in). Never a source of
 * authorization — callers already established `user` via a real Supabase
 * session (src/server/auth/session.ts#getSession) before calling this;
 * this only picks which already-real field to display and derives
 * initials for the identity mark.
 *
 * Priority: the user's own edited profile name (profiles.full_name, set
 * via Settings → Profile) → the name captured at signup
 * (auth.users.raw_user_meta_data.full_name, src/server/auth/actions.ts)
 * → an abbreviated, non-identifying slice of the email as a last resort
 * (never the full address, to avoid a wide navbar and over-exposing PII).
 */

export interface PublicIdentity {
  displayName: string;
  initials: string;
}

const MAX_EMAIL_HANDLE_LENGTH = 14;

export function resolvePublicIdentity(input: {
  profileFullName: string | null | undefined;
  metadataFullName: unknown;
  email: string | null | undefined;
}): PublicIdentity {
  const profileName = input.profileFullName?.trim();
  const metadataName = typeof input.metadataFullName === "string" ? input.metadataFullName.trim() : "";
  const name = profileName || metadataName;

  if (name) {
    return { displayName: name, initials: initialsFromName(name) };
  }

  const email = input.email?.trim() ?? "";
  const handle = email.split("@")[0] ?? "";
  if (!handle) {
    return { displayName: "Account", initials: "A" };
  }

  const displayName = handle.length > MAX_EMAIL_HANDLE_LENGTH ? `${handle.slice(0, MAX_EMAIL_HANDLE_LENGTH - 1)}…` : handle;
  return { displayName, initials: handle.slice(0, 2).toUpperCase() };
}

function initialsFromName(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
