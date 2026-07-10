import "server-only";

import { createClient } from "@/lib/supabase/server";

/**
 * Shared, RLS-scoped read helpers for the operator surfaces. These never widen
 * scope: they pass the claim-scoped server client (anon key + the caller's
 * cookies) so every row is pinned to `tenant_id = app.tenant_id()` (and
 * client-scope for a viewer) in the database. App code writes no tenant filter.
 */

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Build the claim-scoped client, or null when the runtime env is not
 * provisioned (env-less build) — callers degrade to a calm shell, never a 500.
 */
export async function tryCreateClient(): Promise<Supabase | null> {
  try {
    return await createClient();
  } catch {
    return null;
  }
}

/**
 * Resolve client display names for a set of ids in one query. Out-of-scope ids
 * simply don't come back (RLS), so the map only ever holds names the caller may
 * see. Unknown ids fall back to a neutral label at the call site.
 */
export async function resolveClientNames(
  supabase: Supabase,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  if (unique.length === 0) return new Map();
  const { data, error } = await supabase
    .from("clients")
    .select("id, name")
    .in("id", unique);
  if (error || !data) return new Map();
  return new Map(
    (data as Array<{ id: string; name: string }>).map((row) => [
      row.id,
      row.name,
    ]),
  );
}
