/**
 * Public environment access with fail-fast validation.
 *
 * Validation happens at call time (not import time) so `next build` succeeds
 * without secrets — CI and preview builds don't need a real Supabase project.
 *
 * Server-only secrets live in env.server.ts (guarded by "server-only"), never
 * here — this module is imported by client code.
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
