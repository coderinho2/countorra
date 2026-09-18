import { requireUser } from "@/server/auth/session";

/** The only job of this layout is the auth gate — every route under
 *  /app/* requires a session. The actual shell (sidebar, top bar, org
 *  context) lives in src/app/app/[orgId]/layout.tsx, since it needs to
 *  know which organization is active. /app itself and /onboarding render
 *  without that shell (there's no org to scope navigation to yet). */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return <>{children}</>;
}
