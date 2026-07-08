/**
 * Entrance choreography — the brand's motion signature for page load / route
 * entry (operator direction, 2026-07-08: "immersive and live — how the boxes
 * load and numbers move"). ADDITIVE to the moments module: route entry is a
 * key state transition (doc 06 §4 moment #5), and keeping it here preserves
 * the invariant that ALL high-impact motion lives in src/components/moments.
 *
 * The choreography (one orchestrated entrance per page load, no
 * scroll-triggering):
 *   1. Cards/tiles stagger in — rise 14px + fade, 520ms each, premium
 *      ease-out `cubic-bezier(0.22, 1, 0.36, 1)`, 90ms between siblings.
 *   2. Section headers take the step BEFORE their card grid, so they lead.
 *   3. A hero GlowCard's glow BLOOMS (box-shadow ramp, 800ms) 420ms after its
 *      rise begins — the card lands, then lights.
 *   4. In-tile counters (CountUpValue, VisibilityGauge) start ~400ms after
 *      their tile's rise begins (`counterDelayMs`) — sequenced, never
 *      simultaneous chaos.
 * Dense tables/forms stay OUT of the choreography (they appear instantly, as
 * always).
 *
 * Mechanism: pure CSS (`.entrance-item` in globals.css) with a per-element
 * `--entrance-delay`. Server and client render IDENTICAL markup (no
 * hydration mismatch); the animation plays even before/without JS; only
 * opacity/transform animate (zero layout shift); `backwards` fill releases
 * the properties after the run. Reduced motion renders the final state
 * instantly through BOTH gates: the OS `prefers-reduced-motion` media query
 * (CSS) and the design-system force-toggle via `:root[data-motion="reduced"]`
 * — the same policy as the frozen useReducedMotion hook, expressed in CSS so
 * the wrapper stays server-renderable.
 */

import type { CSSProperties, ElementType, HTMLAttributes } from "react";
import { cn } from "@/lib/theme/utils";

/** Stagger between sibling steps (ms). */
export const ENTRANCE_STAGGER_MS = 90;
/** One element's rise duration (ms). */
export const ENTRANCE_DURATION_MS = 520;
/** The premium ease-out curve (documented; the value lives in globals.css). */
export const ENTRANCE_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
/** How long after a tile's rise begins its in-tile counters may start (ms). */
export const ENTRANCE_SETTLE_MS = 400;
/** Bloom starts this long after its card's rise begins (ms). */
export const ENTRANCE_BLOOM_DELAY_MS = 420;

/** Delay for entrance step `step` (0-based). */
export function entranceDelayMs(step: number): number {
  return Math.max(0, Math.round(step)) * ENTRANCE_STAGGER_MS;
}

/**
 * When a counter inside the tile at entrance step `step` should start —
 * after the tile has visibly landed.
 */
export function counterDelayMs(step: number): number {
  return entranceDelayMs(step) + ENTRANCE_SETTLE_MS;
}

export interface EntranceProps extends HTMLAttributes<HTMLElement> {
  /** 0-based step in the page's choreography; delay = step × 90ms. */
  step?: number;
  /** Explicit delay in ms (overrides `step`). */
  delayMs?: number;
  /** Wrapper element (default div). */
  as?: ElementType;
}

/**
 * Staggered-reveal wrapper. Wrap each card/tile/header in the page's load
 * choreography; pass consecutive `step` values in reading order. Works in
 * server AND client components (no hooks, no state).
 */
export function Entrance({
  step = 0,
  delayMs,
  as: Tag = "div",
  className,
  style,
  children,
  ...rest
}: EntranceProps) {
  const ms = delayMs ?? entranceDelayMs(step);
  return (
    <Tag
      className={cn("entrance-item", className)}
      style={{ "--entrance-delay": `${ms}ms`, ...style } as CSSProperties}
      {...rest}
    >
      {children}
    </Tag>
  );
}
