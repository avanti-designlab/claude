"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/theme/utils";
import { APP_HOME } from "./nav";
import {
  type AppNavGroup,
  type AppNavItem,
  isNavItemActive,
  OPERATOR_NAV,
  OPERATOR_NAV_FOOTER,
} from "./nav";
import { Wordmark } from "./wordmark";

/**
 * The persistent operator sidebar (desktop `lg+`). It is the app's primary
 * navigation: the Signal wordmark, the grouped studios/operations nav, and the
 * workspace-administration links (Connections, Settings) pinned to the foot.
 * Client component only because it reads
 * `usePathname` to mark the active route — no data, no motion. Token-driven, so
 * it re-skins with the tenant theme exactly like the rest of the app.
 *
 * A `client_viewer` never reaches this component (the (app) layout renders a
 * brand-free client shell for that role) — this is an operator-only surface.
 */
export function AppSidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col self-start border-r border-border bg-surface lg:flex">
      <div className="flex h-16 items-center border-b border-border px-5">
        <Link
          href={APP_HOME}
          className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          aria-label="Signal home"
        >
          <Wordmark />
        </Link>
      </div>
      <nav
        aria-label="Primary"
        className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-5"
      >
        {OPERATOR_NAV.map((group, i) => (
          <NavGroup key={group.label ?? `group-${i}`} group={group} pathname={pathname} />
        ))}
      </nav>
      <div className="border-t border-border px-3 py-4">
        {OPERATOR_NAV_FOOTER.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}
      </div>
    </aside>
  );
}

function NavGroup({
  group,
  pathname,
}: {
  group: AppNavGroup;
  pathname: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      {group.label ? (
        <p className="px-3 pb-1 font-mono text-[10px] font-medium tracking-[0.16em] text-muted uppercase">
          {group.label}
        </p>
      ) : null}
      {group.items.map((item) => (
        <NavLink key={item.href} item={item} pathname={pathname} />
      ))}
    </div>
  );
}

export function NavLink({
  item,
  pathname,
  onNavigate,
}: {
  item: AppNavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = isNavItemActive(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring/60",
        active
          ? "bg-overlay font-medium text-ink"
          : "text-muted hover:bg-overlay hover:text-ink",
      )}
    >
      {active ? (
        <span
          aria-hidden
          className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent"
        />
      ) : null}
      {Icon ? (
        <Icon
          aria-hidden
          strokeWidth={2}
          className={cn(
            "size-4 shrink-0 transition-colors",
            active ? "text-accent" : "text-muted group-hover:text-ink",
          )}
        />
      ) : null}
      <span className="truncate">{item.label}</span>
    </Link>
  );
}
