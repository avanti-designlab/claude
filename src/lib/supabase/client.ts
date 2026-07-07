import { createBrowserClient } from "@supabase/ssr";

import { getPublicSupabaseConfig } from "@/lib/env";

/**
 * Browser Supabase client. Anon key + RLS — the database enforces tenant
 * isolation (doc 03); this client can never be trusted to do it.
 */
export function createClient() {
  const { url, anonKey } = getPublicSupabaseConfig();
  return createBrowserClient(url, anonKey);
}
