"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { isNavItemActive } from "@/components/app-shell/nav";
import { cn } from "@/lib/theme/utils";
import { WORKSPACE_TABS } from "./tabs";

/**
 * The client-workspace tab bar. A ROUTED tab set (each tab is a real,
 * server-rendered page), not client-side tab switching — so every tab is
 * directly reachable and deep-linkable. Utilitarian, no motion (operator
 * surface).
 *
 * ACTIVE STATE uses the shared `isNavItemActive` prefix test (same helper the
 * sidebar uses), so a future sub-route under a tab (e.g. an audit-detail page)
 * still lights up its parent tab. No tab href is a prefix of another (the test
 * requires a trailing "/"), so the row never lights two tabs at once.
 *
 * OVERFLOW: the ten-tab row scrolls horizontally on narrow screens. On mount we
 * scroll the active tab into view (instant — no motion) so the current tab is
 * never hidden off-screen, and a fade cue appears on whichever edge still has
 * tabs beyond it.
 */
export function WorkspaceTabs({ clientId }: { clientId: string }) {
  const pathname = usePathname();
  const base = `/clients/${clientId}`;

  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  // Which edges still have tabs beyond them — drives the fade cues. Refs + a
  // functional setter that bails on no-change, so scroll ticks don't re-render
  // the bar when the cues haven't actually flipped.
  const updateEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft < maxScroll - 1;
    setEdges((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end },
    );
  }, []);

  useEffect(() => {
    // Reveal the active tab on mount/route change (instant scroll, no smooth
    // motion), then measure. A ResizeObserver keeps the cues honest on resize —
    // watching BOTH the scroll container and the inner nav, so a content-width
    // change without a container resize (e.g. a webfont swap after mount)
    // refreshes the cues too.
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateEdges();
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [pathname, updateEdges]);

  return (
    <div className="relative -mb-px">
      <div ref={scrollRef} onScroll={updateEdges} className="overflow-x-auto">
        <nav
          aria-label="Client workspace"
          className="flex min-w-max items-center gap-1 border-b border-border"
        >
          {WORKSPACE_TABS.map((tab) => {
            const href = `${base}/${tab.segment}`;
            const active = isNavItemActive(pathname, href);
            return (
              <Link
                key={tab.segment}
                ref={active ? activeRef : undefined}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative whitespace-nowrap px-3 py-2.5 text-sm transition-colors outline-none",
                  "focus-visible:ring-2 focus-visible:ring-ring/60",
                  active ? "font-medium text-ink" : "text-muted hover:text-ink",
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

      {/* Edge fade cues — rendered only when the row overflows past that side,
          so the operator can tell tabs continue off-screen. No motion. */}
      {edges.start ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-surface to-transparent"
        />
      ) : null}
      {edges.end ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface to-transparent"
        />
      ) : null}
    </div>
  );
}
