"use client";

/**
 * DESIGN PREVIEW — the Visibility Score as a gauge (the "resolve" moment,
 * doc 06 §2/§4.2, adapted to the operator's Spendex craft): a Core Blue arc
 * fills in while a THIN big number counts up out of noise. Reduced motion (and
 * SSR) render the final, resolved state instantly — zero layout shift.
 *
 * A preview target M19 will match, not the frozen moment component; it reuses
 * the frozen reduced-motion gate so it behaves consistently with the system.
 * The arc + number are token-driven (Core Blue = --accent), so the gauge
 * re-skins per tenant.
 */

import * as React from "react";
import { useReducedMotion } from "@/components/moments";
import { cn } from "@/lib/theme/utils";

export interface VisibilityGaugeProps {
  /** Resolved score, 0–100. */
  score: number;
  label?: string;
  caption?: string;
  /** Remount key surface: change it (e.g. a "replay" counter) to re-run. */
  replayKey?: number;
  className?: string;
}

/** Gauge geometry: a 240° sweep with a 120° gap at the bottom. */
const CENTER = 110;
const RADIUS = 92;
const START_DEG = 240; // bottom-left, measured clockwise from 12 o'clock
const SWEEP_DEG = 240;

/** Clock degrees from 12 o'clock, clockwise, to SVG coordinates. */
function polar(deg: number) {
  const rad = (deg * Math.PI) / 180;
  return {
    x: CENTER + RADIUS * Math.sin(rad),
    y: CENTER - RADIUS * Math.cos(rad),
  };
}

function arcPath(startDeg: number, endDeg: number) {
  const a = polar(startDeg);
  const b = polar(endDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

const TRACK = arcPath(START_DEG, START_DEG + SWEEP_DEG);

export function VisibilityGauge({
  score,
  label = "Visibility score",
  caption,
  replayKey = 0,
  className,
}: VisibilityGaugeProps) {
  const target = Math.round(Math.min(100, Math.max(0, score)));
  return (
    <GaugePass
      key={`${target}:${replayKey}`}
      target={target}
      label={label}
      caption={caption}
      className={className}
    />
  );
}

function GaugePass({
  target,
  label,
  caption,
  className,
}: {
  target: number;
  label: string;
  caption?: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  // Animation state only; the reduced/SSR path renders `target` directly, so
  // no state is ever written synchronously in the effect (no cascading render).
  const [shown, setShown] = React.useState(0);

  React.useEffect(() => {
    if (reduced) return; // final state is derived below; nothing to animate
    let raf = 0;
    const DURATION = 1100;
    const start = performance.now();
    // Ease-out cubic — decisive then settling, like a value resolving.
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      setShown(Math.round(target * ease(t)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced, target]);

  const display = reduced ? target : shown;
  const pct = display / 100;

  return (
    <div className={cn("relative flex flex-col items-center", className)}>
      <div className="relative">
        <svg
          viewBox="0 0 220 210"
          className="w-[248px] max-w-full"
          role="img"
          aria-label={`${label}: ${target} out of 100`}
        >
          <path
            d={TRACK}
            fill="none"
            stroke="color-mix(in oklab, var(--ink) 10%, transparent)"
            strokeWidth={14}
            strokeLinecap="round"
          />
          <path
            d={TRACK}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={14}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray="100"
            strokeDashoffset={100 - pct * 100}
            style={{ transition: reduced ? undefined : "stroke-dashoffset 90ms linear" }}
          />
        </svg>

        {/* Center readout — thin big number over the arc. */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
          <span className="flex items-baseline gap-1">
            <span
              className="font-display text-score leading-none text-ink tabular-nums"
              style={{ fontWeight: 250 }}
            >
              {display}
            </span>
            <span className="font-mono text-sm text-muted">/100</span>
          </span>
          <span className="font-mono text-[10px] tracking-[0.18em] text-muted uppercase">
            {label}
          </span>
        </div>
      </div>

      {caption ? (
        <p
          className={cn(
            "mt-1 text-sm text-muted transition-opacity duration-500",
            display >= target ? "opacity-100" : "opacity-0"
          )}
        >
          {caption}
        </p>
      ) : null}
    </div>
  );
}
