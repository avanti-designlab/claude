/**
 * Environment access with fail-fast validation.
 *
 * Validation happens at call time (not import time) so `next build` succeeds
 * without secrets — CI and preview builds don't need a real Supabase project.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env.local and fill it in (see docs/ops/environments.md).`,
    );
  }
  return value;
}

export function getPublicSupabaseConfig() {
  return {
    url: required("NEXT_PUBLIC_SUPABASE_URL"),
    anonKey: required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  };
}

/**
 * Service-role key: bypasses RLS. Admin/migration tooling only — never call
 * this from a tenant-facing request path (doc 03 §2).
 */
export function getServiceRoleKey(): string {
  if (typeof window !== "undefined") {
    throw new Error("Service-role key must never be accessed in the browser.");
  }
  return required("SUPABASE_SERVICE_ROLE_KEY");
}
