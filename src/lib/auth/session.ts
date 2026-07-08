import "server-only";

import { createClient } from "@/lib/supabase/server";
import { parseSessionClaims, type SessionClaims } from "./parse-claims";

/**
 * Server-side session + claim readers (Server Components, Route Handlers,
 * Server Actions). These are the ONLY sanctioned way to read who the caller is.
 *
 * SECURITY: they read from supabase's `auth.getClaims()`, which VERIFIES the
 * access-token JWT (asymmetric signature locally, or a server round-trip for
 * legacy symmetric keys) before returning its claims. They deliberately do NOT
 * use supabase's `auth.getSession()`, which returns claims straight from the
 * cookie store without verifying the signature and must never back an
 * authorization decision. The tenant claims themselves are minted server-side
 * by the custom_access_token_hook (migration 0007) from `tenant_users` — never
 * from client input — so a verified token is a trustworthy source of truth.
 */

/** Verified auth identity (no tenant authority on its own). */
export interface AuthUser {
  /** auth.users.id (`sub`). */
  id: string;
  email: string | null;
}

export interface AppSession {
  user: AuthUser;
  /**
   * Verified tenant claims, or null when the user is authenticated but has NO
   * tenant_users membership (the hook minted no tenant claims — fail closed).
   */
  claims: SessionClaims | null;
}

/** Read + verify the raw JWT claims, or null if there is no valid session. */
async function verifiedClaims(): Promise<Record<string, unknown> | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return null;
  return data.claims as Record<string, unknown>;
}

/**
 * Full session view: verified identity + verified tenant claims. Null when
 * unauthenticated. Use this when a page needs both the user and its authority;
 * a null `claims` distinguishes "logged in but no membership" from "logged in
 * with a tenant" so the UI can guide the user (e.g. "ask your admin").
 */
export async function getSession(): Promise<AppSession | null> {
  const raw = await verifiedClaims();
  if (!raw) return null;
  const id = typeof raw.sub === "string" && raw.sub.length > 0 ? raw.sub : null;
  if (!id) return null;
  const email = typeof raw.email === "string" ? raw.email : null;
  return { user: { id, email }, claims: parseSessionClaims(raw) };
}

/**
 * The verified tenant claims the app authorizes against, or null (fail closed)
 * when unauthenticated OR authenticated-without-membership. The primary input
 * to the guards.
 */
export async function getClaims(): Promise<SessionClaims | null> {
  return parseSessionClaims(await verifiedClaims());
}

/** Verified auth identity only (ignores tenant membership). */
export async function getAuthUser(): Promise<AuthUser | null> {
  return (await getSession())?.user ?? null;
}
