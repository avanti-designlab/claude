"use client";

/**
 * DESIGN PREVIEW — the Visibility Score as a gauge (the "resolve" moment,
 * doc 06 §2/§4.2, adapted to the operator's craft): an arc fills in while a
 * BIG BOLD number counts up out of noise. Reduced motion (and SSR) render the
 * final, resolved state instantly — zero layout shift.
 *
 * Three tones so the same gauge reads on any chrome:
 *  - "surface"  — accent arc + ink number, for a quiet card.
 *  - "onAccent" — for a solid accent fill: arc + number use the DERIVED
 *    --accent-foreground (whichever of surface/ink the gate picked against
 *    the accent), never a raw white assumption.
 *  - "hero"     — MODE-AWARE, for the glow hero bubble: in light mode the
 *    bubble is a vivid-blue fill (the onAccent treatment); in dark mode it is
 *    a navy-to-black fill (accent arc + ink number). The flip rides the
 *    standard mode mechanism (`dark:` variant + CSS vars), no JS mode prop.
 * All are token-driven, so the gauge re-skins per tenant. Arc/track strokes
 * read per-tone CSS custom properties so the tone classes (including their
 * dark-mode overrides) fully own the colors.
 *
 * Number weight/scale reverse the earlier thin treatment (operator direction,
 * 2026-07-08): the hero score is now heavy + large ("Webflow-AEO" scale).
 *
 * A preview target M19 will match, not the frozen moment component; it reuses
 * the frozen reduced-motion gate so it behaves consistently with the system.
 */

import * as React from "react";
import { useReducedMotion } from "@/components/moments";
import { cn } from "@/lib/theme/utils";

export type GaugeTone = "surface" | "onAccent" | "hero";
export type GaugeSize = "md" | "lg";

export interface VisibilityGaugeProps {
  /** Resolved score, 0–100. */
  score: number;
  label?: string;
  caption?: string;
  /** Remount key surface: change it (e.g. a "replay" counter) to re-run. */
  replayKey?: number;
  /** "surface" = quiet card (default); "onAccent" = solid accent fill; "hero" = mode-aware glow hero. */
  tone?: GaugeTone;
  /** "lg" enlarges the arc + number for the hero. */
  size?: GaugeSize;
  /** Start delay in ms (entrance sequencing); ignored under reduced motion. */
  delay?: number;
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

interface ToneSpec {
  /** Classes setting --gauge-track / --gauge-arc (with dark: overrides where mode-aware). */
  vars: string;
  number: string;
  unit: string;
  label: string;
  caption: string;
}

const TONE: Record<GaugeTone, ToneSpec> = {
  surface: {
    vars: "[--gauge-track:color-mix(in_oklab,var(--ink)_10%,transparent)] [--gauge-arc:var(--accent)]",
    number: "text-ink",
    unit: "text-muted",
    label: "text-muted",
    caption: "text-muted",
  },
  onAccent: {
    vars: "[--gauge-track:color-mix(in_oklab,var(--accent-foreground)_26%,transparent)] [--gauge-arc:var(--accent-foreground)]",
    number: "text-accent-foreground",
    unit: "text-accent-foreground/75",
    label: "text-accent-foreground/70",
    caption: "text-accent-foreground/85",
  },
  // Mode-aware hero: onAccent treatment on the light bubble; accent-on-navy
  // treatment on the dark bubble. Pure token derivations on both sides.
  hero: {
    vars:
      "[--gauge-track:color-mix(in_oklab,var(--accent-foreground)_26%,transparent)] [--gauge-arc:var(--accent-foreground)] " +
      "dark:[--gauge-track:color-mix(in_oklab,var(--ink)_12%,transparent)] dark:[--gauge-arc:var(--accent)]",
    number: "text-accent-foreground dark:text-ink",
    unit: "text-accent-foreground/75 dark:text-muted",
    label: "text-accent-foreground/70 dark:text-muted",
    caption: "text-accent-foreground/85 dark:text-muted",
  },
};

const SIZE: Record<GaugeSize, { svg: string; number: string; stroke: number }> = {
  md: { svg: "w-[248px]", number: "text-score", stroke: 14 },
  lg: { svg: "w-[288px] sm:w-[312px]", number: "text-score sm:text-[6rem]", stroke: 15 },
};

export function VisibilityGauge({
  score,
  label = "Visibility score",
  caption,
  replayKey = 0,
  tone = "surface",
  size = "md",
  delay = 0,
  className,
}: VisibilityGaugeProps) {
  const target = Math.round(Math.min(100, Math.max(0, score)));
  return (
    <GaugePass
      key={`${target}:${replayKey}`}
      target={target}
      label={label}
      caption={caption}
      tone={tone}
      size={size}
      delay={delay}
      className={className}
    />
  );
}

function GaugePass({
  target,
  label,
  caption,
  tone,
  size,
  delay,
  className,
}: {
  target: number;
  label: string;
  caption?: string;
  tone: GaugeTone;
  size: GaugeSize;
  delay: number;
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
    // Entrance sequencing: the resolve starts after the hero has landed.
    const start = performance.now() + Math.max(0, delay);
    // Ease-out cubic — decisive then settling, like a value resolving.
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / DURATION));
      setShown(Math.round(target * ease(t)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced, target, delay]);

  const display = reduced ? target : shown;
  const pct = display / 100;
  const spec = TONE[tone];
  const dims = SIZE[size];

  return (
    <div className={cn("relative flex flex-col items-center", spec.vars, className)}>
      <div className="relative">
        <svg
          viewBox="0 0 220 210"
          className={cn(dims.svg, "max-w-full")}
          role="img"
          aria-label={`${label}: ${target} out of 100`}
        >
          <path
            d={TRACK}
            fill="none"
            style={{ stroke: "var(--gauge-track)" }}
            strokeWidth={dims.stroke}
            strokeLinecap="round"
          />
          <path
            d={TRACK}
            fill="none"
            style={{
              stroke: "var(--gauge-arc)",
              transition: reduced ? undefined : "stroke-dashoffset 90ms linear",
            }}
            strokeWidth={dims.stroke}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray="100"
            strokeDashoffset={100 - pct * 100}
          />
        </svg>

        {/* Center readout — big BOLD number over the arc. */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
          <span className="flex items-baseline gap-1">
            <span
              className={cn(
                "font-display leading-none font-bold tabular-nums",
                dims.number,
                spec.number
              )}
            >
              {display}
            </span>
            <span className={cn("font-mono text-sm", spec.unit)}>/100</span>
          </span>
          <span
            className={cn(
              "font-mono text-[10px] tracking-[0.18em] uppercase",
              spec.label
            )}
          >
            {label}
          </span>
        </div>
      </div>

      {caption ? (
        <p
          className={cn(
            "mt-1 text-sm transition-opacity duration-500",
            spec.caption,
            display >= target ? "opacity-100" : "opacity-0"
          )}
        >
          {caption}
        </p>
      ) : null}
    </div>
  );
}
