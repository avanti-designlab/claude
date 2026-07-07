import "server-only";

/**
 * Server-only secrets. The "server-only" import makes any client-side import
 * of this module a BUILD-TIME error — service-role material can never enter
 * the client bundle graph.
 */

/**
 * Service-role key: bypasses RLS. Admin/migration tooling only — never call
 * this from a tenant-facing request path (doc 03 §2).
 */
export function getServiceRoleKey(): string {
  const value = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) {
    throw new Error(
      "Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY. " +
        "Copy .env.example to .env.local and fill it in (see docs/ops/environments.md).",
    );
  }
  return value;
}
