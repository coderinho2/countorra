import "server-only";
import { createClient } from "@/server/supabase/server";
import { isRecentRecovery } from "@/lib/password-recovery";

/**
 * The recovery session, if this request has one. The single gate for setting a
 * password without the current one — used by the `/reset-password` page to
 * decide whether to show the form, and again by the `resetPassword` action,
 * because an action can be POSTed without ever loading the page.
 *
 * Identity comes only from the verified access token: `getClaims` checks the
 * JWT signature against the project's signing keys (or asks the Auth server,
 * for symmetric keys) before any claim is trusted. Nothing from the request
 * body, query string or a client-readable value is consulted — there is no
 * user id or email a caller can supply to choose whose password changes.
 *
 * The rule itself — recovery `amr`, recent — lives in
 * src/lib/password-recovery.ts.
 */

export interface RecoverySession {
  userId: string;
  email: string | null;
}

export async function getRecoverySession(nowSeconds: () => number = () => Math.floor(Date.now() / 1000)): Promise<RecoverySession | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return null;

    const { claims } = data;
    if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;
    if (!isRecentRecovery(claims.amr, nowSeconds())) return null;

    return { userId: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
  } catch {
    // An unreachable Auth server or JWKS endpoint is not proof of recovery.
    return null;
  }
}
