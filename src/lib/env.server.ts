import "server-only";

/**
 * Server-only secrets. The "server-only" import makes any client-side import
 * of this module a BUILD-TIME error — service-role material can never enter
 * the client bundle graph.
 */

/**
 * Service-role key: bypasses RLS. Admin/migration tooling only — never call
 * this from a tenant-facing request path (doc 03 §2). In the run-queue infra it
 * is used for EXACTLY ONE thing: the cross-tenant lease + sweep RPCs, which are
 * reviewed SECURITY DEFINER functions EXECUTE-locked to service_role (migration
 * 0012, ruling A1). It is NEVER used for tenant data access on the run path.
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

/**
 * Runtime config the run-queue processor + sweeper need. Returned as a whole or
 * null (NON-throwing) so the internal endpoints fail CLOSED with a graceful 503
 * — never a 500 — when the server is not fully provisioned (mirrors the
 * public-config fail-closed posture). The JWT secret signs the per-run scoped
 * tokens (ruling A1); the service-role key calls the lease/sweep RPCs.
 */
export interface ProcessorRuntimeConfig {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  /** Supabase JWT secret (HS256) PostgREST verifies per-run minted tokens with. */
  jwtSecret: string;
}

export function tryGetProcessorRuntimeConfig(): ProcessorRuntimeConfig | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !jwtSecret) return null;
  return { supabaseUrl, anonKey, serviceRoleKey, jwtSecret };
}

/**
 * The shared secret the kick presents to the processor/sweeper endpoints, or
 * null when unset. NON-throwing: an unset secret means the kick is skipped (the
 * sweeper/cron is the backstop) and the endpoints refuse with 503 (fail closed).
 * NEVER logged.
 */
export function getRunsProcessorSecret(): string | null {
  return process.env.RUNS_PROCESSOR_SECRET || null;
}

/**
 * Base URL the enqueue action self-kicks. Defaults to the local dev server so
 * the whole loop runs under `npm run dev` with no extra config (ruling A9). In
 * hosted environments set RUNS_PROCESSOR_URL to the deployment's own origin.
 */
export function getRunsProcessorBaseUrl(): string {
  return process.env.RUNS_PROCESSOR_URL || `http://127.0.0.1:${process.env.PORT || "3000"}`;
}
