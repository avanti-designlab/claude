import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { tryGetPublicSupabaseConfig } from "@/lib/env";

/**
 * Supabase session refresh for Next middleware (the @supabase/ssr middleware
 * pattern). Its ONE job is to refresh the auth session on each request: read
 * the cookies, let supabase rotate an expired access token, and write the
 * refreshed cookies onto both the forwarded request and the response.
 *
 * There is DELIBERATELY no authorization logic here. Middleware runs on every
 * matched request in the Edge runtime and is the wrong place to make access
 * decisions — authz lives in the per-route guards (src/lib/auth/guards.ts) and,
 * definitively, in RLS (doc 03 §4). Keeping middleware to "refresh only" avoids
 * the classic footgun where a stale/edge-cached middleware check is mistaken
 * for the security boundary.
 */
export async function updateSession(
  request: NextRequest
): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  // Fail CLOSED, not 500: middleware runs on every matched request. If the
  // public Supabase config isn't provisioned there is no session to refresh, so
  // pass the request through untouched rather than throwing and crashing it
  // before any page can render. (Env-set behavior below is unchanged.)
  const config = tryGetPublicSupabaseConfig();
  if (!config) return response;
  const { url, anonKey } = config;
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // Touch the auth server to refresh/rotate the session if needed. Must run
  // right after client creation, with nothing between — the @supabase/ssr
  // contract for cookie propagation. getUser() verifies against the auth
  // server; it is used here purely for its refresh side effect, not for authz.
  await supabase.auth.getUser();

  return response;
}
