import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getPublicSupabaseConfig } from "@/lib/env";

/**
 * Server Supabase client (Server Components, Route Handlers, Server Actions).
 * Uses the anon key + the caller's auth cookies, so RLS applies with the
 * caller's JWT claims (tenant_id / role / client_id — doc 03 §4).
 *
 * The service-role client is deliberately NOT provided here; admin tooling
 * that needs it lives outside tenant-facing request paths.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = getPublicSupabaseConfig();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component where cookies are read-only;
          // middleware handles session refresh (added with auth work in 0.3).
        }
      },
    },
  });
}
