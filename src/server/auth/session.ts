import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { getMyMembership } from "@/server/db/repositories/memberships";
import type { OrgRole } from "@/types/database";

/**
 * The auth abstraction application code depends on (DESIGN brief §7) —
 * nothing outside src/server/auth and src/server/supabase should call
 * `supabase.auth.*` directly. Every check here is server-side; there is no
 * client-only authorization anywhere in this codebase (DESIGN brief §7:
 * "must be enforced server-side").
 */

export async function getSession() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** Redirects to /login if there's no session. Use at the top of any
 *  Server Component or Route Handler that requires authentication. */
export async function requireUser() {
  const user = await getSession();
  if (!user) redirect("/login");
  return user;
}

/**
 * Requires both a session AND membership in the given organization,
 * optionally restricted to specific roles. This is a defense-in-depth
 * check, not the primary boundary — RLS (supabase/migrations/0011) is what
 * actually prevents cross-tenant data access even if a route forgot to
 * call this. Redirects rather than throwing, since every caller is a page.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireOrgMembership(organizationId: string, allowedRoles?: OrgRole[]) {
  const user = await requireUser();

  // `organizationId` comes straight from the URL, so it is not necessarily
  // a uuid at all. Passing a non-uuid through to PostgREST produced a
  // Postgres cast error that surfaced as a 500 — a needless error path,
  // reachable unauthenticated-ish by anyone with a session, on every
  // /app/* route. A malformed id simply isn't an organization this user
  // belongs to, so it takes the same route as any other non-membership.
  if (!UUID_PATTERN.test(organizationId)) redirect("/app");

  const supabase = await createClient();
  const membership = await getMyMembership(supabase, organizationId, user.id);

  if (!membership) redirect("/app");
  if (allowedRoles && !allowedRoles.includes(membership.role)) redirect("/app");

  return { user, membership };
}
