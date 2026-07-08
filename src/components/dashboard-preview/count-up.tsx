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
 * `CountUpValue` accepts the already-formatted display string (e.g. "3,412",
 * "#2", "+16", "4.8") and re-formats each animation frame with the source's
 * own grouping/decimals, so the resolved frame is byte-identical to the input.
 */

import * as React from "react";
import { useReducedMotion } from "@/components/moments";

/**
 * Animate 0 → target; returns `target` immediately under reduced motion/SSR.
 * `delay` (ms) holds at 0 before starting — the entrance choreography uses it
 * so a tile's number resolves AFTER the tile has landed (`counterDelayMs`).
 * Under reduced motion the delay is ignored: final state, instantly.
 */
export function useCountUp(target: number, duration = 950, delay = 0): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = React.useState(0);

  React.useEffect(() => {
    if (reduced) return; // final state is derived below; nothing to animate
    let raf = 0;
    const start = performance.now() + Math.max(0, delay);
    // Ease-out cubic — decisive then settling, same curve as the gauge.
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      setShown(target * ease(t));
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
