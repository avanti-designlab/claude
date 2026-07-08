import Link from "next/link";
import { LogOutIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { JwtRole } from "@/lib/types/db";
import { signOutAndRedirect } from "./actions";
import { APP_HOME, APP_NAV } from "./nav";

/**
 * The authenticated shell's top bar. Everything it renders about "who you are"
 * comes from the VERIFIED session (`getSession()` in the layout) — the tenant,
 * role, and email are read from the signature-verified JWT claims minted
 * server-side by the auth hook, NEVER from client-supplied state. It is
 * deliberately utilitarian (operator surface): quiet, token-driven, no glow.
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
}

export function AppTopBar({ email, role, tenantId }: AppTopBarProps) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface/85 backdrop-blur supports-[backdrop-filter]:bg-surface/70">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-3 sm:px-6">
        <Link
          href={APP_HOME}
          className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <span className="flex size-6 items-center justify-center rounded-md bg-accent">
            <span className="size-2 rounded-[3px] bg-accent-foreground" />
          </span>
          <span className="font-display text-base font-bold text-ink">Signal</span>
        </Link>

        <nav className="hidden items-center gap-1 sm:flex" aria-label="Primary">
          {APP_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-overlay hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden flex-col items-end leading-tight sm:flex">
            {email ? (
              <span className="max-w-[16rem] truncate text-sm text-ink">
                {email}
              </span>
            ) : null}
            <span
              className="font-mono text-[10px] tracking-wide text-muted uppercase"
              title={`Tenant ${tenantId}`}
            >
              Tenant {tenantId.slice(0, 8)}
            </span>
          </div>
          <Badge variant="secondary" className="shrink-0">
            {ROLE_LABEL[role]}
          </Badge>
          <form action={signOutAndRedirect}>
            <Button type="submit" variant="outline" size="sm">
              <LogOutIcon aria-hidden /> Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
