import { LogOutIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/dashboard-preview";
import type { JwtRole } from "@/lib/types/db";
import { signOutAndRedirect } from "./actions";
import { AppMobileNav } from "./app-mobile-nav";
import { Wordmark } from "./wordmark";

/**
 * The operator shell's top bar. Everything it renders about "who you are" comes
 * from the VERIFIED session (`getSession()` in the layout) — the tenant, role,
 * and email are read from the signature-verified JWT claims minted server-side
 * by the auth hook, NEVER from client-supplied state. Deliberately utilitarian
 * (operator surface): quiet, token-driven, no glow.
 *
 * Primary navigation lives in the sidebar (desktop) and the mobile Sheet (this
 * bar hosts the Sheet trigger + a compact wordmark below `lg`, where the
 * sidebar is hidden). Only staff roles ever see this bar; a client_viewer gets
 * the brand-free client shell instead (see the (app) layout).
 */

const ROLE_LABEL: Record<JwtRole, string> = {
  platform_owner: "Platform owner",
  agency_admin: "Agency admin",
  operator: "Operator",
  client_viewer: "Client viewer",
};

export interface AppTopBarProps {
  email: string | null;
  role: JwtRole;
  tenantId: string;
  /**
   * The agency (tenant) display name, read RLS-scoped in the (app) layout. Null
   * when the read failed or env is unset — we fall back to the short id rather
   * than crash or invent a name.
   */
  tenantName: string | null;
}

export function AppTopBar({ email, role, tenantId, tenantName }: AppTopBarProps) {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-surface/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-surface/70 sm:px-6">
      {/* Below lg the sidebar is hidden: the menu trigger + wordmark stand in. */}
      <div className="flex items-center gap-2 lg:hidden">
        <AppMobileNav />
        <Wordmark />
      </div>

      <div className="ml-auto flex items-center gap-3">
        <div className="hidden flex-col items-end leading-tight sm:flex">
          {email ? (
            <span className="max-w-[16rem] truncate text-sm text-ink">
              {email}
            </span>
          ) : null}
          {/* The agency name — real identity, not a raw tenant UUID. The full id
              stays in the tooltip for support. Null name → the short id. */}
          {tenantName ? (
            <span
              className="max-w-[16rem] truncate text-xs text-muted"
              title={`Tenant ${tenantId}`}
            >
              {tenantName}
            </span>
          ) : (
            <span
              className="font-mono text-[10px] tracking-wide text-muted uppercase"
              title={`Tenant ${tenantId}`}
            >
              {tenantId.slice(0, 8)}
            </span>
          )}
        </div>
        {/* Global color-mode toggle — one instance for every operator page. It
            drives the shared data-theme mechanism. This bar never renders for
            a client_viewer; their toggle lives on the M19 report page itself
            (their only surface). Hidden below sm, where it lives in the mobile
            nav sheet instead. */}
        <ModeToggle className="hidden sm:flex" />
        <Badge variant="secondary" className="shrink-0">
          {ROLE_LABEL[role]}
        </Badge>
        <form action={signOutAndRedirect}>
          <Button type="submit" variant="outline" size="sm">
            <LogOutIcon aria-hidden /> Sign out
          </Button>
        </form>
      </div>
    </header>
  );
}
