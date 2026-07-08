/**
 * Auth foundation — CLIENT-SAFE surface only.
 *
 * This barrel re-exports ONLY the pure claim types + helpers (parse-claims), so
 * a client component can share the `SessionClaims` shape without dragging
 * server-only code into the client bundle.
 *
 * The SERVER helpers are "server-only" / "use server" and must be imported
 * directly from their modules in server code:
 *   import { getSession, getClaims, getAuthUser } from "@/lib/auth/session";
 *   import { requireAuth, requireOperator, requireRole } from "@/lib/auth/guards";
 *   import { signIn, signOut } from "@/lib/auth/actions";
 */
export {
  parseSessionClaims,
  isJwtRole,
  isStaffRole,
  STAFF_ROLES,
  type SessionClaims,
  type StaffRole,
} from "./parse-claims";
