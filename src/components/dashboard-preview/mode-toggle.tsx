"use client";

/**
 * The app's STANDARD mode toggle (consolidation, 2026-07-08). It drives the
 * same mechanism everything else respects: setting `data-theme` on <html>
 * ("light" | "dark") overrides the OS `prefers-color-scheme` — exactly the
 * override contract the Signal token blocks in globals.css and the operator
 * dual-mode emission share. No theme swap, no route param: one attribute.
 *
 * SSR renders both pills inactive (the server cannot know the OS
 * preference); the effective mode comes from a useSyncExternalStore
 * subscription to the OS media query (plus any pre-set `data-theme`), so
 * there is no hydration mismatch and no setState-in-effect — the toggle is
 * presentation, the palette itself is applied by CSS before any JS runs.
 */

import * as React from "react";
import { cn } from "@/lib/theme/utils";

export type ThemeMode = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeToOsMode(onChange: () => void): () => void {
  const mql = window.matchMedia(DARK_QUERY);
  mql.addEventListener?.("change", onChange);
  return () => mql.removeEventListener?.("change", onChange);
}

/** Effective mode right now: a forced data-theme wins, else the OS. */
function getSnapshot(): ThemeMode {
  const forced = document.documentElement.dataset.theme;
  if (forced === "light" || forced === "dark") return forced;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function getServerSnapshot(): ThemeMode | null {
  return null; // unknown on the server — no pill reads active until mount
}

export interface ModeToggleProps {
  /**
   * Pill labels. The default is plain "Light" / "Dark" — this toggle is global
   * chrome on quiet operator surfaces, so its copy names the mode, not an
   * effect. The preview page passes its own "Dark glow" label explicitly (the
   * glow is that page's showpiece, not a product-wide promise).
   */
  labels?: Record<ThemeMode, string>;
  className?: string;
}

export function ModeToggle({
  labels = { light: "Light", dark: "Dark" },
  className,
}: ModeToggleProps) {
  const ambient = React.useSyncExternalStore(
    subscribeToOsMode,
    getSnapshot,
    getServerSnapshot
  );
  const [forced, setForced] = React.useState<ThemeMode | null>(null);

  // Apply the user's choice through the standard mechanism (an effect owns
  // the DOM write; state owns the choice).
  React.useEffect(() => {
    if (forced) {
      document.documentElement.dataset.theme = forced;
    }
  }, [forced]);

  const mode = forced ?? ambient;

  const pill = (active: boolean) =>
    cn(
      "rounded-full px-3 py-1 text-xs font-medium transition-colors duration-200",
      "outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
      active ? "bg-ink text-surface" : "text-muted hover:text-ink"
    );

  return (
    <div
      role="group"
      aria-label="Color mode"
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-full border border-border p-0.5",
        className
      )}
    >
      {(["light", "dark"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          onClick={() => setForced(value)}
          className={pill(mode === value)}
        >
          {labels[value]}
        </button>
      ))}
    </div>
  );
}
