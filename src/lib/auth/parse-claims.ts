/**
 * Pure, side-effect-free parsing of VERIFIED JWT claims into the app's
 * SessionClaims. No "server-only", no next/*, no Supabase imports — so it is
 * safe to import from client components (for the SessionClaims type) and is
 * unit-tested in the default `npm test` run.
 *
 * The claims this reads are minted SERVER-SIDE by the custom_access_token_hook
 * (supabase/migrations/0007) SOLELY from `tenant_users`, then cryptographically
 * verified by supabase's getClaims() before reaching here. This module NEVER
 * trusts client input; it only shapes already-verified claims and re-applies
 * the SAME fail-closed rules the database RLS enforces (doc 03 §4):
 *   - tenant_id + the app role (`user_role` claim) + sub must be present and
 *     well-formed, else null;
 *   - a `client_viewer` MUST carry a client_id, else null (an unscoped viewer
 *     sees nothing — mirrors app.client_scope() in migration 0001);
 *   - a non-viewer's client_id is ignored (viewers are the only client-scoped
 *     role — contract §3).
 *
 * The app role is read from the NON-reserved `user_role` claim (migration 0008),
 * matching `app.user_role()`. The standard `role` claim is PostgREST's reserved
 * DB-role claim (`authenticated`) and is deliberately IGNORED for authorization.
 */

import { JWT_ROLES, type JwtRole } from "@/lib/types/db";

/**
 * The verified session claims the app trusts for authorization. Mirrors
 * `JwtClaims` (src/lib/types/db.ts) in camelCase for app use.
 */
export interface SessionClaims {
  /** Caller's tenant (uuid). */
  tenantId: string;
  /** App role carried in the JWT `user_role` claim (doc 03 §2). */
  role: JwtRole;
  /** Present iff role === "client_viewer". */
  clientId?: string;
  /** Supabase auth user id (`sub` / auth.users.id). */
  sub: string;
}

/** Agency staff — the roles that "run modules" (app.is_writer() in the DB). */
export const STAFF_ROLES = ["agency_admin", "operator"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Narrow an unknown to a known app role. */
export function isJwtRole(value: unknown): value is JwtRole {
  return (
    typeof value === "string" && (JWT_ROLES as readonly string[]).includes(value)
  );
}

/** agency_admin | operator — the tenant-staff surface (excludes client_viewer). */
export function isStaffRole(role: JwtRole): role is StaffRole {
  return role === "agency_admin" || role === "operator";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Shape verified JWT claims into SessionClaims, or return null (fail closed)
 * when the tenant claims are absent/malformed — e.g. an authenticated user
 * with no tenant_users membership (the hook mints role='authenticated' and no
 * tenant_id, which lands here as null).
 */
export function parseSessionClaims(
  raw: Record<string, unknown> | null | undefined
): SessionClaims | null {
  if (!raw) return null;

  const tenantId = nonEmptyString(raw.tenant_id);
  const sub = nonEmptyString(raw.sub);
  // The app role is the `user_role` claim, NOT the reserved `role` claim
  // (which is PostgREST's DB-role claim, 'authenticated' — migration 0008).
  const role = raw.user_role;

  // tenant_id + a real app role + sub are all required. A membership-less user
  // has no `user_role` (the hook mints none) and carries only role='authenticated',
  // which is not an app role — so this fails isJwtRole and returns null. Fail closed.
  if (!tenantId || !sub || !isJwtRole(role)) return null;

  if (role === "client_viewer") {
    const clientId = nonEmptyString(raw.client_id);
    // A viewer with no client scope must see nothing — refuse to build a claim.
    if (!clientId) return null;
    return { tenantId, role, clientId, sub };
  }

  // Non-viewer roles are never client-scoped; ignore any stray client_id.
  return { tenantId, role, sub };
}
