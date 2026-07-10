import { redirect } from "next/navigation";

import { AppSidebar } from "@/components/app-shell/app-sidebar";
import { AppTopBar } from "@/components/app-shell/app-top-bar";
import { ClientShell } from "@/components/app-shell/client-shell";
import { LOGIN_PATH } from "@/components/app-shell/nav";
import { getSession } from "@/lib/auth/session";

/**
 * The authenticated app shell. Everything under this route group
 * (/dashboard, /clients, the studios, …) is server-gated HERE: we read the
 * VERIFIED session and redirect to /login when there is no verified tenant
 * claim — i.e. unauthenticated OR authenticated-without-membership (the auth
 * hook mints no tenant claims in that case, so `claims` is null — fail closed).
 *
 * This is a convenience gate above the real boundary (RLS, doc 03 §4): a
 * forgotten guard could never leak another tenant's data, because every query
 * these pages run is tenant-scoped in the database regardless.
 *
 * ROLE-AWARE CHROME. The shell itself splits by role:
 *  - staff (agency_admin / operator / platform_owner) get the OPERATOR shell —
 *    the persistent sidebar (desktop) + top bar (identity/role/sign-out) with
 *    the full studios/operations navigation.
 *  - a `client_viewer` gets the brand-free CLIENT shell — no operator nav, no
 *    platform wordmark (doc 06 §3). The operator routes additionally redirect
 *    that role to their own report (see access.ts), so they are confined to the
 *    client-facing surface even by direct URL.
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

  if (session.claims.role === "client_viewer") {
    return <ClientShell>{children}</ClientShell>;
  }

  return (
    <div className="flex min-h-full">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopBar
          email={session.user.email}
          role={session.claims.role}
          tenantId={session.claims.tenantId}
        />
        <main className="flex flex-1 flex-col">{children}</main>
      </div>
    </div>
  );
}
