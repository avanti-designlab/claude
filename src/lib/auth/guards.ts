import "server-only";

import { redirect } from "next/navigation";

import type { JwtRole } from "@/lib/types/db";
import { getClaims } from "./session";
import { isStaffRole, type SessionClaims } from "./parse-claims";

/**
 * Authorization guards for Server Components / Route Handlers / Server Actions.
 *
 * Two distinct failures, handled differently:
 *   - NOT AUTHENTICATED (no valid tenant claims) => redirect to the login page.
 *     This includes the authenticated-but-no-membership case: the DB fails it
 *     closed anyway, and there is nothing for such a user to see.
 *   - AUTHENTICATED but WRONG ROLE => throw AuthorizationError. This is not a
 *     login problem; the caller (or an error boundary / route handler) maps it
 *     to a 403. Never a redirect-to-login loop.
 *
 * Guards are a convenience for the app layer. They are NOT the isolation
 * boundary — RLS is (doc 03 §4). A guard that is forgotten cannot leak another
 * tenant's data; it can only fail to *further* narrow what RLS already permits.
 */

export const DEFAULT_LOGIN_PATH = "/login";

/** Thrown when an authenticated caller lacks the required role. */
export class AuthorizationError extends Error {
  readonly status = 403 as const;
  constructor(
    readonly required: readonly JwtRole[],
    readonly actual: JwtRole
  ) {
    super(
      `Forbidden: role '${actual}' is not permitted (requires one of: ${required.join(", ")}).`
    );
    this.name = "AuthorizationError";
  }
}

/**
 * Require an authenticated caller with valid tenant claims. Redirects to
 * `loginPath` otherwise (redirect() throws, so the return type is honoured).
 */
export async function requireAuth(
  loginPath: string = DEFAULT_LOGIN_PATH
): Promise<SessionClaims> {
  const claims = await getClaims();
  if (!claims) redirect(loginPath);
  return claims;
}

/**
 * Require the caller's role to be one of `roles`. Authenticates first
 * (redirects if not), then throws AuthorizationError if the role is not allowed.
 */
export async function requireRole(
  ...roles: [JwtRole, ...JwtRole[]]
): Promise<SessionClaims> {
  const claims = await requireAuth();
  if (!roles.includes(claims.role)) {
    throw new AuthorizationError(roles, claims.role);
  }
  return claims;
}

/**
 * Require tenant STAFF (agency_admin | operator) — the roles that run modules.
 * Excludes client_viewer (read-only dashboard) and platform_owner (which holds
 * no tenant authority). The default gate for the operator console.
 */
export async function requireOperator(): Promise<SessionClaims> {
  const claims = await requireAuth();
  if (!isStaffRole(claims.role)) {
    throw new AuthorizationError([...STAFF_ROLES_FOR_ERROR], claims.role);
  }
  return claims;
}

const STAFF_ROLES_FOR_ERROR = ["agency_admin", "operator"] as const;
