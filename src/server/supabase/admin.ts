import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";
import { serverEnv } from "@/lib/server-env";
import type { Database } from "@/types/database";

/**
 * Service-role Supabase client. BYPASSES RLS ENTIRELY.
 *
 * This must only be used for operations that are legitimately
 * cross-tenant or system-level (e.g. background jobs, webhooks verifying
 * external providers, admin tooling) — never as a shortcut around writing
 * a correct RLS policy or a correct membership check. Every call site that
 * imports this client is a place a tenant-isolation bug can hide, so keep
 * the list of callers small and each one commented with *why* it needs
 * elevated access.
 *
 * `import "server-only"` makes any accidental client-bundle import a build
 * failure rather than a leaked service-role key.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv().SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
