"use server";

import { createClient } from "@/lib/supabase/server";

/**
 * Auth server actions — the plumbing the login UI (a separate slice) calls.
 * This file builds NO UI; it exposes the sign-in / sign-out behaviour.
 *
 * Email + password is the sensible default for a ~30-operator internal tool
 * (no self-serve signup; agency_admins provision users). Magic-link, OTP, or
 * SSO can swap in later by changing ONLY this file + the login form — the
 * claim-minting hook (migration 0007) and RLS are authentication-method
 * agnostic, since they key off the authenticated user id, not how they proved it.
 *
 * These use the cookie-bound server client (src/lib/supabase/server.ts), so a
 * successful sign-in writes the session cookies and sign-out clears them.
 */

export type SignInResult = { ok: true } | { ok: false; error: string };

export async function signIn(credentials: {
  email: string;
  password: string;
}): Promise<SignInResult> {
  const email = credentials.email?.trim();
  const password = credentials.password;
  if (!email || !password) {
    return { ok: false, error: "Email and password are required." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Return a SINGLE generic message rather than the raw Supabase
    // error.message: no vendor string or account-state detail ("email not
    // confirmed", rate-limit text, etc.) should travel to the browser — that is
    // a mild account-enumeration surface. Distinct handling for the
    // validation/"required" case stays above; every auth failure collapses to
    // this one indistinguishable message.
    return {
      ok: false,
      error: "That email and password don't match. Check them and try again.",
    };
  }
  return { ok: true };
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
}
