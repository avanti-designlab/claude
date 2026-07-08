import { redirect } from "next/navigation";

import { AppTopBar } from "@/components/app-shell/app-top-bar";
import { LOGIN_PATH } from "@/components/app-shell/nav";
import { getSession } from "@/lib/auth/session";

/**
 * The authenticated app shell. Everything under this route group
 * (/onboarding, /clients, …) is server-gated HERE: we read the VERIFIED
 * session and redirect to /login when there is no verified tenant claim —
 * i.e. unauthenticated OR authenticated-without-membership (the auth hook
 * mints no tenant claims in that case, so `claims` is null — fail closed).
 *
 * This is a convenience gate above the real boundary (RLS, doc 03 §4): a
 * forgotten guard could never leak another tenant's data, because every query
 * these pages run is tenant-scoped in the database regardless.
 *
 * We use `getSession()` (not just `requireAuth()`) because the top bar shows
 * the caller's email alongside the tenant/role — all three read from the
 * signature-verified claims, never from client input.
 */
export default async function AppShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session || !session.claims) {
    redirect(LOGIN_PATH);
  }

  return (
    <div className="flex min-h-full flex-col">
      <AppTopBar
        email={session.user.email}
        role={session.claims.role}
        tenantId={session.claims.tenantId}
      />
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
