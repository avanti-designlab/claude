"use client";

/**
 * The ONE reduced-motion gate for the design system (doc 06 §4, §7).
 *
 * Every animated moment consults `useReducedMotion()` and, when it returns
 * true, renders the final state instantly — no animation, no intermediate
 * frames. The hook combines:
 *
 * 1. an explicit override from `ReducedMotionProvider` (the /design-system
 *    reduced-motion toggle, tests, previews), and
 * 2. the OS-level `prefers-reduced-motion: reduce` media query.
 *
 * On the server (and before hydration) the answer is `true` — the safe
 * default is the fully-resolved final state, so content is never hidden
 * behind an animation that may not run.
 */

import * as React from "react";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Structural type so the logic is testable without a DOM. */
export interface MediaQueryLike {
  matches: boolean;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
  /** Legacy API (older Safari). */
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
}

/** Current state of a media query; no query object (SSR) = reduce motion. */
export function reducedMotionSnapshot(mql: MediaQueryLike | null | undefined): boolean {
  return mql?.matches ?? true;
}

/**
 * Subscribe to a media query across the modern and legacy listener APIs.
 * Returns the unsubscribe function.
 */
export function subscribeToMediaQuery(
  mql: MediaQueryLike | null | undefined,
  onChange: () => void
): () => void {
  if (!mql) return () => {};
  if (mql.addEventListener && mql.removeEventListener) {
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }
  if (mql.addListener && mql.removeListener) {
    mql.addListener(onChange);
    return () => mql.removeListener?.(onChange);
  }
  return () => {};
}

/** Override wins; otherwise the system preference decides. */
export function resolveReducedMotion(
  override: boolean | null,
  systemPrefersReduced: boolean
): boolean {
  return override ?? systemPrefersReduced;
}

const ReducedMotionOverrideContext = React.createContext<boolean | null>(null);

export interface ReducedMotionProviderProps {
  /**
   * true = force reduced (instant final states), false = force motion,
   * null/undefined = follow the OS preference.
   */
  force?: boolean | null;
  children: React.ReactNode;
}

/** Scope-level override, used by the /design-system toggle and tests. */
export function ReducedMotionProvider({ force = null, children }: ReducedMotionProviderProps) {
  return (
    <ReducedMotionOverrideContext.Provider value={force}>
      {children}
    </ReducedMotionOverrideContext.Provider>
  );
}

function getQuery(): MediaQueryLike | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

function subscribe(onStoreChange: () => void): () => void {
  return subscribeToMediaQuery(getQuery(), onStoreChange);
}

function getSnapshot(): boolean {
  return reducedMotionSnapshot(getQuery());
}

function getServerSnapshot(): boolean {
  return true;
}

/**
 * True when animation must be skipped and the final state rendered
 * immediately. Every moment in src/components/moments consults this.
 */
export function useReducedMotion(): boolean {
  const override = React.useContext(ReducedMotionOverrideContext);
  const system = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return resolveReducedMotion(override, system);
}
