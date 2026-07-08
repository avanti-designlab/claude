import { type NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

/**
 * Root middleware: refresh the Supabase auth session on each request so server
 * components + route handlers see a fresh token. Refresh ONLY — no
 * authorization here (that is the guards' + RLS's job; see
 * src/lib/supabase/middleware.ts).
 */
export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  /**
   * Run on all paths EXCEPT Next internals and static assets — those never
   * carry an auth session to refresh, and touching them wastes an auth-server
   * round-trip. Adjust as public routes are added.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?|ttf)$).*)",
  ],
};
