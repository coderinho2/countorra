import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";
import type { Database } from "@/types/database";

/**
 * Request-scoped Supabase client for Server Components, Route Handlers, and
 * Server Actions. Reads/writes the session via cookies, so `auth.uid()` is
 * available to RLS policies on every query made through this client.
 *
 * Uses the anon key — this client is subject to RLS like any other user
 * session. It is NOT the admin client; it cannot bypass tenant isolation.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component that can't set cookies (e.g.
            // during static rendering). Session refresh is handled in
            // proxy.ts instead, so this is safe to ignore.
          }
        },
      },
    },
  );
}
