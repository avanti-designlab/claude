import "server-only";

import { notFound, redirect } from "next/navigation";

import { getClaims } from "@/lib/auth/session";
import type { SessionClaims } from "@/lib/auth/parse-claims";

/**
 * Role-awareness for the app shell (server-only). Import-reads the frozen auth
 * layer (`getClaims`) — it never widens scope; RLS below stays the real
 * boundary. This module answers one question for the operator surfaces: is the
 * caller allowed here, and if not, where do they belong?
 *
 * The rule (task IA + doc 06 §3): agency_admin / operator / platform_owner see
 * the full operator app; a `client_viewer` is confined to their own white-label
 * report at `/clients/[clientId]/dashboard` and never the operator studios.
 */

/**
 * The one surface a client_viewer may see: their own client report. A viewer
 * always carries a `client_id` claim (minted server-side by the auth hook for
 * that role); the fallback only guards a malformed token.
 */
export function clientViewerHome(
  claims: Pick<SessionClaims, "clientId"> | null,
): string | null {
  return claims?.clientId ? `/clients/${claims.clientId}/dashboard` : null;
}

/**
 * Gate an OPERATOR surface. A client_viewer is redirected to their own report
 * (or 404s if their token carries no client). Staff roles pass straight
 * through. Call at the top of an operator page, or once in a group layout to
 * cover every child. Returns the verified claims for convenience (may be null
 * only in the env-unset boot path, which the shell already fails closed on).
 */
export async function guardOperatorSurface(): Promise<SessionClaims | null> {
  const claims = await getClaims();
  if (claims?.role === "client_viewer") {
    const home = clientViewerHome(claims);
    if (home) redirect(home);
    notFound();
  }
  return claims;
}
