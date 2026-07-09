"use client";

/**
 * DESIGN PREVIEW primitive — an animated count-up for the big numbers
 * (operator direction, 2026-07-08: "more interactive" — the stat tiles' and
 * highlight panels' numbers resolve like the Visibility Score does).
 *
 * Same contract as the gauge's counter: reduced motion (and SSR) render the
 * FINAL value instantly — the animation is flavor, never a gate on content.
 * Ease-out cubic over ~950ms, matching the resolve moment's feel.
 *
 * Two run kinds (design review, 2026-07-09, Minor 6):
 *  - FIRST mount: 0 → target after the entrance delay — the approved preview
 *    choreography, unchanged.
 *  - RETARGET: the target changed under a LIVE component (e.g.
 *    router.refresh() reconciling fresh counts after "Generate plan"). The
 *    number animates from the value already on screen, with NO entrance
 *    delay — never a replay from 0 (a momentary false zero) followed by
 *    dead air.
 *
 * `CountUpValue` accepts the already-formatted display string (e.g. "3,412",
 * "#2", "+16", "4.8") and re-formats each animation frame with the source's
 * own grouping/decimals, so the resolved frame is byte-identical to the input.
 */

import * as React from "react";
import { useReducedMotion } from "@/components/moments";

/** How one animation run starts (see `countUpRun`). */
export interface CountUpRun {
  /** The value the run animates from. */
  from: number;
  /** How long to hold at `from` before animating (ms). */
  delayMs: number;
}

/**
 * Decide a run's start point and delay — pure, unit-tested. `prevTarget` is
 * the target of the previous run, or null before any run. The first mount
 * keeps the preview contract (from 0, holding through the entrance delay);
 * note a strict-mode effect replay re-runs with prevTarget === target and
 * must ALSO resolve as a first mount, so "retarget" means the target
 * actually CHANGED. A retarget starts from `shownNow` — the value currently
 * painted, which is mid-flight when a refresh lands during an animation —
 * with no delay.
 */
export function countUpRun(
  prevTarget: number | null,
  target: number,
  shownNow: number,
  entranceDelayMs: number
): CountUpRun {
  const retarget = prevTarget !== null && prevTarget !== target;
  return retarget
    ? { from: shownNow, delayMs: 0 }
    : { from: 0, delayMs: Math.max(0, entranceDelayMs) };
}

/**
 * Animate to `target`; returns `target` immediately under reduced motion/SSR.
 * `delay` (ms) holds before the FIRST run — the entrance choreography uses it
 * so a tile's number resolves AFTER the tile has landed (`counterDelayMs`);
 * retargets skip it (see `countUpRun`). Under reduced motion both the delay
 * and the animation are ignored: final state, instantly.
 */
export function useCountUp(target: number, duration = 950, delay = 0): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = React.useState(0);
  // What is currently painted (state, mirrored for effect reads) and the
  // previous run's target — the inputs that make a retarget start where the
  // last run left off instead of replaying from 0.
  const shownRef = React.useRef(0);
  const prevTargetRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (reduced) {
      // Final state is derived below; keep the refs truthful so a later
      // switch to motion doesn't animate from a stale point.
      shownRef.current = target;
      prevTargetRef.current = target;
      return;
    }
    const run = countUpRun(prevTargetRef.current, target, shownRef.current, delay);
    prevTargetRef.current = target;
    let raf = 0;
    const start = performance.now() + run.delayMs;
    // Ease-out cubic — decisive then settling, same curve as the gauge.
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      const value = run.from + (target - run.from) * ease(t);
      shownRef.current = value;
      setShown(value);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced, target, duration, delay]);

  return reduced ? target : shown;
}

/** Split "prefix number suffix" out of a formatted value like "#2" or "+16pts". */
const NUMERIC_PART = /^([^0-9]*)(\d[\d,]*(?:\.\d+)?)(.*)$/;

export interface CountUpValueProps {
  /** Pre-formatted display value, e.g. "3,412", "34", "#2", "+16", "4.8". */
  value: string;
  /** Start delay in ms (entrance sequencing); ignored under reduced motion. */
  delay?: number;
  className?: string;
}

export function CountUpValue({ value, delay = 0, className }: CountUpValueProps) {
  const match = value.match(NUMERIC_PART);
  const prefix = match?.[1] ?? "";
  const numeric = match?.[2] ?? null;
  const suffix = match?.[3] ?? "";

  const target = numeric ? Number.parseFloat(numeric.replace(/,/g, "")) : 0;
  const decimals = numeric?.split(".")[1]?.length ?? 0;
  const grouped = numeric?.includes(",") ?? false;

  const shown = useCountUp(target, 950, delay);

  if (!numeric || !Number.isFinite(target)) {
    // Nothing numeric to animate — render verbatim.
    return <span className={className}>{value}</span>;
  }

  const formatted = shown.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouped,
  });

  return (
    <span className={className}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}
