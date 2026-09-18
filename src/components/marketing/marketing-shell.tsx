import type { ReactNode } from "react";
import { getMarketingAuthState } from "@/server/marketing/auth-state";
import { MarketingHeader } from "./marketing-header";
import { MarketingFooter } from "./marketing-footer";
import { PageTransition } from "./page-transition";

/**
 * Shared shell for every public page — header, footer, and the flex
 * scaffolding, factored out once so nine public routes don't each
 * re-declare it. Wraps page content in PageTransition so navigating
 * between public pages gets a controlled entrance instead of a hard
 * cut, without touching the authenticated app's routes.
 *
 * Who the visitor is comes from `getMarketingAuthState`
 * (src/server/marketing/auth-state.ts), which resolves the same real,
 * cookie-validated Supabase session every authenticated page already uses
 * — never a client-side/localStorage guess. That call is request-cached,
 * so the header here and the auth-aware CTAs further down the page share
 * one resolution instead of each re-checking the session.
 *
 * This is display only — it does not gate access to this page, so public
 * routes stay public; it only stops the marketing site from claiming a
 * logged-in visitor is signed out, or inviting them to sign up again.
 */
export async function MarketingShell({ children }: { children: ReactNode }) {
  const { identity, appHref, settingsHref } = await getMarketingAuthState();

  return (
    <div className="flex min-h-full flex-col">
      <MarketingHeader identity={identity} appHref={appHref} settingsHref={settingsHref} />
      <main className="flex-1">
        <PageTransition>{children}</PageTransition>
      </main>
      <MarketingFooter />
    </div>
  );
}
