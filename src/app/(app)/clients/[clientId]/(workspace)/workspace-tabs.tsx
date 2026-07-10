"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/theme/utils";
import { WORKSPACE_TABS } from "./tabs";

/**
 * The client-workspace tab bar. A ROUTED tab set (each tab is a real,
 * server-rendered page), not client-side tab switching — so every tab is
 * directly reachable and deep-linkable. usePathname marks the active tab; the
 * row scrolls horizontally on narrow screens so all ten stay reachable without
 * overflowing the page. Utilitarian, no motion (operator surface).
 */
export function WorkspaceTabs({ clientId }: { clientId: string }) {
  const pathname = usePathname();
  const base = `/clients/${clientId}`;

  return (
    <div className="-mb-px overflow-x-auto">
      <nav
        aria-label="Client workspace"
        className="flex min-w-max items-center gap-1 border-b border-border"
      >
        {WORKSPACE_TABS.map((tab) => {
          const href = `${base}/${tab.segment}`;
          const active = pathname === href;
          return (
            <Link
              key={tab.segment}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative whitespace-nowrap px-3 py-2.5 text-sm transition-colors outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring/60",
                active
                  ? "font-medium text-ink"
                  : "text-muted hover:text-ink",
              )}
            >
              {tab.label}
              {active ? (
                <span
                  aria-hidden
                  className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent"
                />
              ) : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
