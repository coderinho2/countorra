import "server-only";
import { cache } from "react";
import { getSession } from "@/server/auth/session";
import { createClient } from "@/server/supabase/server";
import { getProfile } from "@/server/db/repositories/profiles";
import { listMyOrganizations } from "@/server/db/repositories/organizations";
import { resolvePublicIdentity, type PublicIdentity } from "@/lib/identity";

/**
 * What the public site needs to know about the visitor: who they are, and
 * where "their" product lives.
 *
 * This was previously computed inline in MarketingShell for the header
 * alone. It moved here because the header is no longer the only thing that
 * needs it — every "Get started" on a public page has to become "Open
 * Countorra" for someone already signed in, and those CTAs sit in four
 * different components spread across nine routes.
 *
 * Wrapped in React's `cache()` so all of them share one resolution per
 * request: without it, a page with a hero CTA, a pricing CTA and a closing
 * CTA would issue four independent `auth.getUser()` round-trips to render
 * one page.
 *
 * This is display state, not authorization. It is derived from the same
 * real, cookie-validated Supabase session every authenticated page uses
 * (never localStorage, never a client-side guess), and it gates nothing —
 * public routes stay public whatever it returns. Access to `/app` is still
 * decided by `requireOrgMembership` and RLS, exactly as before.
 */
export interface MarketingAuthState {
  /** Null when signed out. */
  identity: PublicIdentity | null;
  /** The signed-in user's product entry point; `/app` when they have no
   *  organization yet (that route redirects into onboarding itself). */
  appHref: string;
  settingsHref: string;
}

export const getMarketingAuthState = cache(async (): Promise<MarketingAuthState> => {
  const user = await getSession();
  if (!user) {
    return { identity: null, appHref: "/app", settingsHref: "/app" };
  }

  const client = await createClient();
  const [profile, organizations] = await Promise.all([getProfile(client, user.id), listMyOrganizations(client)]);

  const identity = resolvePublicIdentity({
    profileFullName: profile?.fullName,
    metadataFullName: user.user_metadata?.full_name,
    email: user.email,
  });

  const firstOrgId = organizations[0]?.id;
  if (!firstOrgId) {
    return { identity, appHref: "/app", settingsHref: "/app" };
  }

  return {
    identity,
    appHref: `/app/${firstOrgId}/dashboard`,
    settingsHref: `/app/${firstOrgId}/settings`,
  };
});
